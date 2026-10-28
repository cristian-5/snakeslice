
class CodeError {

	static code = "";

	#where(position) {
		const [ start, end ] = position, length = end - start;
		let row = 1, col = 1, app = 0;
		for (let i = 0; i < end - length; i++) {
			if (CodeError.code[i] === '\n') { row++; col = 1; app = 0; }
			else {
				col++;
				app += (CodeError.code[i] === '\t') ? 4 : 1;
			}
		}
		return [ row, col, app, length ];
	}

	#line(at) {
		// given char position "at" return the line
		const code = CodeError.code;
		let start = at, end = at;
		while (start > 0 && code[start - 1] !== '\n') start--;
		while (end < code.length && code[end] !== '\n') end++;
		return code.substring(start, end);
	}

	#error(message, line) {
		const [ row, col, app, len ] = this.position;
		return [
			`\x1b[1m[${row}:${col}] \x1b[91merror:\x1b[0m\x1b[1m ${message}\x1b[0m`,
			line.replace(/\t/g, "    ").replace(/^\n+/g, ''), ' '.repeat(app) + (
				len == 1 ? "\x1b[91m^\x1b[0m\n" : ("\x1b[91m" + '~'.repeat(len) + '\x1b[0m\n')
			)
		].join('\n');
	}

	#unravel(message, parameters) {
		let i = 0;
		return message.replace(/%/g, _ => parameters[i++]);
	}

	constructor(message, position, parameters) {
		if ("position" in position) position = [ // token handling
			position.position, position.position + position.lexeme.length
		];
		this.position = this.#where(position);
		if (parameters) this.message = this.#unravel(message, parameters);
		else this.message = message;
		this.colorful_message = this.#error(this.message, this.#line(position[0]));
	}

}
