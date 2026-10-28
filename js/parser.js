
const digit = c => c >= '0' && c <= '9';
const letter = c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const alpha = c => digit(c) || letter(c);

const escapedChars = {
	'n': '\n', 't': '\t', 'r': '\r', '0': '\0', '\\': '\\', '\'': '\'', '"': '"'
};

const keywords = [
	"if", "elif", "else", "while", "for", "in", "break", "continue", "pass",
	"def", "return", "global", "import", "from", "as",
	"and", "or", "not", "is", "True", "False", "None",
	"print", "input", "range"
];

// Real Python keywords this editor does not support
const unsupported = [
	"class", "try", "except", "finally", "with", "lambda", "del", "assert",
	"nonlocal", "yield", "raise", "async", "await"
];

const tokenNames = {
	NEWLINE: "end of line", INDENT: "indentation", DEDENT: "end of block",
	identifier: "identifier", number: "number", string: "string", operator: "operator", keyword: "keyword"
};

const structural = [ "NEWLINE", "INDENT", "DEDENT" ];

class Parser {

	constructor(code) {
		CodeError.code = this.code = code.replace(/\r/g, "");
		this.tokens = this.#lex();
		this.current = 0;
	}

	async parse() {
		if (this.tokens.length === 0) return;
		this.current = 0;
		return this.#program();
	}

	// ==== Lexer ================================================================

