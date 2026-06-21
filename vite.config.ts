import { cloudflare } from "@cloudflare/vite-plugin";
import { sentryTanstackStart } from "@sentry/tanstackstart-react/vite";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

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
		resolve: { tsconfigPaths: true },
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
