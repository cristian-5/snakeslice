
// ==== Settings ===============================================================

/// Recursion limit, protects against infinite recursion.
const MAX_CALL_DEPTH = 2000;

// Evaluates expressions one after the other, never in parallel: function calls
// swap Environment.current, so overlapping evaluations would corrupt it.
async function evalAll(expressions) {
	const values = [];
	for (const e of expressions) values.push(await e.evaluate());
	return values;
}

// ==== Visitor & types ========================================================

/// Base of every node of the tree: accept(visitor) calls visitor.visit<ClassName>(node).
/// The TypeChecker (checker.js) is a visitor.
class Visitable {
	accept(visitor) {
		const visit = visitor[`visit${this.constructor.name}`];
		if (!visit) throw new Error(`${visitor.constructor.name} cannot visit ${this.constructor.name}`);
		return visit.call(visitor, this);
	}
}

/// Name of the type a "type" token stands for (double is an alias of float).
const typeName = token => token.canonical ?? token.lexeme;

/// Native functions and constants (written in JavaScript) brought by an #include.
/// A library file registers its header when it is loaded, see cmath.js:
///
///     Library.register("cmath",
///         { sqrt: [ { args: [ "float" ], ret: "float", run: Math.sqrt } ] },  // functions
///         { PI: { type: "float", value: Math.PI } });                         // constants (optional)
///
/// "#include <cmath>" then defines sqrt and PI, both as std::name and in the global
/// namespace (constants: only global), for the TypeChecker and for the interpreter.
/// Overloads are chosen with the same rules as the functions of the program
/// (including the implicit conversions of the arguments).
/// The header "" is always included, like the keywords of the language (nullptr).
class Library {
	static #headers = new Map(); // header -> { functions: { name: [ { args, ret, run } ] }, constants: { name: { type, value } } }

