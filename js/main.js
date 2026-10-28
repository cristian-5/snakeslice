
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

Environment.on_define = async (id, data) => {
	switch (data.dimensions) {
		case 1:
			document.getElementById("debug").innerHTML += `
			<div class="variable ${data.base}"><table class="array" data-id="${id}">
				<tr><th colspan="${data.sizes[0]}">
					<span class="type">${data.base}</span> <b>${id}</b>[${data.sizes[0]}]</th>
				</tr>
				<tr>${Array.from({ length: data.sizes[0] }).map((_, i) => `
					<td title="[${i}]">${data.value[i] === undefined ?
						'<span class="w-3">?</span>' : data.value[i]}
					</td>
				`).join('')}</tr>
			</table></div>`;
		return;
		case 2:
			document.getElementById("debug").innerHTML += `
			<div class="variable ${data.base}"><table class="array" data-id="${id}">
				<tr><th colspan="${data.sizes[0]}">
					<span class="type">${data.base}</span>
					<b>${id}</b>[${data.sizes[0]}][${data.sizes[1]}]</th>
				</tr>
				${Array.from({ length: data.sizes[0] }).map((_, i) => `
					<tr>${Array.from({ length: data.sizes[1] }).map((_, j) => `
						<td title="[${i}][${j}]">${data.value[i][j] === undefined ?
							'<span class="w-3">?</span>' : data.value[i][j]}
						</td>
					`).join('')}</tr>
				`).join('')}
			</table></div>`;
		return;
	}
	if (data.isConst) return; // don't show constants in debug view
	switch (data.type) {
		case "int": case "float": case "bool":
			document.getElementById("debug").innerHTML += `
			<div class="variable ${data.type}"><table data-id="${id}">
				<tr><th><span class="type">${data.base}</span> <b>${id}</b></th></tr>
				<tr><td>${ data.value === undefined ?
					'<span class="w-3">?</span>' : data.value
				}</td></tr>
			</table></div>`;
		break;
		case "char":
			document.getElementById("debug").innerHTML += `
			<div class="variable ${data.type}"><table data-id="${id}">
				<tr><th><span class="type">${data.base}</span> <b>${id}</b></th></tr>
				<tr><td>'${ data.value === undefined ?
					'<span class="w-3">?</span>' : escaped(String.fromCharCode(data.value))
				}'</td></tr>
				<tr><td>${ data.value || "" }</td></tr>
			</table></div>`;
		break;
		case "string":
			document.getElementById("debug").innerHTML += `
			<div class="variable ${data.type}"><table data-id="${id}">
				<tr><th><span class="type">${data.base}</span> <b>${id}</b></th></tr>
				<tr><td>"${ data.value === undefined ?
					'<span class="w-3">?</span>' : escaped(data.value)
				}"</td></tr>
			</table></div>`;
		break;
	}
};

Environment.on_change = async (id, data) => {
	const to_string = d => new Value(d, data.base).toString();
	const variable = document.querySelector(`table[data-id="${id}"]`);
	if (!variable) return;
	switch (data.dimensions) {
		case 0:
			variable.querySelector("td").innerHTML =
				data.value === undefined ?
				'<span class="w-3">?</span>' :
				to_string(data.value);
		return;
		case 1: {
			const tds = variable.querySelectorAll("td");
			for (let i = 0; i < data.sizes[0]; i++)
				tds[i].innerHTML =
				data.value[i] === undefined ?
				'<span class="w-3">?</span>' :
				to_string(data.value[i]);
		} return;
		case 2: {
			const tds = variable.querySelectorAll("td");
			for (let i = 0; i < data.sizes[0]; i++)
				for (let j = 0; j < data.sizes[1]; j++)
					tds[i * data.sizes[1] + j].innerHTML =
					data.value[i][j] === undefined ?
					'<span class="w-3">?</span>' :
					to_string(data.value[i][j]);
		} return;
	}
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
