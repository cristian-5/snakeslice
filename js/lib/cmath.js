
// #include <cmath>

Library.register("cmath", {
	sqrt:  [ { args: [ "float" ], ret: "float", run: Math.sqrt } ],
	abs:   [ { args: [ "int" ],   ret: "int",   run: Math.abs },
	         { args: [ "float" ], ret: "float", run: Math.abs } ],
	pow:   [ { args: [ "float", "float" ], ret: "float", run: Math.pow } ],
	sin:   [ { args: [ "float" ], ret: "float", run: Math.sin } ],
	cos:   [ { args: [ "float" ], ret: "float", run: Math.cos } ],
	tan:   [ { args: [ "float" ], ret: "float", run: Math.tan } ],
	exp:   [ { args: [ "float" ], ret: "float", run: Math.exp } ],
	log:   [ { args: [ "float" ], ret: "float", run: Math.log } ],
	floor: [ { args: [ "float" ], ret: "float", run: Math.floor } ],
	ceil:  [ { args: [ "float" ], ret: "float", run: Math.ceil } ],
	// like C++ halves go away from zero (Math.round(-2.5) would give -2)
	round: [ { args: [ "float" ], ret: "float", run: x => Math.sign(x) * Math.round(Math.abs(x)) } ],
});
