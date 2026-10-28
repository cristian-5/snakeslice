
const digit = c => c >= '0' && c <= '9';
const letter = c =>(c >= 'a' && c <= 'z') ||
	(c >= 'A' && c <= 'Z') || c === '_';
const alpha = c => digit(c) || letter(c);

// maps the character AFTER the backslash to the character it stands for
const escapedChars = {
	'\\': "\\", '\'': "'", '"': '"',
	'n': "\n", 't': "\t", 'r': "\r", '0': "\0"
};

const types = [ "int", "float", "double", "char", "string", "bool" ];
// Types that are just another name for a type: the token keeps its own lexeme
// (so error positions are right) and gets a "canonical" name, see typeName() in tree.js.
const typeAliases = { double: "float" };
// iostream and string are handled by the parser itself, the others are libraries
// of native functions that register themselves (cmath.js, cstdlib.js, ctime.js).
const builtinHeaders = [ "iostream", "string" ];
const isHeader = name => builtinHeaders.includes(name) || Library.has(name);
const keywords = [
	"cout", "cin",
	"if", "else",
	"switch", "case", "default",
	"while", "for", "do",
	"break", "continue",
	"return", "void", "namespace", "using", "const",
];

class Parser {

	constructor(code) {
		CodeError.code = this.code = code.replace(/\r/g, ""); // CRLF to LF
		this.tokens = this.#headers(this.#lex());
	}

	#advance() { return this.tokens[this.current++]; }
	#previous() { return this.tokens[this.current - 1]; }
	#peek() { return this.tokens[this.current]; }
	#end() { return this.current >= this.tokens.length; }
	#check(type, lexeme) {
		if (this.#end()) return false;
		const p = this.#peek();
		if (lexeme) {
			if (lexeme instanceof Array)
				 return p.type === type && lexeme.includes(p.lexeme);
			else return p.type === type && p.lexeme === lexeme;
		} else return p.type === type;
	}
	#match(t, l) { return this.#check(t, l) ? !!this.#advance() : false; }
	#consume(t, l) {
		if (this.#match(t, l)) return this.#previous();
		const prev = this.#previous() || { position: 0, lexeme: "" };
		const position = [
			prev.position + prev.lexeme.length,
			prev.position + prev.lexeme.length + 1
		];
		if (l) throw new CodeError(Language.main.errors.EXM, position, [ t, l ]);
		throw new CodeError(Language.main.errors.EXT, position, [ t ]);
	}

	// ==== Lexer ==============================================================

