import * as Sentry from "@sentry/tanstackstart-react";
import { StartClient } from "@tanstack/react-start/client";
import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";

// Client (browser) Sentry init. DSN is build-time inlined (public). Mirrors
// TanStack Start's default client entry, plus Sentry.init before hydration.
// One client build serves every host, so gate on the hostname: only the real
// production domain reports — localhost and preview.* set the env tag but stay
// disabled (`enabled: false` keeps the SDK a no-op rather than uninitialised).
const host = window.location.hostname;
const isProduction = host === "records.charliegleason.com";

Sentry.init({
	dsn: import.meta.env.VITE_SENTRY_DSN,
	enabled: isProduction,
	environment: isProduction
		? "production"
		: host === "preview.records.charliegleason.com"
			? "preview"
			: "development",
	sendDefaultPii: true,
	tracesSampleRate: 1.0,
});

startTransition(() => {
	hydrateRoot(
		document,
		<StrictMode>
			<StartClient />
		</StrictMode>,
	);
});
