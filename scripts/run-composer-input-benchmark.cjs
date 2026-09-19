// Electron のNode main processでtsxのregisterを有効にしてbenchmark本体を起動する。
require("tsx/cjs");
require("./benchmark-composer-input.ts");
