
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
	resetDebugView();
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

// ==== Debug view =============================================================
//
// Global variables sit directly in the view. Every function call and every list
// comprehension is a scope: it is drawn as a dashed box that holds its variables and,
// nested inside, the scopes opened from it. Python has no block scopes, so `if`, `for`
// and `while` do not get a box. A function call is nested where the function was
// *defined* (the globals), not in its caller, because that is all it can see: a
// recursive function shows one box per call, side by side, in the order of the calls.
//
// The interpreter reports what happens through the Environment hooks below. They only
// update a small model: while the program runs the browser cannot paint anyway (it
// gets control back when the program waits at `input()` and when it ends), so the model
// is drawn once, then, instead of touching the DOM on every iteration of a loop. That
// is also why a scope is visible while the program is waiting at `input()` or stopped
// by an error, and is gone once its call has returned.
//
// Python variables have no declared type: the whole box is redrawn whenever the value
// (and possibly its type) changes.

const debugModel = { items: [] };  // top level: variables and scopes, in order of creation
const scopeNodes = new Map();      // env.uid -> scope { label, items, parent, keys }
const variableItems = new Map();   // "uid/id" -> variable { id, data }
let renderTimer = null;

function resetDebugView() {
	debugModel.items = [];
	scopeNodes.clear();
	variableItems.clear();
	renderDebugView();
}

function scheduleRender() {
	if (renderTimer === null) renderTimer = setTimeout(renderDebugView, 0);
}

function renderDebugView() {
	clearTimeout(renderTimer);
	renderTimer = null;
	document.getElementById("debug").innerHTML = itemsHTML(debugModel.items);
}

/// The list a variable (or a scope) of `env` goes in. It is undefined for an environment
/// the view knows nothing about (e.g. one left over from a previous run).
function itemsOf(env) {
	return env === Environment.global ? debugModel.items : scopeNodes.get(env.uid)?.items;
}

function itemsHTML(items) {
	let result = "";
	for (const item of items) {
		if (item.items && item.items.length === 0) continue; // don't show empty scopes
		result += item.items ? `<div class="scope">
			<div class="scope-label">${escaped(item.label)}</div>
			<div class="scope-content">${itemsHTML(item.items)}</div>
		</div>` : variableHTML(item.id, item.data);
	}
	return result;
}

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
			${rows.map((r, i) => `<tr>${r.value.length ? r.value.map((e, j) =>
				`<td title="[${i}][${j}]">${cellHTML(e)}</td>`).join('') :
				`<td class="empty" colspan="${cols}" title="[${i}]">[]</td>`}</tr>`).join('')}
		</table></div>`;
	}
	return `
	<div class="variable ${cssOf[data.type]}"><table data-id="${id}">
		<tr><th><span class="type">${data.type}</span> <b>${id}</b></th></tr>
		<tr><td>${cellHTML(data)}</td></tr>
	</table></div>`;
}

Environment.on_open = env => {
	const parent = itemsOf(env.parent);
	if (!parent) return;
	const node = { label: env.label, items: [], parent, keys: [] };
	parent.push(node);
	scopeNodes.set(env.uid, node);
	scheduleRender();
};

Environment.on_close = env => {
	const node = scopeNodes.get(env.uid);
	if (!node) return;
	const i = node.parent.lastIndexOf(node); // (it is almost always the last)
	if (i >= 0) node.parent.splice(i, 1);
	for (const key of node.keys) variableItems.delete(key);
	scopeNodes.delete(env.uid);
	scheduleRender();
};

Environment.on_define = (env, id, data) => {
	const items = itemsOf(env);
	if (!items) return;
	const item = { id, data }, key = `${env.uid}/${id}`;
	items.push(item);
	variableItems.set(key, item);
	scopeNodes.get(env.uid)?.keys.push(key);
	scheduleRender();
};

Environment.on_change = (env, id, data) => {
	const item = variableItems.get(`${env.uid}/${id}`);
	if (!item) return;
	item.data = data;
	scheduleRender();
};

// A list was modified in place. The variables hold the very same list, so it is enough
// to draw them again.
Environment.on_mutate = () => scheduleRender();

function escaped(s) {
	return s.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t");
}
