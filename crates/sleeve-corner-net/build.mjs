#!/usr/bin/env node
// Builds the wasm-bindgen "bundler" target output, then patches the ESM glue for workerd —
// identical rationale to crates/sleeve-detect/build.mjs (importing a `.wasm` in a Worker
// yields a WebAssembly.Module, not the instantiated exports, so the manual Module -> Instance
// step must be swapped in by hand after every wasm-pack build). See:
// https://developers.cloudflare.com/workers/languages/rust/#javascript-plumbing-wasm-bindgen
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));

execFileSync(
	"wasm-pack",
	["build", "--target", "bundler", "--release", "--out-dir", "pkg"],
	{ cwd: dir, stdio: "inherit" },
);

// wasm-pack writes a blanket `pkg/.gitignore` (`*`); we commit pkg/, so drop it each build.
rmSync(path.join(dir, "pkg/.gitignore"), { force: true });

const entry = path.join(dir, "pkg/sleeve_corner_net.js");
const src = readFileSync(entry, "utf8");

const namespaceImport = 'import * as wasm from "./sleeve_corner_net_bg.wasm";';
const setWasm = "__wbg_set_wasm(wasm);\nwasm.__wbindgen_start();";
if (!src.includes(namespaceImport) || !src.includes(setWasm)) {
	throw new Error(
		"sleeve_corner_net.js no longer matches the expected wasm-bindgen bundler-target " +
			"shape — update the patch in build.mjs to match the new output before shipping.",
	);
}

const patched = src
	.replace(namespaceImport, 'import wasmModule from "./sleeve_corner_net_bg.wasm";')
	.replace(
		setWasm,
		[
			"const instance = new WebAssembly.Instance(wasmModule, {",
			'\t"./sleeve_corner_net_bg.js": imports,',
			"});",
			"__wbg_set_wasm(instance.exports);",
			"instance.exports.__wbindgen_start();",
		].join("\n"),
	)
	.replace(
		'import { __wbg_set_wasm } from "./sleeve_corner_net_bg.js";',
		'import * as imports from "./sleeve_corner_net_bg.js";\nimport { __wbg_set_wasm } from "./sleeve_corner_net_bg.js";',
	);

writeFileSync(entry, patched);
console.log("Patched pkg/sleeve_corner_net.js for workerd's Module-not-Instance wasm imports.");
