
// ==== Builtins (always available) ============================================
// Natives receive raw values: int -> BigInt, float -> Number, bool -> boolean, str -> string.

function roundHalfEven(x) {
	const r = Math.round(x);
	return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/// min()/max() of a list: returns the element itself
function extreme(list, better) {
	if (list.length === 0) throw new NativeError("EML");
	let best = list[0];
	for (const e of list.slice(1)) {
		const rule = TypeRules.compare("<", best.type, e.type);
		if (!rule) throw new NativeError("UOB", [ "<", best.type, e.type ]);
		const x = rule.operand ? best.to(rule.operand).value : best.value;
		const y = rule.operand ? e.to(rule.operand).value : e.value;
		if (better(y, x)) best = e;
	}
	return best;
}

function toBigInt(x) {
	if (!Number.isFinite(x)) throw new NativeError("OVF");
	return BigInt(x);
}

Library.register("", {
	abs: [
		{ args: [ "int" ], ret: "int", run: x => x < 0n ? -x : x },
		{ args: [ "float" ], ret: "float", run: Math.abs }
	],
	min: [
		{ args: [ "int", "int" ], rest: "int", ret: "int", run: (...v) => v.reduce((a, b) => b < a ? b : a) },
		{ args: [ "float", "float" ], rest: "float", ret: "float", run: Math.min },
		{ args: [ "list" ], ret: "value", run: a => extreme(a, (x, y) => x < y) }
	],
	max: [
		{ args: [ "int", "int" ], rest: "int", ret: "int", run: (...v) => v.reduce((a, b) => b > a ? b : a) },
		{ args: [ "float", "float" ], rest: "float", ret: "float", run: Math.max },
		{ args: [ "list" ], ret: "value", run: a => extreme(a, (x, y) => x > y) }
	],
	round: [
		{ args: [ "int" ], ret: "int", run: x => x },
		{ args: [ "float" ], ret: "int", run: x => toBigInt(roundHalfEven(x)) },
		{ args: [ "int", "int" ], ret: "int", run: (x, n) => {
			if (n >= 0n) return x;
			const p = 10 ** Number(-n);
			return BigInt(roundHalfEven(Number(x) / p) * p);
		} },
		{ args: [ "float", "int" ], ret: "float", run: (x, n) => {
			const p = Number(n);
			return p >= 0 ? Number(x.toFixed(Math.min(p, 100))) : roundHalfEven(x / 10 ** -p) * 10 ** -p;
		} }
	],
	int: [
		{ args: [ "int" ], ret: "int", run: x => x },
		{ args: [ "float" ], ret: "int", run: x => toBigInt(Math.trunc(x)) },
		{ args: [ "str" ], ret: "int", run: s => {
			if (!/^\s*[+-]?\d+\s*$/.test(s)) throw new NativeError("IVL", [ "int()", `"${s}"` ]);
			return BigInt(s.trim());
		} }
	],
	float: [
		{ args: [ "int" ], ret: "float", run: x => Number(x) },
		{ args: [ "float" ], ret: "float", run: x => x },
		{ args: [ "str" ], ret: "float", run: s => {
			if (!/^\s*[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?|inf|infinity|nan)\s*$/i.test(s))
				throw new NativeError("IVL", [ "float()", `"${s}"` ]);
			const t = s.trim().toLowerCase().replace(/^([+-]?)(inf|infinity)$/, "$1Infinity");
			return t.endsWith("nan") ? NaN : parseFloat(t.replace("Infinity", "Infinity"));
		} }
	],
	str: [ { args: [ "any" ], ret: "str", run: v => pyStr(v) } ],
	bool: [ { args: [ "any" ], ret: "bool", run: v => isTruthy(v) } ],
	len: [
		{ args: [ "str" ], ret: "int", run: s => BigInt(Array.from(s).length) },
		{ args: [ "list" ], ret: "int", run: a => BigInt(a.length) }
	],
	list: [
		{ args: [], ret: "list", run: () => [] },
		{ args: [ "str" ], ret: "list", run: s => Array.from(s).map(c => new Value(c, "str")) },
		{ args: [ "list" ], ret: "list", run: a => [ ...a ] }
	],
	sum: [ { args: [ "list" ], ret: "value", run: a => {
		let isFloat = false, whole = 0n, real = 0;
		for (const e of a) {
			if (e.type === "float") isFloat = true;
			else if (e.type !== "int" && e.type !== "bool") throw new NativeError("SUM");
			real += Number(e.value);
			if (e.type !== "float") whole += BigInt(e.value);
		}
		return new Value(isFloat ? real : whole);
	} } ],
	sorted: [ { args: [ "list" ], ret: "list", run: a => sortValues([ ...a ]) } ],
	ord: [ { args: [ "str" ], ret: "int", run: s => {
		if (Array.from(s).length !== 1) throw new NativeError("ORC");
		return BigInt(s.codePointAt(0));
	} } ],
	chr: [ { args: [ "int" ], ret: "str", run: i => {
		if (i < 0n || i > 0x10FFFFn) throw new NativeError("OVF");
		return String.fromCodePoint(Number(i));
	} } ]
});

// ==== import math ============================================================

const domain = f => x => { const r = f(x); if (Number.isNaN(r) && !Number.isNaN(x)) throw new NativeError("MDE"); return r; };
const real = (name, run) => ({ [name]: [ { args: [ "float" ], ret: "float", run } ] });

Library.register("math", {
	...real("sqrt", domain(Math.sqrt)),
	...real("sin", Math.sin), ...real("cos", Math.cos), ...real("tan", Math.tan),
	...real("asin", domain(Math.asin)), ...real("acos", domain(Math.acos)), ...real("atan", Math.atan),
	...real("exp", Math.exp), ...real("fabs", Math.abs),
	...real("log2", x => { if (x <= 0) throw new NativeError("MDE"); return Math.log2(x); }),
	...real("log10", x => { if (x <= 0) throw new NativeError("MDE"); return Math.log10(x); }),
	...real("degrees", x => x * 180 / Math.PI), ...real("radians", x => x * Math.PI / 180),
	floor: [ { args: [ "float" ], ret: "int", run: x => toBigInt(Math.floor(x)) } ],
	ceil: [ { args: [ "float" ], ret: "int", run: x => toBigInt(Math.ceil(x)) } ],
	trunc: [ { args: [ "float" ], ret: "int", run: x => toBigInt(Math.trunc(x)) } ],
	log: [
		{ args: [ "float" ], ret: "float", run: x => { if (x <= 0) throw new NativeError("MDE"); return Math.log(x); } },
		{ args: [ "float", "float" ], ret: "float", run: (x, b) => {
			if (x <= 0 || b <= 0 || b === 1) throw new NativeError("MDE");
			return Math.log(x) / Math.log(b);
		} }
	],
	pow: [ { args: [ "float", "float" ], ret: "float", run: (a, b) => {
		const r = a ** b;
		if (Number.isNaN(r) && !Number.isNaN(a) && !Number.isNaN(b)) throw new NativeError("MDE");
		return r;
	} } ],
	atan2: [ { args: [ "float", "float" ], ret: "float", run: Math.atan2 } ],
	hypot: [ { args: [ "float", "float" ], ret: "float", run: Math.hypot } ],
	factorial: [ { args: [ "int" ], ret: "int", run: n => {
		if (n < 0n) throw new NativeError("MDE");
		if (n > 20000n) throw new NativeError("OVF");
		let r = 1n;
		for (let i = 2n; i <= n; i++) r *= i;
		return r;
	} } ],
	gcd: [ { args: [ "int", "int" ], ret: "int", run: (a, b) => {
		a = a < 0n ? -a : a; b = b < 0n ? -b : b;
		while (b) [ a, b ] = [ b, a % b ];
		return a;
	} } ]
}, {
	pi: { type: "float", value: Math.PI },
	e: { type: "float", value: Math.E },
	tau: { type: "float", value: 2 * Math.PI },
	inf: { type: "float", value: Infinity },
	nan: { type: "float", value: NaN }
});

// ==== import random ==========================================================

Library.register("random", {
	random: [ { args: [], ret: "float", run: () => Math.random() } ],
	uniform: [ { args: [ "float", "float" ], ret: "float", run: (a, b) => a + (b - a) * Math.random() } ],
	randint: [ { args: [ "int", "int" ], ret: "int", run: (a, b) => {
		if (b < a) throw new NativeError("RRG");
		return a + BigInt(Math.floor(Math.random() * Number(b - a + 1n)));
	} } ]
});

// ==== List methods ===========================================================
// run(self, ...args): "self" is the raw array of Values. "mutates" redraws the debug view.

const listIndex = (a, i) => {
	const n = i < 0n ? i + BigInt(a.length) : i;
	if (n < 0n || n >= BigInt(a.length)) throw new NativeError("IOB", [ i.toString() ]);
	return Number(n);
};

Library.registerMethods("list", {
	append: [ { args: [ "any" ], ret: "None", mutates: true, run: (a, x) => { a.push(new Value(x)); } } ],
	extend: [ { args: [ "list" ], ret: "None", mutates: true, run: (a, b) => { a.push(...b); } } ],
	insert: [ { args: [ "int", "any" ], ret: "None", mutates: true, run: (a, i, x) => {
		const n = Number(i < 0n ? i + BigInt(a.length) : i);
		a.splice(Math.max(0, Math.min(n, a.length)), 0, new Value(x));
	} } ],
	pop: [
		{ args: [], ret: "value", mutates: true, run: a => { if (!a.length) throw new NativeError("EML"); return a.pop(); } },
		{ args: [ "int" ], ret: "value", mutates: true, run: (a, i) => a.splice(listIndex(a, i), 1)[0] }
	],
	remove: [ { args: [ "any" ], ret: "None", mutates: true, run: (a, x) => {
		const i = a.findIndex(e => pyEq(e, new Value(x)));
		if (i < 0) throw new NativeError("VNF");
		a.splice(i, 1);
	} } ],
	index: [ { args: [ "any" ], ret: "int", run: (a, x) => {
		const i = a.findIndex(e => pyEq(e, new Value(x)));
		if (i < 0) throw new NativeError("VNF");
		return BigInt(i);
	} } ],
	count: [ { args: [ "any" ], ret: "int", run: (a, x) => BigInt(a.filter(e => pyEq(e, new Value(x))).length) } ],
	sort: [ { args: [], ret: "None", mutates: true, run: a => { sortValues(a); } } ],
	reverse: [ { args: [], ret: "None", mutates: true, run: a => { a.reverse(); } } ],
	clear: [ { args: [], ret: "None", mutates: true, run: a => { a.length = 0; } } ],
	copy: [ { args: [], ret: "list", run: a => [ ...a ] } ]
});

// ==== String methods =========================================================

Library.registerMethods("str", {
	upper: [ { args: [], ret: "str", run: s => s.toUpperCase() } ],
	lower: [ { args: [], ret: "str", run: s => s.toLowerCase() } ],
	capitalize: [ { args: [], ret: "str", run: s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() } ],
	strip: [ { args: [], ret: "str", run: s => s.trim() } ],
	split: [
		{ args: [], ret: "list", run: s => (s.trim() === "" ? [] : s.trim().split(/\s+/)).map(x => new Value(x, "str")) },
		{ args: [ "str" ], ret: "list", run: (s, sep) => {
			if (sep === "") throw new NativeError("ESP");
			return s.split(sep).map(x => new Value(x, "str"));
		} }
	],
	join: [ { args: [ "list" ], ret: "str", run: (s, a) => {
		if (a.some(e => e.type !== "str")) throw new NativeError("JNS");
		return a.map(e => e.value).join(s);
	} } ],
	replace: [ { args: [ "str", "str" ], ret: "str", run: (s, a, b) => s.split(a).join(b) } ],
	find: [ { args: [ "str" ], ret: "int", run: (s, x) => BigInt(s.indexOf(x)) } ],
	count: [ { args: [ "str" ], ret: "int", run: (s, x) => x === "" ? BigInt(s.length + 1) : BigInt(s.split(x).length - 1) } ],
	startswith: [ { args: [ "str" ], ret: "bool", run: (s, x) => s.startsWith(x) } ],
	endswith: [ { args: [ "str" ], ret: "bool", run: (s, x) => s.endsWith(x) } ],
	isdigit: [ { args: [], ret: "bool", run: s => /^\d+$/.test(s) } ],
	isalpha: [ { args: [], ret: "bool", run: s => /^\p{L}+$/u.test(s) } ]
});
