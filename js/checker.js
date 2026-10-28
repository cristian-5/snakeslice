
// ==== Type rules (shared by the checker and the interpreter) =================
// Types: "bool", "int", "float", "str", "None". null = statically unknown.

class TypeRules {

	static isNumber(t) { return t === "bool" || t === "int" || t === "float"; }
	static isIntegral(t) { return t === "bool" || t === "int"; }
	static common(l, r) { return l === "float" || r === "float" ? "float" : "int"; }

	static canConvert(from, to) {
		if (to === "any" || from === to) return true;
		if (from === "bool") return to === "int" || to === "float";
		if (from === "int") return to === "float";
		return false;
	}

	static rank(from, to) {
		if (from === to) return 0;
		if (to === "any") return 3;
		return from === "bool" && to === "int" ? 1 : 2;
	}

	static paramType(f, i) { return i < f.args.length ? f.args[i] : f.rest; }
	static arityOk(f, n) { return f.rest ? n >= f.args.length : n === f.args.length; }

	static accepts(f, types) {
		return TypeRules.arityOk(f, types.length) &&
			types.every((t, i) => TypeRules.canConvert(t, TypeRules.paramType(f, i)));
	}

	/// Best overload for the given argument types (or undefined)
	static pick(overloads, types) {
		let best, bestScore = Infinity;
		for (const f of overloads) {
			if (!TypeRules.accepts(f, types)) continue;
			const score = types.reduce((s, t, i) => s + TypeRules.rank(t, TypeRules.paramType(f, i)), 0);
			if (score < bestScore) { best = f; bestScore = score; }
		}
		return best;
	}

	/// Rule for a binary arithmetic operator: { type: result type or null, operand: type to convert to or null }
	static infix(op, l, r) {
		const num = TypeRules.isNumber(l) && TypeRules.isNumber(r), c = num ? TypeRules.common(l, r) : null;
		switch (op) {
			case "+":
				if (l === "str" && r === "str") return { type: "str", operand: null };
				if (l === "list" && r === "list") return { type: "list", operand: null };
				return num ? { type: c, operand: c } : null;
			case "-": return num ? { type: c, operand: c } : null;
			case "*":
				if ((l === "str" && TypeRules.isIntegral(r)) || (TypeRules.isIntegral(l) && r === "str"))
					return { type: "str", operand: null };
				if ((l === "list" && TypeRules.isIntegral(r)) || (TypeRules.isIntegral(l) && r === "list"))
					return { type: "list", operand: null };
				return num ? { type: c, operand: c } : null;
			case "/": return num ? { type: "float", operand: "float" } : null;
			case "//": case "%": return num ? { type: c, operand: c } : null;
			case "**":
				if (!num) return null;
				return c === "int" ? { type: null, operand: "int" } : { type: "float", operand: "float" };
		}
		return null;
	}

	/// Rule for comparisons: { operand } or null when unsupported
	static compare(op, l, r) {
		const num = TypeRules.isNumber(l) && TypeRules.isNumber(r);
		switch (op) {
			case "==": case "!=": return { operand: num ? TypeRules.common(l, r) : null };
			case "is": case "is not": return { operand: null };
			case "<": case ">": case "<=": case ">=":
				if (num) return { operand: TypeRules.common(l, r) };
				return l === "str" && r === "str" ? { operand: null } : null;
			case "in": case "not in": return (l === "str" && r === "str") || r === "list" ? { operand: null } : null;
		}
		return null;
	}

	static prefix(op, t) {
		if (!TypeRules.isNumber(t)) return null;
		const o = t === "float" ? "float" : "int";
		return { type: o, operand: o };
	}

}

// ==== Static symbols =========================================================

class VarInfo { // a variable (its static type is unknown unless it's a module constant)
	constructor(type = null, canBeFunction = false) { this.type = type; this.canBeFunction = canBeFunction; }
}

class UserFunc { // a function defined once with def
	constructor(node) {
		this.name = node.name.lexeme;
		this.min = node.params.filter(p => !p.default).length;
		this.max = node.params.length;
	}
}