	#lex() {
		const code = this.code;
		let tokens = [], grouped = []; 
		let i = 0, t = "", position = 0;
		while (i < code.length) {
			switch (code[i]) {
				case ' ': case '\t': case '\n': break;
				case '+': case '-': case '*':
				case '%': case '=': case '(': case ')':
				case '{': case '}': case ';': case ',':
				case '<': case '>': case '!': case ':':
				case '[': case ']': case '&': case '|':
					tokens.push({ lexeme: code[i], type: "operator", position: i });
				break;
				case '/':
					position = i;
					if (code[i + 1] === '/') {
						while (i < code.length && code[i] !== '\n') i++;
					} else if (code[i + 1] === '*') {
						i += 2;
						while (i < code.length && !(code[i - 1] === '*' && code[i] === '/')) i++;
						if (code[i] !== '/')
							throw new CodeError(Language.main.errors.MTC, [ position, position + 1 ], '/');
						i++;
					} else tokens.push({ lexeme: code[i], type: "operator", position });
				break;
				case '#': {
					position = i;
					while (i < code.length && code[i] !== '\n') i++;
					const m = code.substring(position, i).match(/^#\s*include\s*<\s*([\w.]+)\s*>\s*(\/\/.*)?$/);
					if (!m) throw new CodeError(Language.main.errors.BIN, [ position, i ]);
					if (!isHeader(m[1])) throw new CodeError(Language.main.errors.UHD, [ position, i ], [ m[1] ]);
					tokens.push({ lexeme: code.substring(position, i), type: "include", header: m[1], position });
				} break;
				case '"': {
					position = i;
					i++;
					t = ""; // decoded content
					while (i < code.length && code[i] !== '"' && code[i] !== '\n') {
						if (code[i] === '\\') {
							const c = code[i + 1];
							if (c === undefined || c === '\n') break; // unterminated
							if (!Object.hasOwn(escapedChars, c))
								throw new CodeError(Language.main.errors.UES, [ i, i + 2 ]);
							t += escapedChars[c];
							i += 2;
						} else t += code[i++];
					}
					if (code[i] !== '"') throw new CodeError(Language.main.errors.MTC, [ position, i ], '"');
					// i stays on the closing quote; the loop's final i++ moves past it
					// lexeme stays the raw source text (positions/lengths), value is the decoded string
					tokens.push({ lexeme: code.substring(position, i + 1), value: t, type: "string", position });
				} break;
				case '\'': {
					position = i;
					i++;
					t = ""; // decoded content
					while (i < code.length && code[i] !== '\'' && code[i] !== '\n') {
						if (code[i] === '\\') {
							const c = code[i + 1];
							if (c === undefined || c === '\n') break; // unterminated
							if (!Object.hasOwn(escapedChars, c))
								throw new CodeError(Language.main.errors.UES, [ i, i + 2 ]);
							t += escapedChars[c];
							i += 2;
						} else t += code[i++];
					}
					if (code[i] !== '\'') throw new CodeError(Language.main.errors.MTC, [ position, i ], "'");
					if (t.length !== 1) throw new CodeError(Language.main.errors.ICL, [ position, i + 1 ]);
					// i stays on the closing quote; the loop's final i++ moves past it
					tokens.push({ lexeme: code.substring(position, i + 1), value: t, type: "char", position });
				} break;
				default:
					position = i;
					if (digit(code[i])) {
						t = "";
						let hasDecimal = false;
						while (i < code.length && (digit(code[i]) || (code[i] === '.' && !hasDecimal))) {
							if (code[i] === '.') hasDecimal = true;
							t += code[i++];
						}
						tokens.push({ lexeme: t, type: "number", position });
					} else if (letter(code[i])) {
						t = "";
						while (i < code.length && letter(code[i])) t += code[i++];
						if (types.includes(t)) {
								const token = { lexeme: t, type: "type", position };
								if (Object.hasOwn(typeAliases, t)) token.canonical = typeAliases[t];
								tokens.push(token);
							}
						else if (keywords.includes(t)) tokens.push({ lexeme: t, type: "keyword", position });
						else tokens.push({ lexeme: t, type: "identifier", position });
					} else throw new CodeError(Language.main.errors.UNC, [ position, position + 1 ]);
					i--;
				break;
			}
			i++;
		}
		// group tokens like !=, ==, <=, >=, etc:
		for (let i = 0; i < tokens.length; i++) {
			if (tokens[i].type !== "operator" || i === tokens.length - 1) {
				grouped.push(tokens[i]);
				continue;
			}
			let combined = false;
			switch (tokens[i].lexeme) {
				case '=': case '!': case '*': case '/': case '%':
					if (tokens[i + 1].lexeme === '=') {
						grouped.push({
							lexeme: tokens[i].lexeme + tokens[i + 1].lexeme,
							type: "operator", position: tokens[i].position
						});
						i++;
						combined = true;
					}
				break;
				case ':':
					if (tokens[i + 1].lexeme === ':') {
						grouped.push({
							lexeme: tokens[i].lexeme + tokens[i + 1].lexeme,
							type: "operator", position: tokens[i].position
						});
						i++;
						combined = true;
					}
				break;
				case '&': case '|': case '<': case '>': case '+': case '-':
					if (tokens[i + 1].lexeme === '=' || tokens[i + 1].lexeme === tokens[i].lexeme) {
						grouped.push({
							lexeme: tokens[i].lexeme + tokens[i + 1].lexeme,
							type: "operator", position: tokens[i].position
						});
						i++;
						combined = true;
					}
				break;
			}
			if (!combined) grouped.push(tokens[i]);
		}
		return grouped;
	}

