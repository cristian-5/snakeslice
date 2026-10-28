
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

function variableHTML(id, data) {
	const unset = '<span class="w-3">?</span>';
	const css = { int: "int", float: "float", bool: "bool", str: "string", None: "none" }[data.type];
	let shown;
	switch (data.type) {
		case "str": shown = `"${escaped(data.value)}"`; break;
		default: shown = data.toString();
	}
	return `
	<div class="variable ${css}"><table data-id="${id}">
		<tr><th><span class="type">${data.type}</span> <b>${id}</b></th></tr>
		<tr><td>${shown}</td></tr>
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