class FuncInfo { // native functions sharing one name
	constructor(name) { this.name = name; this.overloads = []; }
}

class SymbolScope {

	constructor(parent) {
		this.parent = parent;
		this.values = new Map();
		this.namespaces = new Map();
		this.aliases = new Map();
		this.usings = [];
	}

	static createBuiltins() {
		const scope = new SymbolScope();
		for (const f of Library.functions([])) SymbolScope.#native(scope, f);
		scope.values.set("__name__", new VarInfo("str"));
		return scope;
	}

	static createModule(name) {
		const scope = new SymbolScope(), entry = Library.entry(name);
		for (const fn in entry.functions)
			for (const f of entry.functions[fn]) SymbolScope.#native(scope, { name: fn, ...f });
		for (const c in entry.constants) scope.values.set(c, new VarInfo(entry.constants[c].type));
		return scope;
	}

	static #native(scope, f) {
		let info = scope.values.get(f.name);
		if (!info) scope.values.set(f.name, info = new FuncInfo(f.name));
		info.overloads.push(f);
	}

	_owner(name) {
		if (this.values.has(name)) return this;
		if (this.aliases.has(name)) return this.aliases.get(name);
		for (const u of this.usings) if (u.values.has(name)) return u;
		return this.parent?._owner(name);
	}

	_namespace(name) { return this.namespaces.get(name) ?? this.parent?._namespace(name); }

	has(name) { return this._owner(name) !== undefined; }

	findNamespace(tokens) {
		const errors = Language.main.errors;
		let ns;
		for (const t of tokens) {
			ns = ns ? ns.namespaces.get(t.lexeme) : this._namespace(t.lexeme);
			if (!ns) {
				if (t === tokens[0] && this._owner(t.lexeme)) throw new CodeError(errors.ATT, t, [ t.lexeme ]);
				throw new CodeError(errors.UNS, t, [ t.lexeme, t.lexeme ]);
			}
		}
		return ns;
	}

	/// Symbol (VarInfo | UserFunc | FuncInfo) for a name, or a CodeError
	resolve(token) {
		const errors = Language.main.errors;
		if (token.qualifiers) {
			const ns = this.findNamespace(token.qualifiers);
			if (!ns.values.has(token.member)) throw new CodeError(errors.UVR, token, [ token.lexeme ]);
			return ns.values.get(token.member);
		}
		const owner = this._owner(token.lexeme);
		if (owner) return owner.values.get(token.lexeme);
		const header = Library.headerOf(token.lexeme);
		if (header) throw new CodeError(errors.NIH, token, [ token.lexeme, header ]);
		throw new CodeError(errors.UVR, token, [ token.lexeme ]);
	}

}

// ==== Helpers to inspect statements ==========================================

/// Visits every statement of a body, going into if/while/for but not into def.
function walk(statements, visit) {
	for (const s of statements) {
		visit(s);
		if (s instanceof If) {
			walk(s.then.statements, visit);
			if (s.els instanceof If) walk([ s.els ], visit);
			else if (s.els) walk(s.els.statements, visit);
		} else if (s instanceof While || s instanceof ForRange || s instanceof ForIn)
			walk(s.block.statements, visit);
	}
}

/// Name tokens bound by a statement
function boundNames(s) {
	if (s instanceof Assignment || s instanceof MultiAssignment)
		return s.targets.filter(t => t instanceof Identifier).map(t => t.name);
	if (s instanceof AugAssignment) return s.target instanceof Identifier ? [ s.target.name ] : [];
	if (s instanceof ForRange || s instanceof ForIn) return [ s.target ];
	if (s instanceof FunctionDefinition) return [ s.name ];
	return [];
}

function globalNames(statements) {
	const names = new Set();
	walk(statements, s => { if (s instanceof GlobalDeclaration) s.names.forEach(n => names.add(n.lexeme)); });
	return names;
}

// ==== Type checker ===========================================================
// Resolves names statically, checks operators whose operand types are known,
// function calls, and the placement of return/break/continue. Everything that
// depends on runtime values is checked by the interpreter.

