import { TanStackDevtools } from "@tanstack/react-devtools";
import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { CollectionUIProvider } from "../components/collection-ui";
import { ScrollPerfHud } from "../components/scroll-perf-hud";
import { Toaster } from "../components/ui/sonner";
import ClerkProvider from "../integrations/clerk/provider";
import TanStackQueryDevtools from "../integrations/tanstack-query/devtools";
import appCss from "../styles.css?url";

interface MyRouterContext {
	queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
	head: () => ({
		meta: [
			{
				charSet: "utf-8",
			},
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1",
			},
			{
				name: "description",
				content: "Charlie Gleason's vinyl record collection.",
			},
			{
				title: "Records · charliegleason.com",
			},
			{
				name: "theme-color",
				content: "#fbe047",
			},
			// Open Graph
			{ property: "og:type", content: "website" },
			{ property: "og:title", content: "Records · charliegleason.com" },
			{
				property: "og:description",
				content: "Charlie Gleason's vinyl record collection.",
			},
			{ property: "og:url", content: "https://records.charliegleason.com/" },
			{
				property: "og:image",
				content: "https://records.charliegleason.com/og-image.png",
			},
			{ property: "og:image:width", content: "1200" },
			{ property: "og:image:height", content: "630" },
			// Twitter
			{ name: "twitter:card", content: "summary_large_image" },
			{ name: "twitter:title", content: "Records · charliegleason.com" },
			{
				name: "twitter:description",
				content: "Charlie Gleason's vinyl record collection.",
			},
			{
				name: "twitter:image",
				content: "https://records.charliegleason.com/og-image.png",
			},
		],
		links: [
			// Google Fonts as real <link> tags (preconnect + stylesheet) rather than
			// a CSS `@import` inside styles.css — an `@import` is render-blocking for
			// the *whole* stylesheet it lives in, so the page's own (Tailwind) rules
			// only applied once that external font CSS had round-tripped, which read
			// as a flash of totally unstyled content rather than just a font swap.
			// Real `<link>` tags load in parallel with everything else; `display=swap`
			// (already in the URL) still swaps the fallback font in without blocking.
			{
				rel: "preconnect",
				href: "https://fonts.googleapis.com",
			},
			{
				rel: "preconnect",
				href: "https://fonts.gstatic.com",
				crossOrigin: "anonymous",
			},
			{
				rel: "stylesheet",
				href: "https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400..700;1,9..40,400..700&family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;0,9..144,700;1,9..144,400;1,9..144,500;1,9..144,600;1,9..144,700&family=Geist+Mono:wght@400..700&display=swap",
			},
			{
				rel: "stylesheet",
				href: appCss,
			},
			{
				rel: "icon",
				href: "/favicon.svg",
				type: "image/svg+xml",
			},
			{
				rel: "icon",
				href: "/favicon.ico",
				sizes: "any",
			},
			{
				rel: "apple-touch-icon",
				href: "/apple-touch-icon.png",
			},
			{
				rel: "manifest",
				href: "/manifest.json",
			},
		],
	}),
	shellComponent: RootDocument,
});

// Apply the saved (or system) theme before paint so there's no flash of the
// wrong palette. Mirrors charliegleason.com's class-based dark mode.
const themeScript = `(function(){try{var t=localStorage.getItem('theme');var d=t?t==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<HeadContent />
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: tiny inline theme bootstrap, no user input */}
				<script dangerouslySetInnerHTML={{ __html: themeScript }} />
			</head>
			<body className="flex min-h-dvh flex-col">
				<ClerkProvider>
					{import.meta.env.DEV && <ScrollPerfHud />}
					{/* A flex-1 column so a route's content (or a full-height ErrorScreen,
					    which fills with `flex-1`) grows to the available space — the same
					    shell the admin layout provides via its own <main>. The collection
					    filter lives in a provider here, above the router outlet, so it
					    survives the `/` ↔ `/records/$id` route swap when a record opens. */}
					<CollectionUIProvider>
						<div className="flex min-h-0 flex-1 flex-col">{children}</div>
					</CollectionUIProvider>
					<Toaster />
					{/* Dev-only: keep the router/query devtools out of the production bundle. */}
					{import.meta.env.DEV && (
						<TanStackDevtools
							config={{
								position: "bottom-right",
							}}
							plugins={[
								{
									name: "Tanstack Router",
									render: <TanStackRouterDevtoolsPanel />,
								},
								TanStackQueryDevtools,
							]}
						/>
					)}
				</ClerkProvider>
				<Scripts />
			</body>
		</html>
	);
}
