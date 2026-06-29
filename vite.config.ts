import { cloudflare } from "@cloudflare/vite-plugin";
import { sentryTanstackStart } from "@sentry/tanstackstart-react/vite";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { createLogger, defineConfig, loadEnv } from "vite";

// Some @tanstack/* packages ship `//# sourceMappingURL=` comments without the
// referenced `.js.map` files, so Vite logs a noisy multi-line warning per file
// on startup. Nothing is broken (the maps just don't exist), so filter them.
const logger = createLogger();
const baseWarn = logger.warn;
logger.warn = (msg, opts) => {
	if (msg.includes("Failed to load source map")) return;
	baseWarn(msg, opts);
};

export default defineConfig(({ mode }) => {
	// loadEnv with '' prefix reads non-VITE vars too (org/project/auth token).
	const env = loadEnv(mode, process.cwd(), "");

	// Sentry source-map upload + middleware instrumentation. Only active when a
	// build-time auth token is present (otherwise a no-op — dev/local builds).
	const sentry = env.SENTRY_AUTH_TOKEN
		? [
				sentryTanstackStart({
					org: env.VITE_SENTRY_ORG,
					project: env.VITE_SENTRY_PROJECT,
					authToken: env.SENTRY_AUTH_TOKEN,
				}),
			]
		: [];

	return {
		customLogger: logger,
		// dedupe react/react-dom so the SSR optimizer can't end up with two React
		// copies — that's what surfaced as "Cannot read properties of null
		// (reading 'useContext')" during server rendering (see RECORDS-2/3).
		resolve: { tsconfigPaths: true, dedupe: ["react", "react-dom"] },
		plugins: [
			devtools(),
			// remoteBindings: dev connects to the real D1/R2 (bindings marked
			// `remote: true` in wrangler.jsonc). No local DB — single source of truth.
			cloudflare({ viteEnvironment: { name: "ssr" }, remoteBindings: true }),
			tailwindcss(),
			tanstackStart(),
			viteReact(),
			...sentry,
		],
	};
});