	// Checks #include / using against what the code uses, and turns std::string
	// into a single "string" type token. #include tokens are removed.
	#headers(tokens) {
		const errors = Language.main.errors, included = this.included = new Set(), out = [];
		let usingStd = false, usingString = false;
		for (let i = 0; i < tokens.length; i++) {
			const t = tokens[i], next = tokens[i + 1], after = tokens[i + 2], last = out[out.length - 1];
			if (t.type === "include") { for (const h of Library.closure(t.header)) included.add(h); continue; }
			if (((t.type === "keyword" && (t.lexeme === "cout" || t.lexeme === "cin")) ||
				(t.type === "identifier" && t.lexeme === "endl")) && !included.has("iostream"))
				throw new CodeError(errors.NIO, t, [ t.lexeme ]);
			if (t.type === "keyword" && t.lexeme === "using" && next && after) {
				if (next.lexeme === "namespace" && after.lexeme === "std") usingStd = true;
				if (next.lexeme === "std" && after.lexeme === "::" && tokens[i + 3]?.lexeme === "string")
					usingString = true;
			}
			if (t.type === "identifier" && t.lexeme === "std" && next?.lexeme === "::" &&
				after?.type === "type" && after.lexeme === "string" &&
				!(last && last.type === "keyword" && last.lexeme === "using")) { // std::string
				if (!included.has("string")) throw new CodeError(errors.NIS, after);
				out.push(after);
				i += 2;
				continue;
			}
			if (t.type === "type" && t.lexeme === "string") {
				if (!included.has("string")) throw new CodeError(errors.NIS, t);
				if (!usingStd && !usingString)
					throw new CodeError(errors.NDS, t, [ "string", "string" ]);
			}
			out.push(t);
		}
		return out;
	}

	// ==== Parser =============================================================

	// <program> := { <top_level> }
	// main() is required and only declarations are allowed outside of functions.
	#program() {
		const items = [], first = [];
		while (!this.#end()) {
			first.push(this.#peek());
			items.push(this.#topLevel());
		}
		const main = items.find(i =>
			i instanceof FunctionDefinition && i.name.lexeme === "main" && i.body);
		if (main) {
			if (main.returnType.lexeme !== "int" || main.params.length > 0)
				throw new CodeError(Language.main.errors.MAI, main.name);
			items.forEach((item, i) => {
				if (!item.isDeclaration)
					throw new CodeError(Language.main.errors.OUT, first[i]);
			});
		} else throw new CodeError(Language.main.errors.NOM, [ 0, 1 ]);
		return new Program(items, main ? main.name : null, this.included);
	}
	// <top_level> := <using> | <namespace> | <function> | <block>
	#topLevel() {
		if (this.#check("keyword", "using")) return this.#using();
		if (this.#check("keyword", "namespace")) return this.#namespace();
		if (this.#isFunction()) return this.#function();
		return this.#block();
	}
	// <member> := <using> | <namespace> | <function> | <declaration> ';'
	#member() {
		if (this.#check("keyword", "using")) return this.#using();
		if (this.#check("keyword", "namespace")) return this.#namespace();
		if (this.#isFunction()) return this.#function();
		if (this.#check("type") || this.#check("keyword", "const")) {
			const d = this.#declaration();
			this.#consume("operator", ";");
			return d;
		}
		throw new CodeError(Language.main.errors.OUT, this.#peek() || this.#previous());
	}
	// <namespace> := "namespace" <identifier> '{' { <member> } '}'
	#namespace() {
		const kw = this.#consume("keyword", "namespace");
		const name = this.#consume("identifier");
		this.#consume("operator", "{");
		const items = [];
		while (!this.#check("operator", "}") && !this.#end()) items.push(this.#member());
		const rbrace = this.#consume("operator", "}");
		return new NamespaceDeclaration(kw, name, items, rbrace);
	}
	// <using> := "using" "namespace" <identifier> { "::" <identifier> } ';'
	//          | "using" <identifier> "::" <identifier> { "::" <identifier> } ';'
	#using() {
		const kw = this.#consume("keyword", "using");
		if (this.#match("keyword", "namespace")) {
			const path = [ this.#consume("identifier") ];
			while (this.#match("operator", "::")) path.push(this.#consume("identifier"));
			return new UsingNamespace(kw, path, this.#consume("operator", ";"));
		}
		const parts = [ this.#consume("identifier") ];
		do {
			this.#consume("operator", "::");
			// cout, cin and string are not identifiers for the lexer
			if (this.#check("keyword", [ "cout", "cin" ]) || this.#check("type", "string"))
				parts.push(this.#advance());
			else parts.push(this.#consume("identifier"));
		} while (this.#check("operator", "::"));
		return new UsingDeclaration(kw, this.#qualify(parts), this.#consume("operator", ";"));
	}
	// is there "<type> <identifier> (" ahead?
	#isFunction() {
		const a = this.#peek(), b = this.tokens[this.current + 1], c = this.tokens[this.current + 2];
		return !!(a && b && c) &&
			(a.type === "type" || (a.type === "keyword" && a.lexeme === "void")) &&
			b.type === "identifier" && c.type === "operator" && c.lexeme === "(";
	}
	// <function> := ( <type> | "void" ) <identifier> '(' [ <params> ] ')' ( <block> | ';' )
	// <params> := "void" | <type> [ <identifier> ] { ',' <type> [ <identifier> ] }
	// (a function ending with ';' is a prototype, so the parameter names are optional)
	#function() {
		const returnType = this.#advance();
		const name = this.#consume("identifier");
		this.#consume("operator", "(");
		const params = [];
		if (this.#check("keyword", "void") && this.tokens[this.current + 1]?.lexeme === ")")
			this.#advance();
		else if (!this.#check("operator", ")")) {
			do {
				const type = this.#consume("type");
				const id = this.#check("identifier") ? this.#advance() : null;
				params.push({ type, id });
			} while (this.#match("operator", ","));
		}
		this.#consume("operator", ")");
		if (this.#match("operator", ";"))
			return new FunctionDefinition(returnType, name, params, null, this.#previous().position + 1);
		const missing = params.find(p => !p.id);
		if (missing) {
			const end = missing.type.position + missing.type.lexeme.length;
			throw new CodeError(Language.main.errors.EXT, [ end, end + 1 ], [ "identifier" ]);
		}
		if (!this.#check("operator", "{")) this.#consume("operator", "{"); // reports the error
		const body = this.#block();
		return new FunctionDefinition(returnType, name, params, body, body.end);
	}
	// <return> := "return" [ <expression> ] ';'
	#return() {
		const kw = this.#consume("keyword", "return");
		let exp = null;
		if (!this.#check("operator", ";")) exp = this.#expression();
		this.#consume("operator", ";");
		return new Return(kw, exp);
	}
	// is there std::<keyword> ahead? (std::cout, std::cin)
	#isStd(keyword) {
		const a = this.#peek(), b = this.tokens[this.current + 1], c = this.tokens[this.current + 2];
		return !!(a && b && c) && a.type === "identifier" && a.lexeme === "std" &&
			b.lexeme === "::" && c.type === "keyword" && c.lexeme === keyword;
	}
	// a::b::c becomes a single token with "qualifiers" [a, b] and "member" c
	#qualify(parts) {
		if (parts.length === 1) return parts[0];
		return {
			lexeme: parts.map(p => p.lexeme).join("::"),
			type: "identifier", position: parts[0].position,
			qualifiers: parts.slice(0, -1), member: parts[parts.length - 1].lexeme
		};
	}
	// <identifier> := <name> { "::" <name> }
	#identifier() {
		const parts = [ this.#advance() ];
		while (this.#match("operator", "::")) parts.push(this.#consume("identifier"));
		return new Identifier(this.#qualify(parts));
	}
	// <declaration> := [ "const" ] <type> <partial> { ',' <partial> }
	// <partial> := <identifier> [ { '[' <expression> ']' } | '=' <expression> ]
	// (every <partial> of a const declaration must have an initializer)
	#declaration() {
		const kw = this.#match("keyword", "const") ? this.#previous() : null;
		const type = this.#consume("type");
		function partial() {
			const id = this.#consume("identifier");
			if (this.#match("operator", '='))
				return { id, exp: this.#expression() };
			else if (kw) throw new CodeError(Language.main.errors.CNI, id, [ id.lexeme ]);
			else if (this.#check("operator", '[')) {
				const sizes = [];
				while (this.#match("operator", '[')) {
					sizes.push(this.#expression());
					this.#consume("operator", ']');
				}
				return { id, exp: null, sizes, end: this.#previous().position + 1 }; // after the last ']'
			} else return { id, exp: null };
		}
		const decls = [ partial.call(this) ];
		while (this.#match("operator", ",")) decls.push(partial.call(this));
		return new Declaration(type, decls, kw);
	}
	// <block> := '{' { <statement> } '}'
	#block() {
		const statements = [];
		if (this.#match("operator", '{')) {
			const lbrace = this.#previous();
			while (!this.#check("operator", '}') && !this.#end())
				statements.push(this.#statement());
			const rbrace = this.#consume("operator", '}');
			return new Block(lbrace, statements, rbrace);
		} else return this.#statement();
	}
	// <statement> := <declaration> ';'
	//              | <cout> | <cin>
	//			    | <if> | <while> | <dowhile>
	//              | <expression> ';'
	#statement() {
		let e;
		if (this.#check("type") || this.#check("keyword", "const")) {
			e = this.#declaration();
			this.#consume("operator", ";");
		}
		else if (this.#check("keyword", "cout"))  e = this.#cout(false);
		else if (this.#check("keyword", "cin"))   e = this.#cin(false);
		else if (this.#isStd("cout")) { this.#advance(); this.#advance(); e = this.#cout(true); }
		else if (this.#isStd("cin"))  { this.#advance(); this.#advance(); e = this.#cin(true); }
		else if (this.#check("keyword", "return")) e = this.#return();
		else if (this.#check("keyword", "using"))  e = this.#using();
		else if (this.#check("keyword", "if"))    e = this.#if();
		else if (this.#check("keyword", "while")) e = this.#while();
		else if (this.#check("keyword", "do"))    e = this.#dowhile();
		else if (this.#check("keyword", "for"))   e = this.#for();
		else if (this.#check("keyword", "switch")) e = this.#switch();
		else if (this.#check("keyword", [ "case", "default" ]))
			throw new CodeError(Language.main.errors.CSO, this.#peek());
		else if (this.#match("keyword", "break")) {
			e = new Break(this.#previous());
			this.#consume("operator", ";");
		}
		else if (this.#match("keyword", "continue")) {
			e = new Continue(this.#previous());
			this.#consume("operator", ";");
		}
		else {
			e = new Instruction(this.#expression());
			this.#consume("operator", ";");
		}
		return e;
	}

	// <if> := "if" '(' <expression> ')' <block> [ "else" <block> ]
	#if() {
		const i = this.#consume("keyword", "if");
		this.#consume("operator", "(");
		const condition = this.#expression();
		this.#consume("operator", ")");
		const then = this.#block();
		let els = null;
		if (this.#match("keyword", "else")) els = this.#block();
		return new If(i, condition, then, els);
	}

	#while() {
		const w = this.#consume("keyword", "while");
		this.#consume("operator", "(");
		const condition = this.#expression();
		this.#consume("operator", ")");
		const block = this.#block();
		return new While(w, condition, block);
	}

	#dowhile() {
		const d = this.#consume("keyword", "do");
		const block = this.#block();
		this.#consume("keyword", "while");
		this.#consume("operator", "(");
		const condition = this.#expression();
		this.#consume("operator", ")");
		this.#consume("operator", ";");
		return new DoWhile(d, block, condition);
	}

	#for() {
		const f = this.#consume("keyword", "for");
		this.#consume("operator", "(");
		let init = null, condition = null, update = null;
		if (!this.#check("operator", ";")) {
			if (this.#check("type") || this.#check("keyword", "const")) init = this.#declaration();
			else init = this.#expression();
		}
		this.#consume("operator", ";");
		if (!this.#check("operator", ";")) condition = this.#expression();
		this.#consume("operator", ";");
		if (!this.#check("operator", ")")) update = this.#expression();
		this.#consume("operator", ")");
		const block = this.#block();
		return new For(f, init, condition, update, block);
	}

	// <switch> := "switch" '(' <expression> ')' '{' { <label> | <statement> } '}'
	// <label> := "case" <expression> ':' | "default" ':'
	// The body is kept flat: the labels are just markers between the statements.
	#switch() {
		const kw = this.#consume("keyword", "switch");
		this.#consume("operator", "(");
		const expression = this.#expression();
		this.#consume("operator", ")");
		this.#consume("operator", "{");
		const body = [];
		let hasDefault = false;
		while (!this.#check("operator", "}") && !this.#end()) {
			if (this.#match("keyword", "case")) {
				const c = this.#previous(), exp = this.#expression();
				body.push(new CaseLabel(c, exp, this.#consume("operator", ":")));
			} else if (this.#match("keyword", "default")) {
				const d = this.#previous();
				if (hasDefault) throw new CodeError(Language.main.errors.MDF, d);
				hasDefault = true;
				body.push(new DefaultLabel(d, this.#consume("operator", ":")));
			} else body.push(this.#statement());
		}
		return new Switch(kw, expression, body, this.#consume("operator", "}"));
	}

	// <cout> := "cout" << <expression> ( << <expression> )*
	#cout(qualified) {
		const c = this.#consume("keyword", "cout");
		if (!this.#check("operator", "<<"))
			throw new CodeError(Language.main.errors.COU, this.#peek() || this.#previous());
		let e = [];
		while (this.#match("operator", "<<")) e.push(this.#expression());
		this.#consume("operator", ";");
		return new Cout(c, e, qualified);
	}
	// <cin> := "cin" >> <identifier> ( >> <identifier> )*
	#cin(qualified) {
		const c = this.#consume("keyword", "cin");
		if (!this.#check("operator", ">>"))
			throw new CodeError(Language.main.errors.CIN, this.#peek() || this.#previous());
		let e = [];
		while (this.#match("operator", ">>")) {
			const id = this.#expression();
			if (!(id instanceof Identifier || id instanceof Subscript))
				throw new CodeError(Language.main.errors.CIX, [ id.start, id.end ]);
			e.push(id);
		}
		this.#consume("operator", ";");
		return new Cin(c, e, qualified);
	}

	// ==== Expressions ========================================================

	// <expression> := <assignment>
	#expression() { return this.#assignment(); }
	// <assignment> := <identifier> ( '=' <assignment> ) | <logic_or>
	#assignment() {
		let e = this.#logic_or();
		if (this.#match("operator", [ '=', "+=", "-=", "*=", "/=", "%=" ])) {
			const op = this.#previous();
			const value = this.#assignment();
			if (e instanceof Identifier || e instanceof Subscript)
				return new Assignment(e, op, value);
			throw new CodeError(Language.main.errors.IAT, [ e.start, e.end ]);
		} else return e;
	}
	// <logic_or> := <logic_and> ( "||" <logic_and> )*
	#logic_or() {
		let e = this.#logic_and();
		while (this.#match("operator", "||"))
			e = new InfixExpression(e, this.#previous(), this.#logic_and());
		return e;
	}
	// <logic_and> := <equality> ( "&&" <equality> )*
	#logic_and() {
		let e = this.#equality();
		while (this.#match("operator", "&&"))
			e = new InfixExpression(e, this.#previous(), this.#equality());
		return e;
	}
	// <equality> := <comparison> ( ( "==" | "!=" ) <comparison> )*
	#equality() {
		let e = this.#comparison();
		while (this.#match("operator", [ "==", "!=" ]))
			e = new InfixExpression(e, this.#previous(), this.#comparison());
		return e;
	}
	// <comparison> := <term> ( ( '>' | '<' | ">=" | "<=" ) <term> )*
	#comparison() {
		let e = this.#term();
		while (this.#match("operator", [ '>', '<', ">=", "<=" ]))
			e = new InfixExpression(e, this.#previous(), this.#term());
		return e;
	}
	// <term> := <factor> ( ( '+' | '-' | '|' ) <factor> )*
	#term() {
		let e = this.#factor();
		while (this.#match("operator", [ '+', '-', '|' ]))
			e = new InfixExpression(e, this.#previous(), this.#factor());
		return e;
	}
	// <factor> := <prefix> ( ( '*' | '/' | '%' | '&' ) <prefix> )*
	#factor() {
		let e = this.#prefix();
		while (this.#match("operator", [ '*', '/', '%', '&' ]))
			e = new InfixExpression(e, this.#previous(), this.#prefix());
		return e;
	}
	// <prefix> := ( '!', '+' | '-' | '~' | "++" | "--") <prefix> | '(' <type> ')' <prefix> | <call>
	#prefix() {
		if (this.#match("operator", [ '!', '+', '-', '~', "++", "--" ]))
			return new PrefixExpression(this.#previous(), this.#prefix());
		if (this.#isCast()) { // (int)x binds like a prefix operator: (int)x + 1 is ((int)x) + 1
			const lpar = this.#advance(), type = this.#advance();
			this.#advance(); // ')'
			const e = this.#prefix();
			return new Cast(type, e, lpar.position, e.end);
		}
		return this.#call();
	}
	// is there "( <type> )" ahead?
	#isCast() {
		const a = this.#peek(), b = this.tokens[this.current + 1], c = this.tokens[this.current + 2];
		return !!(a && b && c) && a.type === "operator" && a.lexeme === "(" &&
			b.type === "type" && c.type === "operator" && c.lexeme === ")";
	}
	// <call> := <postfix> ( '(' <arguments>? ')' )*
	// <arguments> := <expression> ( ',' <expression> )*
	#call() {
		let e = this.#postfix();
		while (this.#match("operator", "(")) {
			const lpar = this.#previous(), args = [];
			if (!this.#check("operator", ")")) {
				do args.push(this.#expression());
				while (this.#match("operator", ","));
			}
			e = new Call(e, lpar, this.#consume("operator", ")"), args);
		}
		return e;
	}
	// <postfix> := <subscript> ( '++' | '--' )*
	#postfix() {
		let e = this.#subscript();
		while (this.#match("operator", [ "++", "--" ]))
			e = new PostfixExpression(e, this.#previous());
		return e;
	}
	// <subscript> := <primary> ('[' <expression> ']') [ '=' <expression> ]
	#subscript() {
		let e = this.#primary();
		if (this.#check("operator", "[")) {
			const indexes = [];
			while (this.#match("operator", "[")) {
				indexes.push(this.#expression());
				this.#consume("operator", "]");
			}
			e = new Subscript(e, indexes, this.#previous());
		}
		return e;
	}
	// <primary> := '(' <expression> ')' | <type> '(' <expression> ')' | <postfix> | <number> | <string> | <char> | <bool>
	#primary() {
		if (this.#match("operator", "(")) {
			const e = this.#expression();
			this.#consume("operator", ")");
			return e;
		} else if (this.#check("type") && this.tokens[this.current + 1]?.lexeme === "(") {
			const type = this.#advance(); // int(x)
			this.#consume("operator", "(");
			const e = this.#expression();
			return new Cast(type, e, type.position, this.#consume("operator", ")").position + 1);
		} else if (this.#check("number")) {
			const n = this.#advance();
			if (n.lexeme.includes('.')) return new Literal(n, "float");
			return new Literal(n, "int");
		}
		else if (this.#check("identifier"))
			return this.#identifier();
		else if (this.#check("string"))
			return new Literal(this.#advance(), "string");
		else if (this.#check("char"))
			return new Literal(this.#advance(), "char");
		throw new CodeError(Language.main.errors.UEX, this.#peek() || this.#previous());
	}

	// ==== Interpreter ========================================================

	async parse() {
		if (this.tokens.length === 0) return;
		this.current = 0;
		return await this.#program();
	}

}
