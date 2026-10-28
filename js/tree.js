
// ==== Settings ===============================================================

/// Recursion limit (Python's RecursionError).
const MAX_CALL_DEPTH = 1000;
/// Loop limit, protects against infinite loops.
const MAX_LOOP_ITERATIONS = 100000;

async function evalAll(expressions) {
	const values = [];
	for (const e of expressions) values.push(await e.execute());
	return values;
}

class Visitable {
	accept(visitor) {
		const method = `visit${this.constructor.name}`;
		if (typeof visitor[method] !== "function")
			throw new Error(`${visitor.constructor.name} does not implement ${method}`);
		return visitor[method](this);
	}
}

// ==== Python values ==========================================================
// Raw JS representation: int -> BigInt, float -> Number, bool -> boolean,
// str -> string, None -> null.

const typeOf = v => v === null ? "None" : typeof v === "bigint" ? "int" :
	typeof v === "number" ? "float" : typeof v === "boolean" ? "bool" : "str";

/// Python's repr() of a float (1.0, 1e-05, 1e+16, inf, nan...)
function floatRepr(x) {
	if (Number.isNaN(x)) return "nan";
	if (!Number.isFinite(x)) return x < 0 ? "-inf" : "inf";
	if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
	const [ m, e ] = x.toExponential().split("e");
	const exp = parseInt(e), neg = m[0] === '-', digits = m.replace('-', '').replace('.', '');
	let out;
	if (exp < -4 || exp >= 16)
		out = digits[0] + (digits.length > 1 ? "." + digits.slice(1) : "") +
			"e" + (exp < 0 ? "-" : "+") + String(Math.abs(exp)).padStart(2, "0");
	else if (exp >= 0)
		out = digits.length <= exp + 1 ? digits.padEnd(exp + 1, "0") + ".0" :
			digits.slice(0, exp + 1) + "." + digits.slice(exp + 1);
	else out = "0." + "0".repeat(-exp - 1) + digits;
	return (neg ? "-" : "") + out;
}

/// Python's str()
function pyStr(v) {
	if (v === null) return "None";
	switch (typeof v) {
		case "bigint": return v.toString();
		case "number": return floatRepr(v);
		case "boolean": return v ? "True" : "False";
		default: return v;
	}
}

function isTruthy(v) {
	if (v === null) return false;
	switch (typeof v) {
		case "bigint": return v !== 0n;
		case "number": return v !== 0;
		case "boolean": return v;
		default: return v.length > 0;
	}
}

/// Error thrown by native functions, converted to CodeError by Call.
class NativeError {
	constructor(code, args = []) { this.code = code; this.args = args; }
}

// ==== Format specifiers (f"{x:.2f}") ========================================

function parseFormatSpec(text) {
	const m = /^(?:(.)?([<>^]))?([+\- ])?(0)?(\d+)?(,)?(?:\.(\d+))?([dfFeEsxob%])?$/.exec(text);
	if (!m) return null;
	return {
		text, fill: m[1] ?? " ", align: m[2] ?? null, sign: m[3] ?? "-", zero: !!m[4],
		width: m[5] ? parseInt(m[5]) : 0, comma: !!m[6],
		precision: m[7] !== undefined ? Math.min(parseInt(m[7]), 100) : null, type: m[8] ?? null
	};
}