class TypeChecker {

	#global = null;
	#scope = null;
	#function = null;
	#loops = 0;
	#bodies = [];

	check(program) {
		if (program) program.accept(this);
		return program;
	}

	#fail(code, at, params) { throw new CodeError(Language.main.errors[code], at, params); }

	// ---- program ----

	visitProgram(node) {
		this.#global = this.#scope = new SymbolScope(SymbolScope.createBuiltins());
		this.#function = null; this.#loops = 0; this.#bodies = [];
		for (const item of node.items) if (item.hoist) item.hoist(this);
		this.#declare(node.items);
		for (const item of node.items) item.accept(this);
		for (const def of this.#bodies) this.#checkBody(def);
	}

	hoistImport(node) {
		this.#global.namespaces.set((node.alias ?? node.module).lexeme, SymbolScope.createModule(node.module.lexeme));
	}

	hoistFromImport(node) {
		const mod = SymbolScope.createModule(node.module.lexeme);
		if (node.star) { this.#global.usings.push(mod); return; }
		for (const t of node.names) {
			if (!mod.values.has(t.lexeme)) this.#fail("IMN", t, [ t.lexeme, node.module.lexeme ]);
			this.#global.aliases.set(t.lexeme, mod);
		}
	}

	/// All names bound anywhere at module level (also through "global" in functions)
	#declare(items) {
		const bound = new Map();
		const bind = (token, node) => {
			if (!bound.has(token.lexeme)) bound.set(token.lexeme, []);
			bound.get(token.lexeme).push(node);
		};
		walk(items, s => boundNames(s).forEach(t => bind(t, s)));
		for (const item of items) {
			if (!(item instanceof FunctionDefinition)) continue;
			const names = globalNames(item.body.statements);
			walk(item.body.statements, s => boundNames(s).forEach(t => { if (names.has(t.lexeme)) bind(t, s); }));
		}
		for (const [ name, nodes ] of bound)
			this.#global.values.set(name, nodes.length === 1 && nodes[0] instanceof FunctionDefinition ?
				new UserFunc(nodes[0]) : new VarInfo(null, nodes.some(n => n instanceof FunctionDefinition)));
	}

