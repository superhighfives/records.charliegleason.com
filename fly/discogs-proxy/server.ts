// Tiny reverse proxy for the Discogs API, deployed to Fly.io so lookups go out
// from a dedicated egress IP instead of the Worker's shared Cloudflare pool —
// that shared pool is what Discogs actually rate-limits (see src/lib/discogs.ts).
// Holds the real DISCOGS_TOKEN; callers authenticate with a separate shared
// secret (X-Proxy-Secret) so the token itself never leaves this machine.

const PORT = Number(process.env.PORT ?? 8080);
const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN;
const PROXY_SECRET = process.env.PROXY_SECRET;
const DISCOGS_BASE = "https://api.discogs.com";
const USER_AGENT =
	"RecordsCharlieGleasonCom/1.0 +https://records.charliegleason.com";

if (!DISCOGS_TOKEN || !PROXY_SECRET) {
	throw new Error("DISCOGS_TOKEN and PROXY_SECRET must both be set");
}

// Response headers worth forwarding to the caller; everything else (Discogs'
// own rate-limit accounting headers etc.) is dropped rather than relayed.
const FORWARD_RESPONSE_HEADERS = ["content-type", "retry-after"];

Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);

		if (url.pathname === "/health") return new Response("ok");

		if (req.headers.get("x-proxy-secret") !== PROXY_SECRET) {
			return new Response("unauthorized", { status: 401 });
		}
		if (req.method !== "GET") {
			return new Response("method not allowed", { status: 405 });
		}

		const upstream = new URL(url.pathname + url.search, DISCOGS_BASE);
		const res = await fetch(upstream, {
			headers: {
				"User-Agent": USER_AGENT,
				Authorization: `Discogs token=${DISCOGS_TOKEN}`,
			},
		});

		const headers = new Headers();
		for (const name of FORWARD_RESPONSE_HEADERS) {
			const value = res.headers.get(name);
			if (value) headers.set(name, value);
		}
		return new Response(res.body, { status: res.status, headers });
	},
});

console.log(`discogs-proxy listening on :${PORT}`);
