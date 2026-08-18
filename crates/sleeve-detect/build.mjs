#!/usr/bin/env node
// Builds the wasm-bindgen "bundler" target output, then patches the ESM glue for
// workerd: importing a `.wasm` file in a Cloudflare Worker yields a `WebAssembly.Module`
// (compiled, not instantiated), but wasm-bindgen's `--target bundler` output assumes a
// bundler that resolves `.wasm` imports to the instantiated exports directly (the "ESM
// integration" convention some bundlers implement). Neither Vite (dev, via
// @cloudflare/vite-plugin's workerd-backed dev server) nor wrangler deploy do that, so
// the emitted entrypoint needs the manual Module -> Instance step swapped in by hand
// after every `wasm-pack build`. See:
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

// wasm-pack writes a blanket `pkg/.gitignore` (`*`) on every build, assuming pkg/ is
// npm-published rather than committed — we commit it (see the root .gitignore comment),
// so drop the file each time or git would silently stop tracking these changes.
rmSync(path.join(dir, "pkg/.gitignore"), { force: true });

const entry = path.join(dir, "pkg/sleeve_detect.js");
const src = readFileSync(entry, "utf8");

// Confirm the two lines we're about to replace are still there verbatim — if a
// wasm-bindgen upgrade changes this shape, fail loudly instead of silently emitting a
// glue file that's broken for workerd.
const namespaceImport = 'import * as wasm from "./sleeve_detect_bg.wasm";';
const setWasm = '__wbg_set_wasm(wasm);\nwasm.__wbindgen_start();';
if (!src.includes(namespaceImport) || !src.includes(setWasm)) {
	throw new Error(
		"sleeve_detect.js no longer matches the expected wasm-bindgen bundler-target " +
			"shape — update the patch in build.mjs to match the new output before shipping.",
	);
}

const patched = src
	.replace(
		namespaceImport,
		'import wasmModule from "./sleeve_detect_bg.wasm";',
	)
	.replace(
		setWasm,
		[
			"const instance = new WebAssembly.Instance(wasmModule, {",
			'\t"./sleeve_detect_bg.js": imports,',
			"});",
			"__wbg_set_wasm(instance.exports);",
			"instance.exports.__wbindgen_start();",
		].join("\n"),
	)
	.replace(
		'import { __wbg_set_wasm } from "./sleeve_detect_bg.js";',
		'import * as imports from "./sleeve_detect_bg.js";\nimport { __wbg_set_wasm } from "./sleeve_detect_bg.js";',
	);

writeFileSync(entry, patched);
console.log("Patched pkg/sleeve_detect.js for workerd's Module-not-Instance wasm imports.");