function formatValue(v, spec) {
	const fail = () => { throw new NativeError("FMT", [ v.type, spec.text ]); };
	const { fill, sign, zero, width, comma, precision, type } = spec;
	const len = s => Array.from(s).length;
	const pad = (s, align) => {
		const n = width - len(s);
		if (n <= 0) return s;
		if (align === "<") return s + fill.repeat(n);
		if (align === "^") return fill.repeat(Math.floor(n / 2)) + s + fill.repeat(n - Math.floor(n / 2));
		return fill.repeat(n) + s;
	};
	if (type === "s" || (type === null && v.type === "str")) {
		if (v.type !== "str") fail();
		let s = v.value;
		if (precision !== null) s = Array.from(s).slice(0, precision).join("");
		return pad(s, spec.align ?? "<");
	}
	if (v.type === "str" || v.type === "None") fail();
	const raw = typeof v.value === "boolean" ? (v.value ? 1n : 0n) : v.value;
	const isFloat = typeof raw === "number";
	let digits, negative;
	const abs = x => x < 0n ? -x : x;
	switch (type) {
		case "d": if (isFloat) fail(); digits = abs(raw).toString(); negative = raw < 0n; break;
		case "x": case "o": case "b":
			if (isFloat) fail();
			digits = abs(raw).toString({ x: 16, o: 8, b: 2 }[type]); negative = raw < 0n; break;
		case "f": case "F": case "e": case "E": case "%": {
			const n = Number(raw);
			negative = n < 0 || Object.is(n, -0);
			const a = Math.abs(n), p = precision ?? 6;
			if (!Number.isFinite(a)) digits = Number.isNaN(a) ? "nan" : "inf";
			else if (type === "e" || type === "E") {
				digits = a.toExponential(p).replace(/e([+-])(\d)$/, "e$10$2");
				if (type === "E") digits = digits.toUpperCase();
			} else if (type === "%") digits = (a * 100).toFixed(p) + "%";
			else digits = a.toFixed(p);
			break;
		}
		default:
			negative = isFloat ? (raw < 0 || Object.is(raw, -0)) : raw < 0n;
			digits = isFloat ? floatRepr(Math.abs(raw)) : abs(raw).toString();
	}
	if (comma) digits = digits.replace(/^\d+/, m => m.replace(/\B(?=(\d{3})+(?!\d))/g, ","));
	const signStr = negative ? "-" : sign === "+" ? "+" : sign === " " ? " " : "";
	if (zero && !spec.align && width > len(signStr + digits))
		return signStr + "0".repeat(width - len(signStr + digits)) + digits;
	return pad(signStr + digits, spec.align ?? ">");
}

class Value {
	constructor(value, type = typeOf(value)) {
		this.value = value;
		this.type = type;
	}

	static none() { return new Value(null, "None"); }

	get base() { return this.type; }
	get truthy() { return isTruthy(this.value); }
	toString() { return pyStr(this.value); }

	/// Implicit conversions (bool -> int -> float) and explicit ones used by natives.
	to(type) {
		if (this.type === type) return this;
		const v = this.value;
		switch (type) {
			case "bool": return new Value(isTruthy(v), "bool");
			case "int": return new Value(typeof v === "number" ? BigInt(Math.trunc(v)) : BigInt(v), "int");
			case "float": return new Value(Number(v), "float");
			case "str": return new Value(pyStr(v), "str");
		}
		return this;
	}
}

// ==== Library of native functions ============================================
// Library.register("math", { sqrt: [ { args: ["float"], ret: "float", run: Math.sqrt } ] },
//                          { pi: { type: "float", value: Math.PI } });
// The header "" holds the builtins (abs, int, len...). "rest" is the type of
// extra variadic arguments. Natives receive raw JS values.

class Library {
	static #modules = new Map();

	static register(header, functions = {}, constants = {}) {
		const entry = Library.#modules.get(header) ?? { functions: {}, constants: {} };
		Object.assign(entry.functions, functions);
		Object.assign(entry.constants, constants);
		Library.#modules.set(header, entry);
	}

