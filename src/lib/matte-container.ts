/**
 * The Worker side of the matte container: the `MatteContainer` Durable Object (which fronts
 * the container image in `containers/matte/`) plus the thin client the matte pipeline calls.
 * The container is a pure image function — it never touches R2/DB — so this module owns the
 * transport (base64 JSON in/out) and passes the Replicate token in per-request; R2 + the DB
 * commit stay in the Worker (see `matte.ts#generateMatteViaContainer`).
 */

import { env } from "cloudflare:workers";
import { Container, getRandom } from "@cloudflare/containers";

import { base64ToBytes, bytesToBase64 } from "#/lib/image-data";
import type { ReframeParams } from "#/lib/reframe-params";
import {
	isDurableObjectReset,
	NonRetryableError,
	withRetry,
} from "#/lib/retry";
import type { CornerBand } from "#/lib/sleeve-corners";

/**
 * Spread matte jobs across a small pool. Containers don't autoscale, and a capture session
 * bursts several Applies at once, so `getRandom` load-balances over N instances. Matches
 * `max_instances` in wrangler.jsonc.
 */
const MATTE_CONTAINER_INSTANCES = 3;

/**
 * A DO reset is transient, so retry the container call a couple of times before giving up to the
 * queue's outer retry / fallback. 3 attempts with a 300ms base → ~300ms then ~600ms of backoff
 * (via {@link withRetry}'s exponential schedule), matching the earlier hand-rolled loop.
 */
const MATTE_CONTAINER_ATTEMPTS = 3;
const MATTE_CONTAINER_RETRY_BASE_MS = 300;

/** The container Durable Object. Config (image, instance type) lives in wrangler.jsonc. */
export class MatteContainer extends Container<Cloudflare.Env> {
	defaultPort = 8080;
	// A matte run is well under a minute, but a capture session fires several in a row —
	// keep the instance warm between them so only the first pays the ~2-3s cold start.
	sleepAfter = "10m";
	// Outbound needed for the Replicate calls (ViTMatte + ESRGAN) and the model-output fetch.
	enableInternet = true;
}

export interface ContainerMatte {
	source: "ai" | "deterministic";
	shadow: Uint8Array;
	cutout: Uint8Array;
}

/**
 * POST to the matte container, retrying the transient Durable Object reset. A matte/enhance run
 * holds the Container DO open across Replicate polling (up to two 120s models), which can trip
 * the DO's ~30s storage-op timeout and reset it mid-request ("…caused object to be reset"). That
 * reset is transient and loses only in-memory state, so {@link withRetry} re-runs the request
 * with a fresh stub; any other failure is a {@link NonRetryableError} so it surfaces at once and
 * lets the caller's throw hand off to the queue's retry / deterministic fallback.
 */
async function postToContainer(path: string, body: unknown): Promise<Response> {
	// Only bound in production; the callers check presence before routing here, so this guard
	// is just for the type + a clear failure.
	const binding = env.MATTE_CONTAINER;
	if (!binding) throw new Error("MATTE_CONTAINER binding is not configured");
	const payload = JSON.stringify(body);
	return withRetry(
		async () => {
			// A fresh stub per attempt: getRandom re-picks an instance, so a reset DO isn't reused.
			const stub = await getRandom(binding, MATTE_CONTAINER_INSTANCES);
			try {
				return await stub.fetch(`http://matte-container${path}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: payload,
				});
			} catch (err) {
				if (isDurableObjectReset(err)) throw err;
				throw new NonRetryableError(
					err instanceof Error ? err.message : String(err),
				);
			}
		},
		{
			attempts: MATTE_CONTAINER_ATTEMPTS,
			baseMs: MATTE_CONTAINER_RETRY_BASE_MS,
		},
	);
}

/**
 * Render one matte in the container and get back the two webp variants. `mode: "ai"` runs the
 * paid path and rejects on failure (the queue decides retry vs. the deterministic fallback,
 * exactly as the in-Worker path does); `mode: "deterministic"` runs the free silhouette.
 */
export async function renderMatteInContainer(input: {
	capture: Uint8Array;
	band: CornerBand;
	params: ReframeParams;
	mode: "ai" | "deterministic";
}): Promise<ContainerMatte> {
	const res = await postToContainer("/matte", {
		capture: bytesToBase64(input.capture),
		band: input.band,
		params: input.params,
		mode: input.mode,
		// The container has no secret binding; hand it the token only when it needs one.
		replicateToken: input.mode === "ai" ? env.REPLICATE_API_KEY : undefined,
	});
	if (!res.ok) {
		throw new Error(`matte container ${res.status}: ${await res.text()}`);
	}
	const json = (await res.json()) as {
		source: "ai" | "deterministic";
		shadow: string;
		cutout: string;
	};
	return {
		source: json.source,
		shadow: base64ToBytes(json.shadow),
		cutout: base64ToBytes(json.cutout),
	};
}

/**
 * Enhance a reframed cover in the container: Real-ESRGAN super-resolution + the bounded lossy
 * WebP encode, done with the container's sharp pipeline instead of the (load-flaky) Cloudflare
 * Images binding. Takes the reframed-cover bytes, returns the WebP master bytes for the Worker
 * to store in R2. Mirrors {@link renderMatteInContainer}'s transport (base64 JSON in/out).
 */
export async function enhanceCoverInContainer(input: {
	image: Uint8Array;
}): Promise<Uint8Array> {
	const res = await postToContainer("/enhance", {
		image: bytesToBase64(input.image),
		replicateToken: env.REPLICATE_API_KEY,
	});
	if (!res.ok) {
		throw new Error(`enhance container ${res.status}: ${await res.text()}`);
	}
	const json = (await res.json()) as { webp: string };
	return base64ToBytes(json.webp);
}
