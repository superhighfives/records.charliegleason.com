/**
 * The container's HTTP entry. One job: `POST /matte` with a capture + band + params, run the
 * render, return the two WebP variants. Fronted by the `MatteContainer` Durable Object in the
 * main Worker (see `src/lib/matte-container.ts`), which is the only caller — so the contract
 * is a small internal JSON envelope (base64 in, base64 out), not a public API.
 */

import { createServer } from "node:http";

import { type MatteMode, renderMatte } from "./matte.ts";

const PORT = Number(process.env.PORT ?? 8080);

interface MatteRequest {
	capture: string; // base64 capture bytes
	band: unknown;
	params: unknown;
	mode: MatteMode;
	replicateToken?: string;
}

function isMatteRequest(v: unknown): v is MatteRequest {
	if (typeof v !== "object" || v === null) return false;
	const r = v as Record<string, unknown>;
	return (
		typeof r.capture === "string" &&
		(r.mode === "ai" || r.mode === "deterministic") &&
		typeof r.band === "object" &&
		r.band !== null
	);
}

async function readBody(
	req: import("node:http").IncomingMessage,
): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
	if (req.method === "GET" && req.url === "/health") {
		res.writeHead(200, { "content-type": "text/plain" }).end("ok");
		return;
	}
	if (req.method !== "POST" || req.url !== "/matte") {
		res.writeHead(404).end("not found");
		return;
	}
	try {
		const parsed: unknown = JSON.parse((await readBody(req)).toString("utf8"));
		if (!isMatteRequest(parsed)) {
			res
				.writeHead(400, { "content-type": "application/json" })
				.end(JSON.stringify({ error: "bad matte request" }));
			return;
		}
		const out = await renderMatte({
			capture: new Uint8Array(Buffer.from(parsed.capture, "base64")),
			// Trusted internal caller (the Worker DO); shapes match the shared types.
			band: parsed.band as never,
			params: (parsed.params ?? {}) as never,
			mode: parsed.mode,
			replicateToken: parsed.replicateToken,
		});
		res.writeHead(200, { "content-type": "application/json" }).end(
			JSON.stringify({
				source: out.source,
				shadow: out.shadow.toString("base64"),
				cutout: out.cutout.toString("base64"),
			}),
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[matte-container] render failed: ${message}`);
		res
			.writeHead(500, { "content-type": "application/json" })
			.end(JSON.stringify({ error: message }));
	}
});

server.listen(PORT, () => {
	console.log(`[matte-container] listening on :${PORT}`);
});