	static has(name) { return name !== "" && Library.#modules.has(name); }
	static entry(name) { return Library.#modules.get(name); }

	/// Which module provides this name? (used for "requires import" hints)
	static headerOf(name) {
		for (const [ header, { functions, constants } ] of Library.#modules)
			if (header !== "" && (Object.hasOwn(functions, name) || Object.hasOwn(constants, name)))
				return header;
	}

	static functions(included) {
		const list = [];
		for (const header of [ "", ...included ]) {
			const entry = Library.#modules.get(header);
			if (!entry) continue;
			for (const name in entry.functions)
				for (const f of entry.functions[name]) list.push({ name, ...f });
		}
		return list;
	}
}

class FunctionSet { // native functions sharing one name
	constructor(name) { this.name = name; this.overloads = []; }
}

class PyFunction { // user defined function
	constructor(node, defaults, env) {
		this.name = node.name.lexeme;
		this.params = node.params;
		this.defaults = defaults;
		this.min = node.params.filter(p => !p.default).length;
		this.body = node.body;
		this.locals = node.locals;
		this.globalNames = node.globalNames;
		this.env = env;
	}
}

class BreakException { constructor(statement) { this.statement = statement; } }
class ContinueException { constructor(statement) { this.statement = statement; } }
class ReturnException { constructor(value, statement) { this.value = value; this.statement = statement; } }

// ==== Environment ============================================================
// builtins <- global <- function. Python has no block scope: only the global
// scope and one scope per function call.

class Environment {

	static current = undefined;
	static global = undefined;
	static builtins = undefined;
	static modules = new Map();

	// Only variables of the global scope are notified.
	static on_define = async (id, data) => {};
	static on_change = async (id, data) => {};

	static create() {
		Environment.modules = new Map();
		const builtins = new Environment(undefined);
		for (const f of Library.functions([])) Environment.#native(builtins, f);
		const global = new Environment(builtins);
		global.values.set("__name__", new Value("__main__", "str"));
		Environment.builtins = builtins;
		Environment.global = Environment.current = global;
	}

	static #native(env, f) {
		let set = env.values.get(f.name);
		if (!set) env.values.set(f.name, set = new FunctionSet(f.name));
		set.overloads.push(f);
	}

	/// A module (math, random...) used as a namespace.
	static module(name) {
		if (Environment.modules.has(name)) return Environment.modules.get(name);
		const env = new Environment(undefined), entry = Library.entry(name);
		for (const fn in entry.functions)
			for (const f of entry.functions[fn]) Environment.#native(env, { name: fn, ...f });
		for (const c in entry.constants)
			env.values.set(c, new Value(entry.constants[c].value, entry.constants[c].type));
		Environment.modules.set(name, env);
		return env;
	}

	static key(token) { return token.qualifiers ? token.member : token.lexeme; }

	constructor(parent) {
		this.parent = parent;
		this.values = new Map();
		this.namespaces = new Map(); // import math [as m]
		this.aliases = new Map();    // from math import sqrt
		this.usings = [];            // from math import *
		this.locals = null;          // names local to a function (set by the checker)
		this.globalNames = null;     // names declared "global"
	}

	#owner(name) {
		if (this.values.has(name)) return this;
		if (this.aliases.has(name)) return this.aliases.get(name);
		for (const u of this.usings) if (u.values.has(name)) return u;
		return this.parent?.#owner(name);
	}

	#namespace(name) {
		return this.namespaces.get(name) ?? this.parent?.#namespace(name);
	}

	findNamespace(tokens) {
		let ns;
		for (const t of tokens) {
			ns = ns ? ns.namespaces.get(t.lexeme) : this.#namespace(t.lexeme);
			if (!ns) throw new CodeError(Language.main.errors.UNS, t, [ t.lexeme, t.lexeme ]);
		}
		return ns;
	}

	#resolve(token) {
		const errors = Language.main.errors;
		if (token.qualifiers) {
			const ns = this.findNamespace(token.qualifiers);
			if (ns.values.has(token.member)) return ns;
			throw new CodeError(errors.UVR, token, [ token.lexeme ]);
		}
		const name = token.lexeme;
		if (this.locals?.has(name) && !this.values.has(name))
			throw new CodeError(errors.ULV, token, [ name ]);
		const owner = this.#owner(name);
		if (owner) return owner;
		const header = Library.headerOf(name);
		if (header) throw new CodeError(errors.NIH, token, [ name, header ]);
		throw new CodeError(errors.UVR, token, [ name ]);
	}

	get(token) { return this.#resolve(token).values.get(Environment.key(token)); }

	set(token, value) {
		const name = token.lexeme;
		const target = this.globalNames?.has(name) ? Environment.global : this;
		const had = target.values.get(name);
		target.values.set(name, value);
		if (target === Environment.global && value instanceof Value)
			(had instanceof Value ? Environment.on_change : Environment.on_define)(name, value);
	}

}