	#checkBody(def) {
		const globals = globalNames(def.body.statements);
		const locals = new Set(def.params.map(p => p.id.lexeme));
		walk(def.body.statements, s => boundNames(s).forEach(t => { if (!globals.has(t.lexeme)) locals.add(t.lexeme); }));
		def.locals = locals; def.globalNames = globals;
		const scope = new SymbolScope(this.#global);
		for (const name of locals) scope.values.set(name, new VarInfo());
		const outer = [ this.#scope, this.#function, this.#loops ];
		[ this.#scope, this.#function, this.#loops ] = [ scope, def, 0 ];
		try { for (const s of def.body.statements) s.accept(this); }
		finally { [ this.#scope, this.#function, this.#loops ] = outer; }
	}

	// ---- statements ----

	visitBlock(node) { for (const s of node.statements) s.accept(this); }
	visitInstruction(node) { node.expression.accept(this); }
	visitPass(node) {}
	visitImport(node) {}
	visitFromImport(node) {}
	visitGlobalDeclaration(node) {}

	visitBreak(node) { if (this.#loops === 0) this.#fail("BNL", [ node.start, node.end ]); }
	visitContinue(node) { if (this.#loops === 0) this.#fail("BNL", [ node.start, node.end ]); }

	visitReturn(node) {
		if (!this.#function) this.#fail("RMO", [ node.start, node.start + 6 ]);
		if (node.expression) node.expression.accept(this);
	}

	visitFunctionDefinition(node) {
		for (const p of node.params) if (p.default) p.default.accept(this);
		this.#bodies.push(node);
	}

	/// a[i] = x: the list and the index must be valid; strings are immutable
	#target(t) {
		if (!(t instanceof Subscript)) return;
		const type = t.left.accept(this);
		if (type === "str") this.#fail("SIM", [ t.start, t.end ]);
		if (type !== null && type !== "list") this.#fail("SNA", [ t.start, t.end ]);
		const it = t.index.accept(this);
		if (it !== null && !TypeRules.isIntegral(it)) this.#fail("IST", [ t.index.start, t.index.end ], [ it ]);
	}

	visitAssignment(node) { node.value.accept(this); node.targets.forEach(t => this.#target(t)); }
	visitMultiAssignment(node) { for (const v of node.values) v.accept(this); node.targets.forEach(t => this.#target(t)); }
	visitAugAssignment(node) { this.#target(node.target); node.value.accept(this); }

	visitPrint(node) {
		for (const a of node.args) a.accept(this);
		for (const e of [ node.sep, node.endExpr ]) {
			if (!e) continue;
			const t = e.accept(this);
			if (t !== null && t !== "str") this.#fail("SET", [ e.start, e.end ]);
		}
	}

	visitIf(node) {
		node.condition.accept(this);
		node.then.accept(this);
		if (node.els) node.els.accept(this);
	}

	visitWhile(node) {
		node.condition.accept(this);
		this.#loops++;
		try { node.block.accept(this); } finally { this.#loops--; }
	}

	visitForRange(node) {
		for (const a of node.args) {
			const t = a.accept(this);
			if (t !== null && !TypeRules.isIntegral(t)) this.#fail("RAT", [ a.start, a.end ], [ t ]);
		}
		this.#loops++;
		try { node.block.accept(this); } finally { this.#loops--; }
	}

	visitForIn(node) {
		const t = node.iterable.accept(this);
		if (t !== null && t !== "str" && t !== "list") this.#fail("NIT", [ node.iterable.start, node.iterable.end ], [ t ]);
		this.#loops++;
		try { node.block.accept(this); } finally { this.#loops--; }
	}

	// ---- expressions (each returns its static type or null) ----

	visitLiteral(node) { return node.valueType; }

	visitFString(node) {
		for (const p of node.parts) if (p.expression) p.expression.accept(this);
		return node.valueType = "str";
	}

	visitIdentifier(node) {
		const info = this.#scope.resolve(node.name);
		if (!(info instanceof VarInfo)) this.#fail("FNV", node.name, [ node.name.lexeme ]);
		return node.valueType = info.type;
	}

	visitInfixExpression(node) {
		const op = node.operator.lexeme;
		const l = node.left.accept(this), r = node.right.accept(this);
		if (op === "and" || op === "or") return node.valueType = l !== null && l === r ? l : null;
		if (l === null || r === null) return node.valueType = null;
		const rule = TypeRules.infix(op, l, r);
		if (!rule) this.#fail("UOB", node.operator, [ op, l, r ]);
		return node.valueType = rule.type;
	}

	visitPrefixExpression(node) {
		const op = node.operator.lexeme, t = node.right.accept(this);
		if (op === "not") return node.valueType = "bool";
		if (t === null) return node.valueType = null;
		const rule = TypeRules.prefix(op, t);
		if (!rule) this.#fail("UPO", node.operator, [ op, t ]);
		return node.valueType = rule.type;
	}

	visitComparison(node) {
		let l = node.first.accept(this);
		for (const { operator, right } of node.rest) {
			const r = right.accept(this);
			if (l !== null && r !== null && !TypeRules.compare(operator.lexeme, l, r))
				this.#fail("UOB", operator, [ operator.lexeme, l, r ]);
			l = r;
		}
		return node.valueType = "bool";
	}

	visitConditional(node) {
		node.test.accept(this);
		const a = node.then.accept(this), b = node.els.accept(this);
		return node.valueType = a !== null && a === b ? a : null;
	}

	visitInput(node) {
		if (node.promptExpr) node.promptExpr.accept(this);
		return node.valueType = "str";
	}

	visitSubscript(node) {
		const t = node.left.accept(this);
		if (t !== null && t !== "str" && t !== "list") this.#fail("SNA", [ node.start, node.end ]);
		const parts = node.slice ? [ node.slice.start, node.slice.stop, node.slice.step ] : [ node.index ];
		for (const p of parts) {
			if (!p) continue;
			const pt = p.accept(this);
			if (pt !== null && !TypeRules.isIntegral(pt)) this.#fail("IST", [ p.start, p.end ], [ pt ]);
		}
		return node.valueType = node.slice ? t : t === "str" ? "str" : null;
	}

	visitListLiteral(node) {
		for (const i of node.items) i.accept(this);
		return node.valueType = "list";
	}

	visitListComprehension(node) {
		const t = node.iterable.accept(this);
		if (t !== null && t !== "str" && t !== "list") this.#fail("NIT", [ node.iterable.start, node.iterable.end ], [ t ]);
		const outer = this.#scope;
		this.#scope = new SymbolScope(outer);
		this.#scope.values.set(node.target.lexeme, new VarInfo(t === "str" ? "str" : null));
		try {
			node.element.accept(this);
			if (node.condition) node.condition.accept(this);
		} finally { this.#scope = outer; }
		return node.valueType = "list";
	}

	visitRangeExpr(node) {
		for (const a of node.args) {
			const t = a.accept(this);
			if (t !== null && !TypeRules.isIntegral(t)) this.#fail("RAT", [ a.start, a.end ], [ t ]);
		}
		return node.valueType = "list";
	}

	visitMethodCall(node) {
		const name = node.name.lexeme;
		const o = node.object;
		if (o instanceof Identifier && !o.name.qualifiers && Library.has(o.name.lexeme) && !this.#scope.has(o.name.lexeme))
			this.#fail("UNS", o.name, [ o.name.lexeme, o.name.lexeme ]);
		const type = o.accept(this);
		const types = node.args.map(a => a.accept(this));
		const tables = type === null ? [ "str", "list" ].map(t => Library.methods(t)) : [ Library.methods(type) ];
		const overloads = tables.flatMap(t => t?.[name] ?? []);
		if (overloads.length === 0) this.#fail("UMT", node.name, [ type ?? "str/list", name ]);
		const candidates = overloads.filter(f => TypeRules.arityOk(f, types.length));
		if (candidates.length === 0) this.#fail("FNF", [ node.start, node.end ], [ name ]);
		if (type !== null && types.every(t => t !== null)) {
			const f = TypeRules.pick(overloads, types);
			if (!f) this.#fail("FNF", [ node.start, node.end ], [ name ]);
			return node.valueType = f.ret === "value" ? null : f.ret;
		}
		const returns = new Set(candidates.map(f => f.ret === "value" ? null : f.ret));
		return node.valueType = returns.size === 1 ? [ ...returns ][0] : null;
	}

	visitCall(node) {
		if (!(node.callee instanceof Identifier)) this.#fail("UEX", [ node.callee.start, node.callee.end ]);
		const token = node.callee.name;
		const info = this.#scope.resolve(token);
		const types = node.args.map(a => a.accept(this));
		if (info instanceof UserFunc) {
			if (types.length < info.min || types.length > info.max)
				this.#fail("ARG", [ node.start, node.end ],
					[ token.lexeme, info.min === info.max ? info.min : `${info.min}-${info.max}`, types.length ]);
			return node.valueType = null;
		}
		if (info instanceof FuncInfo) {
			const candidates = info.overloads.filter(f => TypeRules.arityOk(f, types.length));
			if (candidates.length === 0) this.#fail("FNF", [ node.start, node.end ], [ token.lexeme ]);
			if (types.every(t => t !== null)) {
				const f = TypeRules.pick(info.overloads, types);
				if (!f) this.#fail("FNF", [ node.start, node.end ], [ token.lexeme ]);
				return node.valueType = f.ret === "value" ? null : f.ret;
			}
			const returns = new Set(candidates.map(f => f.ret === "value" ? null : f.ret));
			return node.valueType = returns.size === 1 ? [ ...returns ][0] : null;
		}
		if (info instanceof VarInfo && !info.canBeFunction) this.#fail("NAF", token, [ token.lexeme ]);
		return node.valueType = null;
	}

}
