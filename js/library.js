
// ==== Builtins (always available) ============================================
// Natives receive raw values: int -> BigInt, float -> Number, bool -> boolean, str -> string.

function roundHalfEven(x) {
	const r = Math.round(x);
	return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
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
		{ args: [ "float", "float" ], rest: "float", ret: "float", run: Math.min }
	],
	max: [
		{ args: [ "int", "int" ], rest: "int", ret: "int", run: (...v) => v.reduce((a, b) => b > a ? b : a) },
		{ args: [ "float", "float" ], rest: "float", ret: "float", run: Math.max }
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
	len: [ { args: [ "str" ], ret: "int", run: s => BigInt(Array.from(s).length) } ],
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