// ==== Program and nodes ======================================================

class Program extends Visitable {
	constructor(items) { super(); this.items = items; }
	async execute() {
		Environment.create();
		Call.depth = 0;
		for (const item of this.items) await item.execute();
	}
}

class Statement extends Visitable {
	constructor(start, end) { super(); this.start = start; this.end = end; }
}

class Expression extends Visitable {
	valueType = null; // static type, filled by the TypeChecker when known
	constructor(start, end) { super(); this.start = start; this.end = end; }
}

class Block extends Statement {
	constructor(statements) {
		super(statements[0].start, statements[statements.length - 1].end);
		this.statements = statements;
	}
	async execute() { for (const s of this.statements) await s.execute(); }
}

class Instruction extends Statement {
	constructor(expression) { super(expression.start, expression.end); this.expression = expression; }
	async execute() { await this.expression.execute(); }
}

class Pass extends Statement {
	constructor(keyword) { super(keyword.position, keyword.position + keyword.lexeme.length); }
	async execute() {}
}

class Break extends Statement {
	constructor(keyword) { super(keyword.position, keyword.position + keyword.lexeme.length); }
	async execute() { throw new BreakException(this); }
}

class Continue extends Statement {
	constructor(keyword) { super(keyword.position, keyword.position + keyword.lexeme.length); }
	async execute() { throw new ContinueException(this); }
}

class Return extends Statement {
	constructor(keyword, expression) {
		super(keyword.position, expression ? expression.end : keyword.position + keyword.lexeme.length);
		this.expression = expression;
	}
	async execute() {
		throw new ReturnException(this.expression ? await this.expression.execute() : Value.none(), this);
	}
}

class GlobalDeclaration extends Statement {
	constructor(keyword, names) {
		const last = names[names.length - 1];
		super(keyword.position, last.position + last.lexeme.length);
		this.names = names;
	}
	async execute() {} // handled statically (FunctionDefinition.globalNames)
}

class Import extends Statement {
	constructor(keyword, module, alias) {
		const last = alias ?? module;
		super(keyword.position, last.position + last.lexeme.length);
		this.module = module; this.alias = alias;
	}
	hoist(visitor) { visitor.hoistImport(this); }
	async execute() {
		Environment.current.namespaces.set(
			(this.alias ?? this.module).lexeme, Environment.module(this.module.lexeme));
	}
}

class FromImport extends Statement {
	constructor(keyword, module, names, star, end) {
		super(keyword.position, end);
		this.module = module; this.names = names; this.star = star;
	}
	hoist(visitor) { visitor.hoistFromImport(this); }
	async execute() {
		const env = Environment.current, mod = Environment.module(this.module.lexeme);
		if (this.star) { env.usings.push(mod); return; }
		for (const t of this.names) env.aliases.set(t.lexeme, mod);
	}
}

class FunctionDefinition extends Statement {
	constructor(keyword, name, params, body) {
		super(keyword.position, body.end);
		this.name = name; this.params = params; this.body = body;
		this.locals = null; this.globalNames = null; // set by the TypeChecker
	}
	async execute() {
		const defaults = [];
		for (const p of this.params) defaults.push(p.default ? await p.default.execute() : undefined);
		Environment.current.set(this.name, new PyFunction(this, defaults, Environment.current));
	}
}

class Assignment extends Statement {
	constructor(targets, value) {
		super(targets[0].start, value.end);
		this.targets = targets; this.value = value;
	}
	async execute() {
		const value = await this.value.execute();
		for (const t of this.targets) Environment.current.set(t.name, value);
	}
}

class MultiAssignment extends Statement { // a, b = b, a
	constructor(targets, values) {
		super(targets[0].start, values[values.length - 1].end);
		this.targets = targets; this.values = values;
	}
	async execute() {
		const values = await evalAll(this.values);
		this.targets.forEach((t, i) => Environment.current.set(t.name, values[i]));
	}
}

