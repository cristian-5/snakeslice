
// #include <cstdlib>

Library.register("cstdlib", {
	abs:  [ { args: [ "int" ], ret: "int", run: Math.abs } ],
	srand: [ { args: [ "int" ], ret: "void", run: seed => pcg32_srandom(BigInt(seed), 0x853c49e6748fea9bn) } ],
	rand: [ { args: [], ret: "int", run: () => pcg32_next() } ]
}, {
	NULL: { type: "int", value: 0 },
});

Library.register("cstddef", { }, {
	NULL: { type: "int", value: 0 },
});

Library.register("", { }, {
	nullptr: { type: "int", value: 0 },
});

// Melissa O'Neill, PCG32 random number generator:

let pcg32_state = 0n, pcg32_increment = 0n;

function pcg32_srandom(initstate, initseq) {
    pcg32_state = 0n;
    pcg32_increment = (BigInt(initseq) << 1n) | 1n;
    pcg32_next();
    pcg32_state = BigInt(initstate);
    pcg32_next();
}

function pcg32_next() {
    const oldstate = pcg32_state;
    pcg32_state = (oldstate * 0x5851F42D4C957F2Dn + pcg32_increment) & 0xFFFFFFFFFFFFFFFFn;
    const xorshifted = Number(((oldstate >> 18n) ^ oldstate) >> 27n) & 0xFFFFFFFF;
    const rot = Number(oldstate >> 59n) & 31;
    return ((xorshifted >>> rot) | (xorshifted << ((-rot) & 31))) >>> 0;
}
