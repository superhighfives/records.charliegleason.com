// Bundle the container entry to a single JS file. The pure image modules it reuses live in
// the main repo's `apps/web/src/lib` (photo-processing, matte-config, matte-pixels,
// reframe-params, sleeve-corners) and import each other via the `#/*` subpath alias —
// resolved here to the repo's `apps/web/src/`, so the container and the Worker run
// byte-identical pixel math. `sharp` is left external (a native module installed at
// runtime, not bundled).
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const dir = dirname(fileURLToPath(import.meta.url));

await esbuild.build({
	entryPoints: [resolve(dir, "src/server.ts")],
	bundle: true,
	platform: "node",
	target: "node22",
	format: "esm",
	outfile: resolve(dir, "dist/server.js"),
	// Native module — installed via package.json in the runtime image, not bundled.
	external: ["sharp"],
	// `#/lib/x` → `<repo>/apps/web/src/lib/x`, matching the main package's `imports` map.
	alias: { "#": resolve(dir, "../../apps/web/src") },
	logLevel: "info",
});