class AugAssignment extends Statement { // x += 1
	static #compound = { "+=": "+", "-=": "-", "*=": "*", "/=": "/", "//=": "//", "%=": "%", "**=": "**" };
	constructor(target, operator, right) {
		super(target.start, right.end);
		this.target = target; this.operator = operator; this.right = right;
		this.value = new InfixExpression(target,
			{ ...operator, lexeme: AugAssignment.#compound[operator.lexeme] }, right);
	}
	async execute() { Environment.current.set(this.target.name, await this.value.execute()); }
}

class Print extends Statement {
	static write = text => console.log(text);
	constructor(keyword, args, sep, end, rpar) {
		super(keyword.position, rpar.position + 1);
		this.args = args; this.sep = sep; this.endExpr = end;
	}
	async execute() {
		const values = await evalAll(this.args);
		const sep = this.sep ? (await this.sep.execute()).value : " ";
		const end = this.endExpr ? (await this.endExpr.execute()).value : "\n";
		Print.write(values.map(v => v.toString()).join(sep) + end);
	}
}

class If extends Statement {
	constructor(keyword, condition, then, els) {
		super(keyword.position, (els ?? then).end);
		this.condition = condition; this.then = then; this.els = els;
	}
	async execute() {
		if ((await this.condition.execute()).truthy) await this.then.execute();
		else if (this.els) await this.els.execute();
	}
}

class While extends Statement {
	constructor(keyword, condition, block) {
		super(keyword.position, block.end);
		this.condition = condition; this.block = block;
	}
	async execute() {
		let count = 0;
		while ((await this.condition.execute()).truthy) {
			if (++count > MAX_LOOP_ITERATIONS)
				throw new CodeError(Language.main.errors.MLI, [ this.start, this.condition.end ]);
			try { await this.block.execute(); }
			catch (e) {
				if (e instanceof BreakException) break;
				if (!(e instanceof ContinueException)) throw e;
			}
		}
	}
}

class ForRange extends Statement { // for i in range(a, b, c)
	constructor(keyword, target, args, block) {
		super(keyword.position, block.end);
		this.target = target; this.args = args; this.block = block;
	}
	async execute() {
		const errors = Language.main.errors;
		const values = await evalAll(this.args);
		values.forEach((v, i) => {
			if (v.type !== "int" && v.type !== "bool")
				throw new CodeError(errors.RAT, [ this.args[i].start, this.args[i].end ], [ v.type ]);
		});
		const n = values.map(v => v.to("int").value);
		const [ start, stop, step ] = n.length === 1 ? [ 0n, n[0], 1n ] : [ n[0], n[1], n[2] ?? 1n ];
		if (step === 0n) throw new CodeError(errors.RS0, [ this.args[2].start, this.args[2].end ]);
		let count = 0;
		for (let i = start; step > 0n ? i < stop : i > stop; i += step) {
			if (++count > MAX_LOOP_ITERATIONS)
				throw new CodeError(errors.MLI, [ this.start, this.args[this.args.length - 1].end ]);
			Environment.current.set(this.target, new Value(i, "int"));
			try { await this.block.execute(); }
			catch (e) {
				if (e instanceof BreakException) break;
				if (!(e instanceof ContinueException)) throw e;
			}
		}
	}
}

class ForIn extends Statement { // for ch in "text"
	constructor(keyword, target, iterable, block) {
		super(keyword.position, block.end);
		this.target = target; this.iterable = iterable; this.block = block;
	}
	async execute() {
		const it = await this.iterable.execute();
		if (it.type !== "str")
			throw new CodeError(Language.main.errors.NIT, [ this.iterable.start, this.iterable.end ], [ it.type ]);
		let count = 0;
		for (const ch of Array.from(it.value)) {
			if (++count > MAX_LOOP_ITERATIONS)
				throw new CodeError(Language.main.errors.MLI, [ this.start, this.iterable.end ]);
			Environment.current.set(this.target, new Value(ch, "str"));
			try { await this.block.execute(); }
			catch (e) {
				if (e instanceof BreakException) break;
				if (!(e instanceof ContinueException)) throw e;
			}
		}
	}
}

// ==== Expressions ============================================================

class Literal extends Expression {
	constructor(token, type) {
		super(token.position, token.position + token.lexeme.length);
		this.token = token;
		this.valueType = type;
		switch (type) {
			case "int": this.value = new Value(BigInt(token.lexeme), "int"); break;
			case "float": this.value = new Value(parseFloat(token.lexeme), "float"); break;
			case "str": this.value = new Value(token.value, "str"); break;
			case "bool": this.value = new Value(token.lexeme === "True", "bool"); break;
			default: this.value = Value.none();
		}
	}
	async execute() { return this.value; }
}

class FString extends Expression {
	constructor(token, parts) {
		super(token.position, token.position + token.lexeme.length);
		this.parts = parts; // { text } or { expression, spec }
	}
	async execute() {
		let out = "";
		for (const p of this.parts) {
			if (p.text !== undefined) { out += p.text; continue; }
			const v = await p.expression.execute();
			if (!p.spec) { out += v.toString(); continue; }
			try { out += formatValue(v, p.spec); }
			catch (e) {
				if (e instanceof NativeError)
					throw new CodeError(Language.main.errors[e.code], [ p.expression.start, p.expression.end ], e.args);
				throw e;
			}
		}
		return new Value(out, "str");
	}
}

class Identifier extends Expression {
	constructor(name) {
		super(name.position, name.position + name.lexeme.length);
		this.name = name;
	}
	async execute() {
		const v = Environment.current.get(this.name);
		if (!(v instanceof Value))
			throw new CodeError(Language.main.errors.FNV, this.name, [ this.name.lexeme ]);
		return v;
	}
}

class InfixExpression extends Expression {
	constructor(left, operator, right) {
		super(left.start, right.end);
		this.left = left; this.operator = operator; this.right = right;
	}
	async execute() {
		const errors = Language.main.errors, op = this.operator.lexeme;
		const l = await this.left.execute();
		if (op === "and") return l.truthy ? await this.right.execute() : l;
		if (op === "or") return l.truthy ? l : await this.right.execute();
		const r = await this.right.execute();
		const rule = TypeRules.infix(op, l.type, r.type);
		if (!rule) throw new CodeError(errors.UOB, this.operator, [ op, l.type, r.type ]);
		if (rule.operand === null) { // str + str, str * int
			if (op === "+") return new Value(l.value + r.value, "str");
			const [ s, n ] = l.type === "str" ? [ l.value, r.value ] : [ r.value, l.value ];
			const count = Number(n);
			if (count > 0 && s.length * count > 10_000_000) throw new CodeError(errors.OVF, this.operator);
			return new Value(count > 0 ? s.repeat(count) : "", "str");
		}
		const a = l.to(rule.operand).value, b = r.to(rule.operand).value;
		const isInt = rule.operand === "int";
		const zero = isInt ? b === 0n : b === 0;
		if ((op === "/" || op === "//" || op === "%") && zero)
			throw new CodeError(errors.DBZ, [ this.right.start, this.right.end ]);
		switch (op) {
			case "+": return new Value(a + b, rule.operand);
			case "-": return new Value(a - b, rule.operand);
			case "*": return new Value(a * b, rule.operand);
			case "/": return new Value(a / b, "float");
			case "//":
				if (!isInt) return new Value(Math.floor(a / b), "float");
				{ let q = a / b; if (a % b !== 0n && (a < 0n) !== (b < 0n)) q -= 1n; return new Value(q, "int"); }
			case "%":
				if (!isInt) {
					let m = a % b; if (m !== 0 && (m < 0) !== (b < 0)) m += b;
					return new Value(m, "float");
				}
				{ let m = a % b; if (m !== 0n && (m < 0n) !== (b < 0n)) m += b; return new Value(m, "int"); }
			case "**":
				if (isInt) {
					if (b >= 0n) {
						if (b > 4096n && (a > 1n || a < -1n)) throw new CodeError(errors.OVF, this.operator);
						return new Value(a ** b, "int");
					}
					if (a === 0n) throw new CodeError(errors.DBZ, this.operator);
					return new Value(Number(a) ** Number(b), "float");
				}
				if (a === 0 && b < 0) throw new CodeError(errors.DBZ, this.operator);
				const p = a ** b;
				if (Number.isNaN(p) && !Number.isNaN(a) && !Number.isNaN(b))
					throw new CodeError(errors.MDE, this.operator);
				return new Value(p, "float");
		}
	}
}

class PrefixExpression extends Expression {
	constructor(operator, right) {
		super(operator.position, right.end);
		this.operator = operator; this.right = right;
	}
	async execute() {
		const op = this.operator.lexeme, r = await this.right.execute();
		if (op === "not") return new Value(!r.truthy, "bool");
		const rule = TypeRules.prefix(op, r.type);
		if (!rule) throw new CodeError(Language.main.errors.UPO, this.operator, [ op, r.type ]);
		const v = r.to(rule.operand).value;
		return new Value(op === "-" ? -v : v, rule.operand);
	}
}

/// a < b < c, a == b, x in s, x is None... (chained like Python)
class Comparison extends Expression {
	constructor(first, rest) {
		super(first.start, rest[rest.length - 1].right.end);
		this.first = first; this.rest = rest; // rest: [ { operator, right } ]
	}
	static test(operator, l, r) {
		const op = operator.lexeme, rule = TypeRules.compare(op, l.type, r.type);
		if (!rule) throw new CodeError(Language.main.errors.UOB, operator, [ op, l.type, r.type ]);
		let a = l.value, b = r.value;
		if (rule.operand) { a = l.to(rule.operand).value; b = r.to(rule.operand).value; }
		switch (op) {
			case "==": return rule.operand || l.type === r.type ? a === b : false;
			case "!=": return !(rule.operand || l.type === r.type ? a === b : false);
			case "is": return l.type === r.type && a === b;
			case "is not": return !(l.type === r.type && a === b);
			case "<": return a < b;
			case ">": return a > b;
			case "<=": return a <= b;
			case ">=": return a >= b;
			case "in": return b.includes(a);
			case "not in": return !b.includes(a);
		}
	}
	async execute() {
		let l = await this.first.execute();
		for (const { operator, right } of this.rest) {
			const r = await right.execute();
			if (!Comparison.test(operator, l, r)) return new Value(false, "bool");
			l = r;
		}
		return new Value(true, "bool");
	}
}

class Conditional extends Expression { // a if cond else b
	constructor(test, then, els) {
		super(then.start, els.end);
		this.test = test; this.then = then; this.els = els;
	}
	async execute() {
		return (await this.test.execute()).truthy ? await this.then.execute() : await this.els.execute();
	}
}

class Input extends Expression {
	static prompt = async () => window.prompt("input") ?? "";
	constructor(keyword, promptExpr, rpar) {
		super(keyword.position, rpar.position + 1);
		this.promptExpr = promptExpr;
	}
	async execute() {
		if (this.promptExpr) Print.write((await this.promptExpr.execute()).toString());
		return new Value(await Input.prompt(), "str");
	}
}

class Call extends Expression {
	static depth = 0;
	constructor(callee, rpar, args) {
		super(callee.start, rpar.position + 1);
		this.callee = callee; this.args = args;
	}

	static async invoke(fn, args, at) {
		const errors = Language.main.errors;
		if (Call.depth >= MAX_CALL_DEPTH) throw new CodeError(errors.MCD, at);
		const caller = Environment.current, env = new Environment(fn.env);
		env.locals = fn.locals; env.globalNames = fn.globalNames;
		fn.params.forEach((p, i) => env.values.set(p.id.lexeme, args[i]));
		Environment.current = env;
		Call.depth++;
		try {
			for (const s of fn.body.statements) await s.execute();
		} catch (e) {
			if (e instanceof ReturnException) return e.value;
			if (e instanceof BreakException || e instanceof ContinueException)
				throw new CodeError(errors.BNL, [ e.statement.start, e.statement.end ]);
			if ((e instanceof RangeError && /call stack/i.test(e.message)) ||
				/too much recursion/i.test(e?.message ?? "")) throw new CodeError(errors.MCD, at);
			throw e;
		} finally {
			Call.depth--;
			Environment.current = caller;
		}
		return Value.none();
	}

	async execute() {
		const errors = Language.main.errors, token = this.callee.name, at = [ this.start, this.end ];
		const fn = Environment.current.get(token);
		if (fn instanceof Value) throw new CodeError(errors.NAF, token, [ token.lexeme ]);
		const args = await evalAll(this.args);
		if (fn instanceof PyFunction) {
			if (args.length < fn.min || args.length > fn.params.length)
				throw new CodeError(errors.ARG, at, [ token.lexeme,
					fn.min === fn.params.length ? fn.min : `${fn.min}-${fn.params.length}`, args.length ]);
			const full = [ ...args ];
			for (let i = args.length; i < fn.params.length; i++) full.push(fn.defaults[i]);
			return await Call.invoke(fn, full, at);
		}
		const f = TypeRules.pick(fn.overloads, args.map(a => a.type));
		if (!f) throw new CodeError(errors.FNF, at, [ token.lexeme ]);
		const converted = args.map((a, i) => {
			const t = TypeRules.paramType(f, i);
			return t === "any" ? a.value : a.to(t).value;
		});
		try {
			return new Value(f.run(...converted) ?? null, f.ret);
		} catch (e) {
			if (e instanceof NativeError) throw new CodeError(errors[e.code], at, e.args);
			throw e;
		}
	}
}

class Subscript extends Expression { // s[i], s[a:b:c]
	constructor(left, index, slice, rbracket) {
		super(left.start, rbracket.position + 1);
		this.left = left; this.index = index; this.slice = slice; // slice: { start, stop, step }
	}

	static indices(length, start, stop, step) {
		let lo, hi;
		if (step > 0) {
			lo = start ?? 0; hi = stop ?? length;
			lo = lo < 0 ? Math.max(lo + length, 0) : Math.min(lo, length);
			hi = hi < 0 ? Math.max(hi + length, 0) : Math.min(hi, length);
		} else {
			lo = start ?? length - 1; hi = stop ?? -length - 1;
			lo = lo < 0 ? Math.max(lo + length, -1) : Math.min(lo, length - 1);
			hi = hi < 0 ? Math.max(hi + length, -1) : Math.min(hi, length - 1);
		}
		const out = [];
		for (let i = lo; step > 0 ? i < hi : i > hi; i += step) out.push(i);
		return out;
	}

	async #integer(expression) {
		if (!expression) return null;
		const v = await expression.execute();
		if (v.type !== "int" && v.type !== "bool")
			throw new CodeError(Language.main.errors.IST, [ expression.start, expression.end ], [ v.type ]);
		return Number(v.value);
	}

	async execute() {
		const errors = Language.main.errors;
		const s = await this.left.execute();
		if (s.type !== "str") throw new CodeError(errors.SNA, [ this.start, this.end ]);
		const chars = Array.from(s.value);
		if (this.slice) {
			const start = await this.#integer(this.slice.start);
			const stop = await this.#integer(this.slice.stop);
			const step = await this.#integer(this.slice.step) ?? 1;
			if (step === 0) throw new CodeError(errors.ZST, [ this.slice.step.start, this.slice.step.end ]);
			return new Value(Subscript.indices(chars.length, start, stop, step).map(i => chars[i]).join(""), "str");
		}
		let n = await this.#integer(this.index);
		const shown = n;
		if (n < 0) n += chars.length;
		if (n < 0 || n >= chars.length)
			throw new CodeError(errors.IOB, [ this.index.start, this.index.end ], [ shown ]);
		return new Value(chars[n], "str");
	}
}
