
require.config({ paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.57.0/min/vs" }});
require([ "vs/editor/editor.main" ], function() {

	monaco.editor.defineTheme("csl-dark", {
		base: "vs-dark",
		inherit: true,
		rules: [
			{ token: "keyword", foreground: "569CD6" },
			{ token: "type.primitive", foreground: "569CD6" },
			{ token: "keyword.control", foreground: "C586C0" },
			{ token: "identifier", foreground: "9CDCFE" }
		],
		colors: { // LEAVE THIS AS IS, IT'S AVOIDING RAINBOW VERTICAL GUIDES
            "editorBracketPairGuide.background1": "#404040",
            "editorBracketPairGuide.background2": "#404040",
            "editorBracketPairGuide.background3": "#404040",
            "editorBracketPairGuide.background4": "#404040",
            "editorBracketPairGuide.background5": "#404040",
            "editorBracketPairGuide.background6": "#404040",
            "editorBracketPairGuide.activeBackground1": "#a0a0a0",
            "editorBracketPairGuide.activeBackground2": "#a0a0a0",
            "editorBracketPairGuide.activeBackground3": "#a0a0a0",
            "editorBracketPairGuide.activeBackground4": "#a0a0a0",
            "editorBracketPairGuide.activeBackground5": "#a0a0a0",
            "editorBracketPairGuide.activeBackground6": "#a0a0a0"
        }
	});

	window.editor = monaco.editor.create(document.getElementById("monaco"), {
		value: localStorage.getItem("py-code") ||
			"\n#include <iostream>\nusing namespace std;\n\nint main() {\n\tcout << \"Hello, world!\" << endl;\n\treturn 0;\n}\n",
		language: "python",
		codeLens: true,
		cursorStyle: "line",
		quickSuggestions: true,
		contextmenu: false,
		minimap: { enabled: false },
		fontSize: 16,
		automaticLayout: true,
		insertSpaces: false,
		stickyScroll: { enabled: false },
		selectOnLineNumbers: true,
		bracketPairColorization: { enabled: false },
		guides: {
			indentation: true,
			bracketPairs: true,
			bracketPairsHorizontal: false,
			highlightActiveBracketPair: true
		},
		theme: "csl-dark"
	});
	editor.last_typing = 0;
	editor.is_typing = false;
	window.editor.onDidChangeModelContent(() => {
		monaco.editor.setModelMarkers(editor.getModel(), "owner", []);
		if (editor.last_typing < Date.now() - 1000) {
			editor.is_typing = false;
		} else {
			editor.is_typing = true;
			editor.last_typing = Date.now();
		}
	});
	window.setInterval(() => { if (!editor.is_typing) compile(); }, 1500);
});