	static register(header, functions = {}, constants = {}) {
		const entry = Library.#headers.get(header) ?? { functions: {}, constants: {} };
		Object.assign(entry.functions, functions);
		Object.assign(entry.constants, constants);
		Library.#headers.set(header, entry);
	}
	static has(header) { return header !== "" && Library.#headers.has(header); }

	static #implied = new Map(); // header -> the headers it includes by itself

	/// Including `header` also includes the `others`, like in a real standard library
	/// where <iostream> pulls <cstdlib> in. It works through several levels.
	static implies(header, ...others) {
		Library.#implied.set(header, [ ...(Library.#implied.get(header) ?? []), ...others ]);
	}

	/// The header and everything it includes, directly or not.
	static closure(header) {
		const all = new Set(), visit = h => {
			if (all.has(h)) return;
			all.add(h);
			for (const other of Library.#implied.get(h) ?? []) visit(other);
		};
		visit(header);
		return all;
	}

	/// The header that declares a function or a constant: used to say what is missing in
	/// "'sqrt' requires #include <cmath>". Undefined if no header has it.
	static headerOf(name) {
		for (const [ header, { functions, constants } ] of Library.#headers)
			if (header !== "" && (Object.hasOwn(functions, name) || Object.hasOwn(constants, name))) return header;
	}

	static #entries(included) {
		return [ "", ...included ].map(h => Library.#headers.get(h)).filter(Boolean);
	}

	/// All the overloads brought by the included headers: [ { name, args, ret, run } ].
	static functions(included) {
		const list = [];
		for (const { functions } of Library.#entries(included))
			for (const name in functions)
				for (const f of functions[name]) list.push({ name, ...f });
		return list;
	}

	/// All the constants brought by the included headers: [ { name, type, value } ].
	static constants(included) {
		const list = [];
		for (const { constants } of Library.#entries(included))
			for (const name in constants) list.push({ name, ...constants[name] });
		return list;
	}
}

Library.implies("iostream", "cstdlib");
Library.implies("string", "cstdlib");

// ==== Values =================================================================

class Value {
	isConst = false;  // declared with "const" (clone() never copies this)
	constructor(value, type = "int") {
		this.value = value;
		this.type = type;
	}
	get dimensions() {
		if (!Array.isArray(this.value)) return 0;
		let cursor = this.value, dimensions = 1;
		while (Array.isArray(cursor[0])) {
			dimensions++;
			cursor = cursor[0];
		}
		return dimensions;
	}
	get sizes() {
		if (!Array.isArray(this.value)) return [];
		let cursor = this.value, sizes = [ ];
		while (Array.isArray(cursor)) {
			sizes.push(cursor.length);
			cursor = cursor[0];
		}
		return sizes;
	}
	get base() { return this.type.replace(/\[.*\]/, ""); }
	get isArray() { return Array.isArray(this.value); }
	toString() {
		if (this.type === "char") return String.fromCharCode(this.value);
		return this.value.toString();
	}
	clone() { return new Value(structuredClone(this.value), this.type); }
	/// This value converted (implicitly, like in C++) to bool, char, int or float.
	/// The TypeChecker decides where this happens, see Expression.castTo.
	/// An uninitialized value stays uninitialized.
	to(type) {
		if (this.type === type) return this;
		let v = this.value;
		if (v !== undefined) switch (type) {
			case "bool":  v = v !== 0; break;
			case "int":   v = Math.trunc(Number(v)); break;
			case "char":  v = Math.trunc(Number(v)) & 0xFF; break;
			case "float": v = Number(v); break;
		}
		return new Value(v, type);
	}
}

// ==== Functions & namespaces =================================================

/// Thrown by "return" and caught by the function call that is running.
class ReturnException {
	constructor(value, statement) {
		this.value = value;         // Value, or null for a bare "return;"
		this.statement = statement; // the Return statement (for error positions)
	}
}

/// Streams like cout and cin are represented by this class.
/// It is not a Value, so it cannot be used as a variable or function argument.
class StreamSymbol { }

/// Stores all the functions sharing one name (overloads) in one scope.
class FunctionSet {
	constructor(name) {
		this.name = name;
		this.type = this.base = "function"; // used by error messages
		this.overloads = [];
	}
	find(types) {
		return this.overloads.find(f =>
			f.types.length === types.length && f.types.every((t, i) => t === types[i]));
	}
}

class Environment {

	static current = undefined;
	static global = undefined;

	static on_define = (id, data) => {};
	static on_change = (id, data) => {};

	/// "included" are the headers of the program: their native functions are defined.
	static create(included = []) {
		const global = new Environment(undefined, "");
		global.values.set("true",  new Value(true, "bool"));
		global.values.set("false", new Value(false, "bool"));
		const std = new Environment(global, "std");
		std.values.set("endl", new Value("\n", "string"));
		std.values.set("cout", new StreamSymbol());
		std.values.set("cin",  new StreamSymbol());
		global.namespaces.set("std", std);
		for (const f of Library.functions(included))
			for (const scope of [ global, std ])
				scope.defineFunction({ token: { lexeme: f.name, position: 0 }, returnType: f.ret, types: f.args, native: f.run });
		for (const c of Library.constants(included)) { // (a header may repeat a constant, like NULL)
			const value = new Value(c.value, c.type);
			value.isConst = true;
			if (!global.values.has(c.name)) global.values.set(c.name, value);
		}
		Environment.global = Environment.current = global;
	}
	static open() { Environment.current = new Environment(Environment.current); }
	static close() { Environment.current = Environment.current.parent; }

	/// The `name` is only given for namespaces (`""` for global).
	constructor(parent, name) {
		this.parent = parent;
		this.values = new Map();     // variables and functions
		this.namespaces = new Map(); // nested namespaces
		this.aliases = new Map();    // "using std::x;"  (name -> environment owning it)
		this.usings = [];            // "using namespace x;"
		this.isNamespace = name !== undefined;
		this.prefix = name ? (parent ? parent.prefix : "") + name + "::" : "";
	}

	/// Environment holding the unqualified name:
	/// this scope, then the names brought in by "using", then the enclosing scopes.
	#owner(name) {
		if (this.values.has(name)) return this;
		if (this.aliases.has(name)) return this.aliases.get(name);
		for (const u of this.usings) if (u.values.has(name)) return u;
		return this.parent ? this.parent.#owner(name) : undefined;
	}

	#findNamespace(name) {
		if (this.namespaces.has(name)) return this.namespaces.get(name);
		for (const u of this.usings)
			if (u.namespaces.has(name)) return u.namespaces.get(name);
		return this.parent ? this.parent.#findNamespace(name) : undefined;
	}

	/// Resolves a chain of namespace tokens like `a::b`.
	findNamespace(tokens) {
		let ns;
		for (const t of tokens) {
			ns = ns ? ns.namespaces.get(t.lexeme) : this.#findNamespace(t.lexeme);
			if (!ns) throw new CodeError(Language.main.errors.UNS, t, [ t.lexeme ]);
		}
		return ns;
	}

	// Identifiers like `a::b` come from the parser as a single token with
	// "qualifiers" (the namespace tokens) and "member" (the last name).
	static key(token) { return token.qualifiers ? token.member : token.lexeme; }

	#resolve(token) {
		let owner;
		if (token.qualifiers) {
			const ns = this.findNamespace(token.qualifiers);
			if (ns.values.has(token.member)) owner = ns;
		} else owner = this.#owner(token.lexeme);
		if (owner) return owner;
		if (!token.qualifiers &&
			Environment.global.namespaces.get("std").values.has(token.lexeme))
			throw new CodeError(Language.main.errors.NDS, token, [ token.lexeme, token.lexeme ]);
		throw new CodeError(Language.main.errors.UVR, token, [ token.lexeme ]);
	}

	/// Like get() but returns undefined instead of throwing if the name is unknown.
	lookup(token) {
		if (token.qualifiers)
			return this.findNamespace(token.qualifiers).values.get(token.member);
		const owner = this.#owner(token.lexeme);
		return owner && owner.values.get(token.lexeme);
	}

	/// Enforces `cout` / `cin` visibility (`using namespace std;` or `std::`).
	require(token) {
		if (this.lookup(token) === undefined)
			throw new CodeError(Language.main.errors.NDS, token, [ token.lexeme, token.lexeme ]);
	}

	get(token) {
		return this.#resolve(token).values.get(Environment.key(token));
	}

	define(token, value) {
		if (this.values.has(token.lexeme) || this.aliases.has(token.lexeme))
			throw new CodeError(Language.main.errors.VRD, token, [ token.lexeme ]);
		this.values.set(token.lexeme, value);
		// globals and namespace members are shown in the debug view
		if (this.isNamespace && value instanceof Value)
			Environment.on_define(this.prefix + token.lexeme, value);
	}

	// entry: { token, returnType, types, names, body, env } or { types, returnType, native }
	defineFunction(entry) {
		const name = entry.token.lexeme;
		let set = this.values.get(name);
		if (set === undefined) {
			set = new FunctionSet(name);
			this.values.set(name, set);
		} else if (!(set instanceof FunctionSet))
			throw new CodeError(Language.main.errors.VRD, entry.token, [ name ]);
		const existing = set.find(entry.types);
		if (!existing) { set.overloads.push(entry); return; }
		if (existing.native) { // a function of the program replaces a native one
			if (!entry.native) { delete existing.native; Object.assign(existing, entry); }
			return;
		}
		if (existing.returnType !== entry.returnType || (existing.body && entry.body))
			throw new CodeError(Language.main.errors.FRD, entry.token, [ name ]);
		if (entry.body) Object.assign(existing, entry); // definition after a prototype
	}

	assign(token, value) {
		const owner = this.#resolve(token), key = Environment.key(token);
		owner.values.set(key, value);
		if (owner.isNamespace) Environment.on_change(owner.prefix + key, value);
	}

}

class Program extends Visitable {
	// items: top level statements; main: token of "main" (if there is a main function)
	// includes: the headers of the #include lines
	constructor(items, main, includes = new Set()) {
		super();
		this.items = items;
		this.main = main;
		this.includes = includes;
	}
	async execute() {
		Environment.create(this.includes);
		Call.depth = 0;
		try {
			// functions and namespaces are declared first, so that the order of
			// the functions in the file doesn't matter
			for (const item of this.items) if (item.declare) item.declare();
			for (const item of this.items) await item.execute();
			if (this.main) {
				const fn = Environment.global.values.get("main").find([]);
				const at = [ this.main.position, this.main.position + this.main.lexeme.length ];
				if (fn) await Call.invoke(fn, [], at);
			}
		} catch (e) {
			if (!(e instanceof ReturnException)) throw e; // "return;" outside of functions ends the program
		}
	}
}

// ==== Expressions ============================================================

class Expression extends Visitable {
	// filled in by the TypeChecker, the interpreter relies on them:
	valueType = null;   // type of the value: "int", "float", "char", "bool", "string", "void", "int[]"...
	isConstant = false; // made only of literals and const variables (array sizes, case labels)
	castTo = null;      // implicit conversion: the type the value must be converted to, if any
	constructor(start, end) {
		super();
		this.start = start;
		this.end = end;
	}
	/// The value of the expression after the implicit conversion (if there is one).
	/// This is what the parent of the expression uses; execute() is the raw value.
	async evaluate() {
		const value = await this.execute();
		return this.castTo ? value.to(this.castTo) : value;
	}
}

class Assignment extends Expression {
	static #compound = { "+=": "+", "-=": "-", "*=": "*", "/=": "/", "%=": "%" };
	constructor(left, operator, right) {
		super(left.start, right.end);
		this.left = left;
		this.operator = operator;
		this.right = right;
		// "a += b" is evaluated as "a = a + b" (the left side is only assigned once)
		const base = Assignment.#compound[operator.lexeme];
		this.value = base ? new InfixExpression(left, { ...operator, lexeme: base }, right) : right;
	}
	async execute() {
		const right = await this.value.evaluate();
		if (this.left instanceof Subscript) {
			const id = await this.left.execute(right.clone());
			Environment.current.assign(id, Environment.current.get(id)); // notifies the debug view
			return right;
		}
		const value = right.clone();
		Environment.current.assign(this.left.name, value);
		return value;
	}
}

class Literal extends Expression {
	constructor(token, type) {
		super(token.position, token.position + token.lexeme.length);
		this.value = token.lexeme;
		this.decoded = token.value; // escape-decoded content (char/string tokens only)
		this.type = type;
	}
	async execute() {
		switch (this.type) {
			case   "char": return new Value(this.decoded.charCodeAt(0), "char");
			case "string": return new Value(this.decoded, "string");
			case  "float": return new Value(parseFloat(this.value), "float");
			case    "int": return new Value(parseInt(this.value), "int");
			default: throw new CodeError(Language.main.errors.LIT, [ this.start, this.end ], [ this.value ]);
		}
	}
}

class Identifier extends Expression {
	constructor(token) {
		super(token.position, token.position + token.lexeme.length);
		this.name = token;
	}
	async execute() { return Environment.current.get(this.name); }
}

class InfixExpression extends Expression {
	// Which types an operator accepts is decided by the TypeChecker (see TypeRules),
	// the operands are already converted to the same type and valueType is the result.
	static #operations = {
		"+":  (a, b) => a + b,
		"-":  (a, b) => a - b,
		"*":  (a, b) => a * b,
		"/":  (a, b, type) => type === "int" ? Math.trunc(a / b) : a / b,
		"%":  (a, b) => a % b,
		"&":  (a, b) => a & b,
		"|":  (a, b) => a | b,
		"&&": (a, b) => a && b,
		"||": (a, b) => a || b,
		"==": (a, b) => a === b,
		"!=": (a, b) => a !== b,
		">":  (a, b) => a > b,
		"<":  (a, b) => a < b,
		">=": (a, b) => a >= b,
		"<=": (a, b) => a <= b,
	};
	constructor(left, operator, right) {
		super(left.start, right.end);
		this.left = left;
		this.operator = operator;
		this.right = right;
	}
	async execute() {
		const op = this.operator.lexeme;
		const l = await this.left.evaluate();
		if (l.value === undefined)
			throw new CodeError(Language.main.errors.INI, [ this.left.start, this.left.end ]);
		// && and || don't evaluate the right side if the left one decides the result
		if (op === "&&" && !l.value) return new Value(false, "bool");
		if (op === "||" && l.value) return new Value(true, "bool");
		const r = await this.right.evaluate();
		if (r.value === undefined)
			throw new CodeError(Language.main.errors.INI, [ this.right.start, this.right.end ]);
		if ([ '/', '%' ].includes(op) && r.value === 0)
			throw new CodeError(Language.main.errors.DBZ, [ this.right.start, this.right.end ]);
		return new Value(InfixExpression.#operations[op](l.value, r.value, this.valueType), this.valueType);
	}
}

class PrefixExpression extends Expression {
	constructor(operator, right) {
		super(operator.position, right.end);
		this.operator = operator;
		this.right = right;
	}
	/// The value after "++" or "--" (a char wraps around like in C++).
	static step(value, operator, type) {
		const result = operator === "++" ? value + 1 : value - 1;
		return type === "char" ? result & 0xFF : result;
	}
	/// Stores the new value of the operand of "++" / "--".
	static async store(target, value) {
		if (target instanceof Subscript) {
			const id = await target.execute(value);
			Environment.current.assign(id, Environment.current.get(id)); // notifies the debug view
		} else Environment.current.assign(target.name, value);
	}
	async execute() {
		const op = this.operator.lexeme;
		const r = await this.right.evaluate();
		if (r.value === undefined)
			throw new CodeError(Language.main.errors.INI, [ this.right.start, this.right.end ]);
		switch (op) {
			case "-": return new Value(-r.value, this.valueType);
			case "+": return new Value(+r.value, this.valueType);
			case "!": return new Value(!r.value, this.valueType);
			case "~": return new Value(~r.value, this.valueType);
		}
		const value = new Value(PrefixExpression.step(r.value, op, this.valueType), this.valueType);
		await PrefixExpression.store(this.right, value);
		return value;
	}
}

class PostfixExpression extends Expression {
	constructor(left, operator) {
		super(left.start, operator.position + operator.lexeme.length);
		this.left = left;
		this.operator = operator;
	}
	async execute() {
		const l = await this.left.evaluate();
		if (l.value === undefined)
			throw new CodeError(Language.main.errors.INI, [ this.left.start, this.left.end ]);
		const result = l.clone(); // the old value is the result
		const value = new Value(PrefixExpression.step(l.value, this.operator.lexeme, this.valueType), this.valueType);
		await PrefixExpression.store(this.left, value);
		return result;
	}
}

/// Explicit conversion: (int)x or int(x). Which conversions exist is checked by
/// the TypeChecker, they are the same as the implicit ones (see Value.to).
class Cast extends Expression {
	constructor(type, expression, start, end) {
		super(start, end);
		this.type = type;
		this.typeName = typeName(type);
		this.expression = expression;
	}
	async execute() {
		const value = await this.expression.evaluate();
		return value.type === this.typeName ? value.clone() : value.to(this.typeName);
	}
}

class Call extends Expression {
	static depth = 0; // current depth of function calls


	// filled in by the TypeChecker:
	signature = null; // parameter types of the overload being called (the arguments are converted to them)

	constructor(callee, lpar, rpar, args) {
		super(callee.start, rpar.position + 1);
		this.callee = callee;
		this.lpar = lpar;
		this.rpar = rpar;
		this.args = args;
	}

	/// Runs a function, parameters are passed by value.
	/// "at" is the [ start, end ] range used to report errors.
	static async invoke(fn, args, at) {
		if (fn.native) return new Value(fn.native(...args.map(a => a.value)), fn.returnType);
		if (!fn.body) throw new CodeError(Language.main.errors.FND, at, [ fn.token.lexeme ]);
		if (Call.depth >= MAX_CALL_DEPTH) throw new CodeError(Language.main.errors.MCD, at);
		const caller = Environment.current;
		const env = new Environment(fn.env); // sees the globals / its namespace, not the caller
		fn.names.forEach((name, i) => env.define(name, args[i].clone()));
		Environment.current = env;
		Call.depth++;
		let returned = null;
		try {
			// the body runs directly in the parameters' scope, like in C++
			for (const s of fn.body.statements) await s.execute();
		} catch (e) {
			if (e instanceof ReturnException) returned = e;
			else if (e instanceof BreakException || e instanceof ContinueException)
				throw new CodeError(Language.main.errors.BNL, [ e.statement.start, e.statement.end ]);
			else throw e;
		} finally {
			Call.depth--;
			Environment.current = caller;
		}
		// (what a function may return was checked by the TypeChecker)
		if (returned) return returned.value ? returned.value.clone() : new Value(undefined, "void");
		return new Value(undefined, fn.returnType); // the end was reached without "return"
	}

	async execute() {
		const token = this.callee.name, at = [ this.start, this.end ];
		const args = await evalAll(this.args); // already converted to the parameter types
		const fn = Environment.current.lookup(token).find(this.signature);
		if (fn.native) args.forEach((a, i) => {
			if (a.value === undefined)
				throw new CodeError(Language.main.errors.INI, [ this.args[i].start, this.args[i].end ]);
		});
		return await Call.invoke(fn, args, at);
	}
}

class Subscript extends Expression {
	constructor(left, indexes, rpar) {
		super(left.start, rpar.position + 1);
		this.left = left;
		this.indexes = indexes;
	}
	/// Reads the element, or writes the Value "set" in it (and returns the name of the array).
	async execute(set) {
		const id = Environment.current.get(this.left.name);
		const indexes = await evalAll(this.indexes);
		for (let i = 0; i < indexes.length; i++)
			if (indexes[i].value < 0 || indexes[i].value >= id.sizes[i])
				throw new CodeError(Language.main.errors.IOB, [ this.indexes[i].start, this.indexes[i].end ], [ indexes[i].value ]);
		if (set) {
			let cursor = id.value;
			for (let i = 0; i < indexes.length - 1; i++) cursor = cursor[indexes[i].value];
			cursor[indexes.top().value] = set.value;
			return this.left.name;
		}
		let cursor = id.value;
		for (const i of indexes) cursor = cursor[i.value];
		return new Value(structuredClone(cursor), id.base);
	}
}

// ==== Statements =============================================================

class Statement extends Visitable {
	constructor(start, end) {
		super();
		this.start = start;
		this.end = end;
	}
}

class Declaration extends Statement {
	isDeclaration = true;
	// constToken: the "const" keyword token, or null
	constructor(type, declarations, constToken = null) {
		const last = declarations.top();
		super((constToken || type).position, last.exp ? last.exp.end : (
			last.sizes ? last.end : last.id.position + last.id.lexeme.length
		));
		this.type = type;
		this.typeName = typeName(type);
		this.declarations = declarations;
		this.isConst = !!constToken;
	}
	async execute() {
		for (const d of this.declarations) {
			let value;
			if (d.exp) { // assignment
				value = (await d.exp.evaluate()).clone(); // own copy, never share another variable's Value
				if (this.isConst) value.isConst = true;
			} else if (d.sizes) { // array
				const sizes = await evalAll(d.sizes);
				for (let i = 0; i < sizes.length; i++)
					if (sizes[i].value <= 0)
						throw new CodeError(Language.main.errors.AS0, [ d.sizes[i].start, d.sizes[i].end ], [ sizes[i].value ]);
				value = new Value(
					Array.make(sizes.map(s => s.value)),
					this.typeName + sizes.map(s => `[${s.value}]`).join("")
				);
			} else { // simple declaration
				value = new Value(undefined, this.typeName);
			}
			Environment.current.define(d.id, value);
		}
	}
}

class Block extends Statement {
	constructor(lbrace, statements, rbrace) {
		super(lbrace.position, rbrace.position + 1);
		this.lbrace = lbrace;
		this.rbrace = rbrace;
		this.statements = statements;
	}
	async execute() {
		Environment.open();
		try { for (const s of this.statements) await s.execute(); }
		finally { Environment.close(); }
	}
}

class Instruction extends Statement {
	constructor(expression) {
		super(expression.start, expression.end);
		this.expression = expression;
	}
	async execute() { await this.expression.execute(); }
}

class If extends Statement {
	constructor(keyword, condition, then, els) {
		super(keyword.position, els ? els.end : then.end);
		this.condition = condition;
		this.then = then;
		this.els = els;
	}
	async execute() {
		const condition = await this.condition.evaluate();
		if (condition.value) await this.then.execute();
		else if (this.els) await this.els.execute();
	}

}

const MAX_LOOP_ITERATIONS = 100000;

class While extends Statement {
	constructor(keyword, condition, block) {
		super(keyword.position, block.end);
		this.condition = condition;
		this.block = block;
	}
	async execute() {
		let condition = await this.condition.evaluate();
		let count = 0;
		while (condition.value && count++ < MAX_LOOP_ITERATIONS) {
			try { await this.block.execute(); }
			catch (e) { // "continue" must still reach the update / condition below
				if (e instanceof BreakException) break;
				if (!(e instanceof ContinueException)) throw e;
			}
			condition = await this.condition.evaluate();
		}
		if (count >= MAX_LOOP_ITERATIONS)
			throw new CodeError(Language.main.errors.MLI, [ this.condition.start, this.condition.end ]);
	}
}

class DoWhile extends Statement {
	constructor(keyword, block, condition) {
		super(keyword.position, condition.end);
		this.block = block;
		this.condition = condition;
	}
	async execute() {
		let condition, count = 0;
		do {
			try { await this.block.execute(); }
			catch (e) { // "continue" must still reach the update / condition below
				if (e instanceof BreakException) break;
				if (!(e instanceof ContinueException)) throw e;
			}
			condition = await this.condition.evaluate();
		} while (condition.value && count++ < MAX_LOOP_ITERATIONS);
		if (count >= MAX_LOOP_ITERATIONS)
			throw new CodeError(Language.main.errors.MLI, [ this.condition.start, this.condition.end ]);
	}
}

class For extends Statement {
	constructor(keyword, init, condition, increment, block) {
		super(keyword.position, block.end);
		this.init = init;
		this.condition = condition;
		this.increment = increment;
		this.block = block;
	}
	async execute() {
		Environment.open();
		try { await this.#loop(); }
		finally { Environment.close(); }
	}
	async #loop() {
		if (this.init) await this.init.execute();
		let condition, count = 0;
		if (this.condition) condition = await this.condition.evaluate();
		while ((!this.condition || condition.value) && count++ < MAX_LOOP_ITERATIONS) {
			try { await this.block.execute(); }
			catch (e) { // "continue" must still reach the update / condition below
				if (e instanceof BreakException) break;
				if (!(e instanceof ContinueException)) throw e;
			}
			if (this.increment) await this.increment.execute();
			if (this.condition) condition = await this.condition.evaluate();
		}
		if (count >= MAX_LOOP_ITERATIONS)
			throw new CodeError(Language.main.errors.MLI, [ this.condition.start, this.condition.end ]);
	}

}

/// Markers inside the body of a switch, see Switch.
class CaseLabel extends Statement {
	constructor(keyword, expression, colon) {
		super(keyword.position, colon.position + 1);
		this.expression = expression;
	}
	async execute() { } // only a jump target
}
class DefaultLabel extends Statement {
	constructor(keyword, colon) {
		super(keyword.position, colon.position + 1);
	}
	async execute() { }
}

class Switch extends Statement {
	// body: statements mixed with CaseLabel / DefaultLabel (flat, like in C++)
	constructor(keyword, expression, body, rbrace) {
		super(keyword.position, rbrace.position + 1);
		this.expression = expression;
		this.body = body;
	}
	async execute() {
		const errors = Language.main.errors;
		const value = await this.expression.evaluate();
		if (value.value === undefined)
			throw new CodeError(errors.INI, [ this.expression.start, this.expression.end ]);
		// find where to jump, checking all the labels (not only the matching one)
		// (the types and the constness of the labels were checked by the TypeChecker)
		const seen = new Set();
		let start = -1, fallback = -1;
		for (let i = 0; i < this.body.length; i++) {
			const s = this.body[i];
			if (s instanceof DefaultLabel) { fallback = i; continue; }
			if (!(s instanceof CaseLabel)) continue;
			const e = s.expression, label = await e.evaluate();
			if (seen.has(label.value)) throw new CodeError(errors.DCV, [ e.start, e.end ], [ label.toString() ]);
			seen.add(label.value);
			if (start < 0 && label.value === value.value) start = i;
		}
		if (start < 0) start = fallback;
		if (start < 0) return;
		Environment.open(); // the whole body is one scope
		try {
			for (let i = start; i < this.body.length; i++) await this.body[i].execute(); // falls through
		} catch (e) {
			if (!(e instanceof BreakException)) throw e;
		} finally { Environment.close(); }
	}
}

class BreakException { constructor(statement) { this.statement = statement; } }
class Break extends Statement {
	constructor(keyword) {
		super(keyword.position, keyword.position + keyword.lexeme.length);
		this.keyword = keyword;
	}
	async execute() { throw new BreakException(this); }
}

class ContinueException { constructor(statement) { this.statement = statement; } }
class Continue extends Statement {
	constructor(keyword) {
		super(keyword.position, keyword.position + keyword.lexeme.length);
		this.keyword = keyword;
	}
	async execute() { throw new ContinueException(this); }
}

class Cout extends Statement {
	static print = console.log;
	constructor(c, expressions, qualified) {
		super(expressions[0].start, expressions.top().end);
		this.expressions = expressions;
		this.c = c;
		this.qualified = qualified; // written as std::cout / std::cin
	}
	async execute() {
		for (const e of this.expressions) {
			const data = await e.evaluate();
			if (data.value === undefined)
				throw new CodeError(Language.main.errors.INI, [ e.start, e.end ]);
			Cout.print(data.toString());
		}
	}
}

class Cin extends Statement {
	static prompt = async () => prompt();
	static input_queue = [];
	constructor(c, expressions, qualified) {
		super(expressions[0].start, expressions.top().end);
		this.expressions = expressions;
		this.c = c;
		this.qualified = qualified; // written as std::cout / std::cin
	}
	async execute() {
		for (const e of this.expressions) {
			let value = Cin.input_queue.shift() || await Cin.prompt(), id;
			if (e instanceof Identifier) id = Environment.current.get(e.name);
			else id = await e.execute(); // subscript
			if (Cin.input_queue.length === 0 && id.base !== "string") {
				const chunks = value.split(/[\s\n\r]+/gm);
				if (chunks.length > 1) {
					value = chunks.shift();
					Cin.input_queue.push(...chunks);
				} else value = chunks[0];
			}
			switch (id.base) {
				case "int":
					id.value = parseInt(value);
					if (isNaN(id.value)) throw new CodeError(Language.main.errors.CII, [ e.start, e.end ], [ id.type ]);
				break;
				case "float":
					id.value = parseFloat(value);
					if (isNaN(id.value)) throw new CodeError(Language.main.errors.CII, [ e.start, e.end ], [ id.type ]);
				break;
				case "char":
					id.value = value.charCodeAt(0);
					if (value.length !== 1) throw new CodeError(Language.main.errors.CII, [ e.start, e.end ], [ id.type ]);
				break;
				case "string": id.value = value; break;
				case "bool":
					if (value === "true" || value == 1) id.value = true;
					else if (value === "false" || value == 0) id.value = false;
					else throw new CodeError(Language.main.errors.CII, [ e.start, e.end ], [ id.type ]);
				break;
			}
			if (e instanceof Subscript) {
				id = await e.execute(id);
				const current = Environment.current.get(id);
				Environment.current.assign(id, current);
			} else Environment.current.assign(e.name, id); // just to notify change
		}
	}
}

// ==== Functions, namespaces ==================================================

// "isDeclaration" marks what is allowed outside of functions once there is a main().
// "declare()" is the first pass of Program.execute (see there).

class FunctionDefinition extends Statement {
	isDeclaration = true;
	// body is null for a prototype: int f(int);
	constructor(returnType, name, params, body, end) {
		super(returnType.position, end);
		this.returnType = returnType;
		this.returnTypeName = typeName(returnType);
		this.name = name;
		this.params = params; // [ { type, id } ]
		this.paramTypes = params.map(p => typeName(p.type));
		this.body = body;
	}
	hoist(visitor) { visitor.hoistFunctionDefinition(this); } // like declare(), see TypeChecker
	declare() {
		Environment.current.defineFunction({
			token: this.name,
			returnType: this.returnTypeName,
			types: this.paramTypes,
			names: this.params.map(p => p.id),
			body: this.body,
			env: Environment.current
		});
	}
	async execute() { } // already declared
}

class Return extends Statement {
	constructor(keyword, expression) {
		super(keyword.position, expression ? expression.end : keyword.position + keyword.lexeme.length);
		this.expression = expression;
	}
	async execute() {
		throw new ReturnException(this.expression ? await this.expression.evaluate() : null, this);
	}
}

class NamespaceDeclaration extends Statement {
	isDeclaration = true;
	constructor(keyword, name, items, rbrace) {
		super(keyword.position, rbrace.position + 1);
		this.name = name;
		this.items = items;
	}
	hoist(visitor) { visitor.hoistNamespaceDeclaration(this); } // like declare(), see TypeChecker
	#open() { // namespaces can be reopened: namespace a { } namespace a { }
		const outer = Environment.current, id = this.name.lexeme;
		if (!outer.namespaces.has(id)) outer.namespaces.set(id, new Environment(outer, id));
		return outer.namespaces.get(id);
	}
	declare() {
		const outer = Environment.current;
		Environment.current = this.#open();
		try { for (const item of this.items) if (item.declare) item.declare(); }
		finally { Environment.current = outer; }
	}
	async execute() {
		const outer = Environment.current;
		Environment.current = this.#open();
		try { for (const item of this.items) await item.execute(); }
		finally { Environment.current = outer; }
	}
}

class UsingNamespace extends Statement {
	isDeclaration = true;
	constructor(keyword, path, semicolon) {
		super(keyword.position, semicolon.position + 1);
		this.path = path; // identifier tokens
	}
	async execute() {
		const env = Environment.current, ns = env.findNamespace(this.path);
		if (!env.usings.includes(ns)) env.usings.push(ns);
	}
}

class UsingDeclaration extends Statement {
	isDeclaration = true;
	constructor(keyword, token, semicolon) {
		super(keyword.position, semicolon.position + 1);
		this.token = token; // qualified token
	}
	async execute() {
		const t = this.token, env = Environment.current;
		const ns = env.findNamespace(t.qualifiers);
		if (ns.values.has(t.member)) env.aliases.set(t.member, ns);
		else if (!(ns === Environment.global.namespaces.get("std") && t.member === "string")) // string is a type, see Parser
			throw new CodeError(Language.main.errors.UVR, t, [ t.lexeme ]);
	}
}
