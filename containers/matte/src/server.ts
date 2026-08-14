/**
 * The container's HTTP entry. One job: `POST /matte` with a capture + band + params, run the
 * render, return the two WebP variants. Fronted by the `MatteContainer` Durable Object in the
 * main Worker (see `src/lib/matte-container.ts`), which is the only caller — so the contract
 * is a small internal JSON envelope (base64 in, base64 out), not a public API.
 */

import { createServer } from "node:http";

import { upscaleCoverToWebp } from "./image-io.ts";
import { type MatteMode, renderMatte } from "./matte.ts";

const PORT = Number(process.env.PORT ?? 8080);

// Node's default for both is to kill the process — which aborts EVERY in-flight
// render on this instance, surfaces in the Worker as an uncatchable "Container port
// connection closed unexpectedly", and (because no catch block ever runs) leaves the
// queue rows to the reaper with no recorded reason. A stray rejection from a fetch
// body or a sharp worker isn't worth that blast radius in a stateless image server:
// log it and keep serving. A genuinely broken process state still exits via
// uncaughtException below, after the log gives the crash a trace.
process.on("unhandledRejection", (reason) => {
	console.error("[matte-container] unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
	console.error("[matte-container] uncaught exception, exiting:", err);
	process.exit(1);
});

/**
 * Serialize the heavy renders. A matte run peaks at hundreds of MB (full-capture RGBA
 * buffers + the deskew), and the Worker's `getRandom` load-balancing can land two jobs
 * on the same instance — co-located peaks are the likely OOM that kills the process
 * mid-request. One job at a time per instance trades a little queueing latency for
 * never losing both jobs to a memory kill.
 */
let jobChain: Promise<unknown> = Promise.resolve();
function serialize<T>(job: () => Promise<T>): Promise<T> {
	const next = jobChain.then(job, job);
	jobChain = next.catch(() => {});
	return next;
}

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

interface EnhanceRequest {
	image: string; // base64 reframed-cover bytes
	replicateToken: string;
}

function isEnhanceRequest(v: unknown): v is EnhanceRequest {
	if (typeof v !== "object" || v === null) return false;
	const r = v as Record<string, unknown>;
	return typeof r.image === "string" && typeof r.replicateToken === "string";
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
	if (req.method !== "POST") {
		res.writeHead(404).end("not found");
		return;
	}
	try {
		if (req.url === "/matte") {
			const parsed: unknown = JSON.parse(
				(await readBody(req)).toString("utf8"),
			);
			if (!isMatteRequest(parsed)) {
				res
					.writeHead(400, { "content-type": "application/json" })
					.end(JSON.stringify({ error: "bad matte request" }));
				return;
			}
			const out = await serialize(() =>
				renderMatte({
					capture: new Uint8Array(Buffer.from(parsed.capture, "base64")),
					// Trusted internal caller (the Worker DO); shapes match the shared types.
					band: parsed.band as never,
					params: (parsed.params ?? {}) as never,
					mode: parsed.mode,
					replicateToken: parsed.replicateToken,
				}),
			);
			res.writeHead(200, { "content-type": "application/json" }).end(
				JSON.stringify({
					source: out.source,
					shadow: out.shadow.toString("base64"),
					cutout: out.cutout.toString("base64"),
				}),
			);
			return;
		}
		if (req.url === "/enhance") {
			const parsed: unknown = JSON.parse(
				(await readBody(req)).toString("utf8"),
			);
			if (!isEnhanceRequest(parsed)) {
				res
					.writeHead(400, { "content-type": "application/json" })
					.end(JSON.stringify({ error: "bad enhance request" }));
				return;
			}
			const webp = await serialize(() =>
				upscaleCoverToWebp(
					new Uint8Array(Buffer.from(parsed.image, "base64")),
					parsed.replicateToken,
				),
			);
			res
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify({ webp: webp.toString("base64") }));
			return;
		}
		res.writeHead(404).end("not found");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[matte-container] request failed: ${message}`);
		res
			.writeHead(500, { "content-type": "application/json" })
			.end(JSON.stringify({ error: message }));
	}
});

server.listen(PORT, () => {
	console.log(`[matte-container] listening on :${PORT}`);
});
