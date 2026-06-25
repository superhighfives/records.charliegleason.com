import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Standalone test config — deliberately NOT extending vite.config.ts (which loads
 * the Cloudflare plugin / full app build). Tests run in plain Node and stub the
 * `cloudflare:workers` virtual module, so any unit under test can import it without
 * a Workers runtime. Code that genuinely needs bindings should be exercised via
 * pure, exported helpers (see src/lib/sellers.ts).
 */
export default defineConfig({
	resolve: {
		alias: {
			"cloudflare:workers": fileURLToPath(
				new URL("./test/cloudflare-workers-stub.ts", import.meta.url),
			),
		},
	},
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
	},
});
