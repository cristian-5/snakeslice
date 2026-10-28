
const theme = {
	dark: { background: "#000000", foreground: "#FFFFFF", cursor: "#FFFFFF", cursorAccent: "#000000" }
};

document.addEventListener("keydown", e => {
	if (e.key === 's' && (navigator.userAgent.includes('Mac') ? e.metaKey : e.ctrlKey)) {
		e.preventDefault();
		vanillaToast.show(Language.main.saveMessage, { duration: 1000, fadeDuration: 500 });
	}
}, false);

let AST = null;

async function compile(sender = null) {
	const code = editor.getValue();
	localStorage.setItem("py-code", code);
	if (sender) terminal.reset();
	monaco.editor.setModelMarkers(editor.getModel(), "owner", []);
	AST = null;
	try {
		const parser = new Parser(code);
		AST = await parser.parse();
		new TypeChecker().check(AST);
	} catch (e) {
		AST = null;
		if (!(e instanceof CodeError)) {
			console.error(e);
			return;
		}
		if (sender) {
			terminal.reset();
			terminal.write(e.colorful_message);
		}
		monaco.editor.setModelMarkers(editor.getModel(), "owner", [{
			startLineNumber: e.position[0], startColumn: e.position[1],
			endLineNumber: e.position[0], endColumn: e.position[1] + e.position[3],
			message: e.message, severity: monaco.MarkerSeverity.Error
		}]);
		return;
	}
	if (sender === "client") vanillaToast.show(Language.main.noErrors, { duration: 1000, fadeDuration: 500 });
}

async function run() {
	await compile("server");
	terminal.reset();
	document.getElementById("debug").innerHTML = ""; // clear debug view
	if (!AST) return;
	try { await AST.execute(); } catch (e) {
		if (!(e instanceof CodeError)) {
			console.error(e);
			return;
		}
		setTimeout(() => { // wait for terminal to flush
			terminal.reset();
			terminal.write(e.colorful_message);
		}, 10);
	}
}

Print.write = text => terminal.write(text);
Input.prompt = async () => {
	terminal.input_enabled = true;
	while (!terminal.input_ready) await wait(100);
	terminal.input_enabled = terminal.input_ready = false;
	const data = terminal.input_data.replace(/[\r\n]+$/, ""); // input() keeps the spaces typed
	terminal.input_data = "";
	return data;
};

// ==== Debug view: global variables ==========================================
// Python variables have no declared type: the whole box is redrawn whenever
// the value (and possibly its type) changes.

// CSS class (colour) of a Python type
const cssOf = { int: "int", float: "float", bool: "bool", str: "string", None: "none", list: "list" };

function cellHTML(v) {
	switch (v.type) {
		case "str": return `"${escaped(v.value)}"`;
		case "list": return escaped(v.toString());
		default: return v.toString();
	}
}

// "int" if every element of a (nested) list is an int, "list" when mixed or empty
function elementType(list) {
	const types = new Set();
	const visit = l => l.forEach(e => e.type === "list" ? visit(e.value) : types.add(e.type));
	visit(list);
	return types.size === 1 ? [ ...types ][0] : "list";
}

function variableHTML(id, data) {
	if (data.type === "list") {
		const rows = data.value, base = elementType(rows);
		const is2D = rows.length > 0 && rows.every(r => r.type === "list");
		if (!rows.length) return `
		<div class="variable list"><table class="array" data-id="${id}">
			<tr><th><span class="type">list</span> <b>${id}</b>[0]</th></tr>
			<tr><td>[]</td></tr>
		</table></div>`;
		if (!is2D) return `
		<div class="variable ${cssOf[base]}"><table class="array" data-id="${id}">
			<tr><th colspan="${rows.length}"><span class="type">${base}</span> <b>${id}</b>[${rows.length}]</th></tr>
			<tr>${rows.map((e, i) => `<td title="[${i}]">${cellHTML(e)}</td>`).join('')}</tr>
		</table></div>`;
		const cols = Math.max(1, ...rows.map(r => r.value.length));
		return `
		<div class="variable ${cssOf[base]}"><table class="array" data-id="${id}">
			<tr><th colspan="${cols}"><span class="type">${base}</span> <b>${id}</b>[${rows.length}][${cols}]</th></tr>
			${rows.map((r, i) => `<tr>${r.value.map((e, j) =>
				`<td title="[${i}][${j}]">${cellHTML(e)}</td>`).join('')}</tr>`).join('')}
		</table></div>`;
	}
	return `
	<div class="variable ${cssOf[data.type]}"><table data-id="${id}">
		<tr><th><span class="type">${data.type}</span> <b>${id}</b></th></tr>
		<tr><td>${cellHTML(data)}</td></tr>
	</table></div>`;
}

Environment.on_define = Environment.on_change = async (id, data) => {
	const debug = document.getElementById("debug");
	const existing = debug.querySelector(`table[data-id="${id}"]`);
	if (existing) existing.closest(".variable").outerHTML = variableHTML(id, data);
	else debug.innerHTML += variableHTML(id, data);
};

function madeWithLove() {
	vanillaToast.show(Language.main.loveMessage, { duration: 3000, fadeDuration: 500 });
}

function escaped(s) {
	return s.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t");
}