	#lex(from = 0, to = this.code.length, nested = false) {
		const code = this.code, errors = Language.main.errors;
		const tokens = [], indents = [ 0 ];
		let i = from, depth = 0, lineStart = !nested;
		while (i < to) {
			// ---- indentation at the beginning of a logical line ----
			if (lineStart && !nested && depth === 0) {
				const begin = i;
				let width = 0;
				while (i < to && (code[i] === ' ' || code[i] === '\t')) {
					width = code[i] === '\t' ? (Math.floor(width / 4) + 1) * 4 : width + 1;
					i++;
				}
				if (i >= to) break;
				if (code[i] === '\n') { i++; continue; } // blank line
				if (code[i] === '#') { while (i < to && code[i] !== '\n') i++; continue; } // comment line
				lineStart = false;
				const top = indents[indents.length - 1];
				if (width > top) {
					indents.push(width);
					tokens.push({ lexeme: code.substring(begin, i), type: "INDENT", position: begin });
				} else if (width < top) {
					while (width < indents[indents.length - 1]) {
						indents.pop();
						tokens.push({ lexeme: "", type: "DEDENT", position: i });
					}
					if (width !== indents[indents.length - 1]) throw new CodeError(errors.DED, [ begin, i ]);
				}
			}
			const c = code[i];
			if (c === ' ' || c === '\t') { i++; continue; }
			if (c === '\n') {
				i++;
				if (!nested && depth === 0) {
					if (tokens.length && tokens[tokens.length - 1].type !== "NEWLINE")
						tokens.push({ lexeme: "", type: "NEWLINE", position: i - 1 });
					lineStart = true;
				}
				continue;
			}
			if (c === '\\' && code[i + 1] === '\n') { i += 2; continue; }
			if (c === '#' && !nested) { while (i < to && code[i] !== '\n') i++; continue; }
			// ---- numbers ----
			if (digit(c) || (c === '.' && digit(code[i + 1]))) {
				const start = i;
				while (digit(code[i])) i++;
				if (code[i] === '.' && !letter(code[i + 1])) { i++; while (digit(code[i])) i++; }
				if ((code[i] === 'e' || code[i] === 'E') &&
					(digit(code[i + 1]) || ((code[i + 1] === '+' || code[i + 1] === '-') && digit(code[i + 2])))) {
					i += 2;
					while (digit(code[i])) i++;
				}
				tokens.push({ lexeme: code.substring(start, i), type: "number", position: start });
				continue;
			}
			// ---- identifiers, keywords, f-strings ----
			if (letter(c)) {
				const start = i;
				while (i < to && alpha(code[i])) i++;
				const word = code.substring(start, i);
				if ((word === "f" || word === "F") && (code[i] === '"' || code[i] === "'")) {
					i = this.#string(tokens, i, to, true, start);
					continue;
				}
				tokens.push({
					lexeme: word, position: start,
					type: keywords.includes(word) || unsupported.includes(word) ? "keyword" : "identifier"
				});
				continue;
			}
			// ---- strings ----
			if (c === '"' || c === "'") { i = this.#string(tokens, i, to, false, i); continue; }
			// ---- operators ----
			const three = code.substr(i, 3), two = code.substr(i, 2);
			let op = null;
			if (three === "**=" || three === "//=") op = three;
			else if ([ "**", "//", "==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "%=" ].includes(two)) op = two;
			else if ("+-*/%=<>(),:.;[]{}".includes(c)) op = c;
			if (!op) throw new CodeError(errors.UNC, [ i, i + 1 ]);
			if (op === '(') depth++; else if (op === ')' && depth > 0) depth--;
			tokens.push({ lexeme: op, type: "operator", position: i });
			i += op.length;
		}
		if (!nested) {
			if (tokens.length && tokens[tokens.length - 1].type !== "NEWLINE")
				tokens.push({ lexeme: "", type: "NEWLINE", position: to });
			while (indents.length > 1) {
				indents.pop();
				tokens.push({ lexeme: "", type: "DEDENT", position: to });
			}
		}
		return tokens;
	}

	/// Lexes a string (or f-string) starting at the quote, returns the index after it.
	#string(tokens, quoteAt, to, isF, start) {
		const code = this.code, errors = Language.main.errors, quote = code[quoteAt];
		const triple = code.startsWith(quote.repeat(3), quoteAt), open = triple ? 3 : 1;
		const unterminated = () => { throw new CodeError(errors.MTC, [ start, quoteAt + open ], [ quote ]); };
		const parts = [];
		let i = quoteAt + open, text = "";
		for (;;) {
			if (i >= to) unterminated();
			const ch = code[i];
			if (triple ? code.startsWith(quote.repeat(3), i) : ch === quote) { i += open; break; }
			if (ch === '\n' && !triple) unterminated();
			if (ch === '\\') {
				const e = code[i + 1];
				if (e === undefined) unterminated();
				if (e === '\n') { if (!triple) unterminated(); i += 2; continue; }
				if (!Object.hasOwn(escapedChars, e)) throw new CodeError(errors.UES, [ i, i + 2 ]);
				text += escapedChars[e];
				i += 2;
				continue;
			}
			if (isF && ch === '{') {
				if (code[i + 1] === '{') { text += '{'; i += 2; continue; }
				let k = i + 1, d = 0, inQuote = null;
				for (; k < to; k++) {
					const x = code[k];
					if (x === '\n' && !triple) break;
					if (inQuote) { if (x === inQuote) inQuote = null; continue; }
					if (x === '"' || x === "'") inQuote = x;
					else if (x === '(' || x === '[') d++;
					else if (x === ')' || x === ']') d--;
					else if (d === 0 && (x === '}' || x === ':')) break;
				}
				if (k >= to || code[k] === '\n') throw new CodeError(errors.FSU, [ i, i + 1 ]);
				let spec = null, close = k;
				if (code[k] === ':') {
					let m = k + 1;
					while (m < to && code[m] !== '}' && code[m] !== '\n') m++;
					if (code[m] !== '}') throw new CodeError(errors.FSU, [ i, i + 1 ]);
					const specText = code.substring(k + 1, m);
					spec = parseFormatSpec(specText);
					if (!spec) throw new CodeError(errors.FSF, [ k + 1, Math.max(m, k + 2) ], [ specText ]);
					close = m;
				}
				if (code.substring(i + 1, k).trim() === "") throw new CodeError(errors.FSE, [ i, close + 1 ]);
				if (text) { parts.push({ text }); text = ""; }
				parts.push({ tokens: this.#lex(i + 1, k, true), spec });
				i = close + 1;
				continue;
			}
			if (isF && ch === '}') {
				if (code[i + 1] === '}') { text += '}'; i += 2; continue; }
				throw new CodeError(errors.FSB, [ i, i + 1 ]);
			}
			text += ch;
			i++;
		}
		const lexeme = code.substring(start, i);
		if (isF) {
			if (text || parts.length === 0) parts.push({ text });
			tokens.push({ lexeme, type: "fstring", position: start, parts });
		} else tokens.push({ lexeme, value: text, type: "string", position: start });
		return i;
	}

	// ==== Parser helpers =======================================================

	#end() { return this.current >= this.tokens.length; }
	#peek() { return this.tokens[this.current]; }
	#previous() { return this.tokens[this.current - 1]; }
	#advance() { if (!this.#end()) this.current++; return this.#previous(); }

	#check(type, lexeme) {
		if (this.#end()) return false;
		const p = this.#peek();
		if (p.type !== type) return false;
		if (lexeme === undefined) return true;
		return lexeme instanceof Array ? lexeme.includes(p.lexeme) : p.lexeme === lexeme;
	}

	#match(type, lexeme) {
		if (!this.#check(type, lexeme)) return false;
		this.#advance();
		return true;
	}

	/// Where to report "something is missing": right after the last real token
	#after() {
		for (let i = this.current - 1; i >= 0; i--) {
			const t = this.tokens[i];
			if (!structural.includes(t.type)) return [ t.position + t.lexeme.length, t.position + t.lexeme.length + 1 ];
		}
		return [ 0, 1 ];
	}

	/// Where to report an unexpected token
	#here() {
		const t = this.#peek();
		return t && !structural.includes(t.type) ? t : this.#after();
	}

	#consume(type, lexeme) {
		if (this.#check(type, lexeme)) return this.#advance();
		const errors = Language.main.errors, name = tokenNames[type] ?? type;
		if (lexeme === undefined) throw new CodeError(errors.EXT, this.#after(), [ name ]);
		throw new CodeError(errors.EXM, this.#after(), [ name, lexeme ]);
	}

	#fail(code, at, params) { throw new CodeError(Language.main.errors[code], at, params); }

	#isTarget(e) { return e instanceof Identifier && !e.name.qualifiers; }

	#qualify(parts) {
		const last = parts[parts.length - 1];
		if (parts.length === 1) return last;
		return {
			...last, lexeme: parts.map(p => p.lexeme).join("."), position: parts[0].position,
			qualifiers: parts.slice(0, -1), member: last.lexeme
		};
	}

	// ==== Statements ===========================================================

	#program() {
		const items = [];
		while (!this.#end()) {
			if (this.#match("NEWLINE")) continue;
			this.#statement(items, true);
		}
		return new Program(items);
	}

	#statement(out, top) {
		const t = this.#peek();
		if (t.type === "INDENT") this.#fail("IND", t);
		if (t.type === "DEDENT") this.#fail("UEX", this.#here());
		if (t.type === "keyword") {
			switch (t.lexeme) {
				case "if": out.push(this.#if()); return;
				case "while": out.push(this.#while()); return;
				case "for": out.push(this.#for()); return;
				case "def":
					if (!top) this.#fail("NFD", t);
					out.push(this.#def());
					return;
			}
			if (unsupported.includes(t.lexeme)) this.#fail("USK", t, [ t.lexeme ]);
		}
		this.#simpleLine(out, top);
	}

	/// simple_statement (';' simple_statement)* NEWLINE
	#simpleLine(out, top) {
		out.push(this.#simple(top));
		while (this.#match("operator", ";")) {
			if (this.#check("NEWLINE") || this.#end()) break;
			out.push(this.#simple(top));
		}
		if (!this.#end()) this.#consume("NEWLINE");
	}

	/// ':' (NEWLINE INDENT statements DEDENT | simple statements on the same line)
	#suite() {
		const colon = this.#consume("operator", ":");
		const out = [];
		if (this.#match("NEWLINE")) {
			if (!this.#check("INDENT")) this.#fail("EIN", [ colon.position, colon.position + 1 ]);
			this.#advance();
			while (!this.#check("DEDENT") && !this.#end()) {
				if (this.#match("NEWLINE")) continue;
				this.#statement(out, false);
			}
			if (!this.#end()) this.#advance(); // DEDENT
		} else {
			if (this.#end()) this.#fail("EIN", [ colon.position, colon.position + 1 ]);
			this.#simpleLine(out, false);
		}
		return new Block(out);
	}

	#if() {
		const keyword = this.#advance(); // if | elif
		const condition = this.#expression();
		const then = this.#suite();
		let els = null;
		if (this.#check("keyword", "elif")) els = this.#if();
		else if (this.#match("keyword", "else")) els = this.#suite();
		return new If(keyword, condition, then, els);
	}

	#while() {
		const keyword = this.#advance();
		const condition = this.#expression();
		return new While(keyword, condition, this.#suite());
	}

	#for() {
		const keyword = this.#advance();
		const target = this.#consume("identifier");
		this.#consume("keyword", "in");
		if (this.#check("keyword", "range")) {
			this.#advance();
			const lpar = this.#consume("operator", "(");
			const args = [];
			if (!this.#check("operator", ")")) do {
				if (this.#check("operator", ")")) break;
				args.push(this.#expression());
			} while (this.#match("operator", ","));
			const rpar = this.#consume("operator", ")");
			if (args.length < 1 || args.length > 3)
				this.#fail("RNA", [ lpar.position, rpar.position + 1 ], [ args.length ]);
			return new ForRange(keyword, target, args, this.#suite());
		}
		const iterable = this.#expression();
		return new ForIn(keyword, target, iterable, this.#suite());
	}

	#def() {
		const keyword = this.#advance();
		const name = this.#consume("identifier");
		this.#consume("operator", "(");
		const params = [], seen = new Set();
		let hasDefault = false;
		if (!this.#check("operator", ")")) do {
			if (this.#check("operator", ")")) break;
			const id = this.#consume("identifier");
			if (seen.has(id.lexeme)) this.#fail("DPR", id, [ id.lexeme ]);
			seen.add(id.lexeme);
			let value = null;
			if (this.#match("operator", "=")) { value = this.#expression(); hasDefault = true; }
			else if (hasDefault) this.#fail("NDF", id);
			params.push({ id, default: value });
		} while (this.#match("operator", ","));
		this.#consume("operator", ")");
		return new FunctionDefinition(keyword, name, params, this.#suite());
	}

	#simple(top) {
		const t = this.#peek();
		if (t.type === "keyword") {
			switch (t.lexeme) {
				case "pass": return new Pass(this.#advance());
				case "break": return new Break(this.#advance());
				case "continue": return new Continue(this.#advance());
				case "return": {
					const keyword = this.#advance();
					let value = null;
					if (!this.#check("NEWLINE") && !this.#check("operator", ";") && !this.#end())
						value = this.#expression();
					return new Return(keyword, value);
				}
				case "global": {
					const keyword = this.#advance(), names = [ this.#consume("identifier") ];
					while (this.#match("operator", ",")) names.push(this.#consume("identifier"));
					return new GlobalDeclaration(keyword, names);
				}
				case "import": {
					if (!top) this.#fail("IMT", t);
					const keyword = this.#advance(), module = this.#consume("identifier");
					if (!Library.has(module.lexeme)) this.#fail("UHD", module, [ module.lexeme ]);
					const alias = this.#match("keyword", "as") ? this.#consume("identifier") : null;
					return new Import(keyword, module, alias);
				}
				case "from": {
					if (!top) this.#fail("IMT", t);
					const keyword = this.#advance(), module = this.#consume("identifier");
					if (!Library.has(module.lexeme)) this.#fail("UHD", module, [ module.lexeme ]);
					this.#consume("keyword", "import");
					if (this.#match("operator", "*")) {
						const star = this.#previous();
						return new FromImport(keyword, module, [], true, star.position + 1);
					}
					const names = [ this.#consume("identifier") ];
					while (this.#match("operator", ",")) names.push(this.#consume("identifier"));
					const last = names[names.length - 1];
					return new FromImport(keyword, module, names, false, last.position + last.lexeme.length);
				}
				case "print": return this.#print();
			}
		}
		const first = this.#expression();
		if (this.#check("operator", ",")) return this.#multiAssignment(first);
		if (this.#match("operator", "=")) {
			const targets = [ first ];
			let value = this.#expression();
			while (this.#match("operator", "=")) { targets.push(value); value = this.#expression(); }
			targets.forEach(e => this.#checkTarget(e));
			return new Assignment(targets, value);
		}
		if (this.#match("operator", [ "+=", "-=", "*=", "/=", "//=", "%=", "**=" ])) {
			const operator = this.#previous();
			this.#checkTarget(first);
			return new AugAssignment(first, operator, this.#expression());
		}
		return new Instruction(first);
	}

	#checkTarget(e) {
		if (this.#isTarget(e)) return;
		if (e instanceof Subscript) this.#fail("SIM", [ e.start, e.end ]);
		this.#fail("IAT", [ e.start, e.end ]);
	}

	/// a, b = b, a
	#multiAssignment(first) {
		const targets = [ first ];
		while (this.#match("operator", ",")) {
			if (this.#check("operator", "=")) break;
			targets.push(this.#expression());
		}
		this.#consume("operator", "=");
		const values = [ this.#expression() ];
		while (this.#match("operator", ",")) values.push(this.#expression());
		targets.forEach(e => this.#checkTarget(e));
		if (targets.length !== values.length)
			this.#fail("UNP", [ values[0].start, values[values.length - 1].end ], [ values.length, targets.length ]);
		return new MultiAssignment(targets, values);
	}

	#print() {
		const keyword = this.#advance();
		this.#consume("operator", "(");
		const args = [];
		let sep = null, end = null;
		if (!this.#check("operator", ")")) do {
			if (this.#check("operator", ")")) break;
			const next = this.tokens[this.current + 1];
			if (this.#check("identifier") && next && next.type === "operator" && next.lexeme === "=") {
				const name = this.#advance();
				this.#advance();
				const value = this.#expression();
				if (name.lexeme === "sep") sep = value;
				else if (name.lexeme === "end") end = value;
				else this.#fail("UKW", name, [ name.lexeme ]);
			} else args.push(this.#expression());
		} while (this.#match("operator", ","));
		const rpar = this.#consume("operator", ")");
		return new Print(keyword, args, sep, end, rpar);
	}

	// ==== Expressions ==========================================================

	#expression() {
		const then = this.#or();
		if (this.#match("keyword", "if")) {
			const test = this.#or();
			this.#consume("keyword", "else");
			return new Conditional(test, then, this.#expression());
		}
		return then;
	}

	#or() {
		let e = this.#and();
		while (this.#match("keyword", "or")) e = new InfixExpression(e, this.#previous(), this.#and());
		return e;
	}

	#and() {
		let e = this.#not();
		while (this.#match("keyword", "and")) e = new InfixExpression(e, this.#previous(), this.#not());
		return e;
	}

	#not() {
		if (this.#match("keyword", "not")) return new PrefixExpression(this.#previous(), this.#not());
		return this.#comparison();
	}

	#comparison() {
		const first = this.#arith(), rest = [];
		for (;;) {
			let op;
			if (this.#match("operator", [ "==", "!=", "<", ">", "<=", ">=" ])) op = this.#previous();
			else if (this.#match("keyword", "in")) op = this.#previous();
			else if (this.#check("keyword", "not") && this.tokens[this.current + 1]?.lexeme === "in") {
				const t = this.#advance();
				this.#advance();
				op = { lexeme: "not in", type: "keyword", position: t.position };
			} else if (this.#match("keyword", "is")) {
				const t = this.#previous();
				op = this.#match("keyword", "not") ? { lexeme: "is not", type: "keyword", position: t.position } : t;
			} else break;
			rest.push({ operator: op, right: this.#arith() });
		}
		return rest.length ? new Comparison(first, rest) : first;
	}

	#arith() {
		let e = this.#term();
		while (this.#match("operator", [ "+", "-" ])) e = new InfixExpression(e, this.#previous(), this.#term());
		return e;
	}

	#term() {
		let e = this.#factor();
		while (this.#match("operator", [ "*", "/", "//", "%" ]))
			e = new InfixExpression(e, this.#previous(), this.#factor());
		return e;
	}

	#factor() {
		if (this.#match("operator", [ "+", "-" ])) return new PrefixExpression(this.#previous(), this.#factor());
		return this.#power();
	}

	#power() {
		const base = this.#trailer();
		if (this.#match("operator", "**")) return new InfixExpression(base, this.#previous(), this.#factor());
		return base;
	}

	/// calls and subscripts
	#trailer() {
		let e = this.#primary();
		for (;;) {
			if (this.#match("operator", "(")) {
				const args = [];
				if (!this.#check("operator", ")")) do {
					if (this.#check("operator", ")")) break;
					const next = this.tokens[this.current + 1];
					if (this.#check("identifier") && next && next.type === "operator" && next.lexeme === "=")
						this.#fail("KWA", this.#peek());
					args.push(this.#expression());
				} while (this.#match("operator", ","));
				e = new Call(e, this.#consume("operator", ")"), args);
			} else if (this.#match("operator", "[")) {
				let start = null, stop = null, step = null, isSlice = false;
				if (!this.#check("operator", ":")) start = this.#expression();
				if (this.#match("operator", ":")) {
					isSlice = true;
					if (!this.#check("operator", ":") && !this.#check("operator", "]")) stop = this.#expression();
					if (this.#match("operator", ":") && !this.#check("operator", "]")) step = this.#expression();
				}
				const rbracket = this.#consume("operator", "]");
				e = new Subscript(e, isSlice ? null : start, isSlice ? { start, stop, step } : null, rbracket);
			} else break;
		}
		return e;
	}

	#primary() {
		const t = this.#peek();
		if (!t || structural.includes(t.type)) this.#fail("UEX", this.#here());
		switch (t.type) {
			case "number":
				this.#advance();
				return new Literal(t, /[.eE]/.test(t.lexeme) ? "float" : "int");
			case "string": return new Literal(this.#advance(), "str");
			case "fstring": return this.#fstring(this.#advance());
			case "identifier": {
				const parts = [ this.#advance() ];
				while (this.#match("operator", ".")) parts.push(this.#consume("identifier"));
				return new Identifier(this.#qualify(parts));
			}
			case "keyword":
				switch (t.lexeme) {
					case "True": case "False": return new Literal(this.#advance(), "bool");
					case "None": return new Literal(this.#advance(), "None");
					case "input": {
						const keyword = this.#advance();
						this.#consume("operator", "(");
						const prompt = this.#check("operator", ")") ? null : this.#expression();
						return new Input(keyword, prompt, this.#consume("operator", ")"));
					}
					case "print": this.#fail("PRS", t);
					case "range": this.#fail("RNG", t);
				}
				if (unsupported.includes(t.lexeme)) this.#fail("USK", t, [ t.lexeme ]);
			break;
			case "operator":
				if (t.lexeme === "(") {
					this.#advance();
					const e = this.#expression();
					this.#consume("operator", ")");
					return e;
				}
				if (t.lexeme === "[" || t.lexeme === "{") this.#fail("USK", t, [ t.lexeme ]);
			break;
		}
		this.#fail("UEX", t);
	}

	#fstring(token) {
		const parts = token.parts.map(p => p.text !== undefined ? { text: p.text } :
			{ expression: this.#embedded(p.tokens), spec: p.spec });
		return new FString(token, parts);
	}

	/// Parses the tokens of an {expression} inside an f-string
	#embedded(tokens) {
		const saved = [ this.tokens, this.current ];
		this.tokens = tokens;
		this.current = 0;
		try {
			const e = this.#expression();
			if (!this.#end()) this.#fail("UEX", this.#peek());
			return e;
		} finally { [ this.tokens, this.current ] = saved; }
	}

}
