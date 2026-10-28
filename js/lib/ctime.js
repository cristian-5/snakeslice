
// #include <ctime>

Library.register("ctime", {
	// time() and time(NULL): there are no pointers, the argument is ignored
	time: [ { args: [], ret: "int", run: () => Date.now() },
	        { args: [ "int" ], ret: "int", run: () => Date.now() } ],
}, {
	NULL: { type: "int", value: 0 },
});
