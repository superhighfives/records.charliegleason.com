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
import type { CornerBand } from "#/lib/sleeve-corners";

/**
 * Spread matte jobs across a small pool. Containers don't autoscale, and a capture session
 * bursts several Applies at once, so `getRandom` load-balances over N instances. Matches
 * `max_instances` in wrangler.jsonc.
 */
const MATTE_CONTAINER_INSTANCES = 3;

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
	// Only bound in production; the caller (renderAiMatte / renderDeterministicMatte) checks
	// presence before routing here, so this guard is just for the type + a clear failure.
	const binding = env.MATTE_CONTAINER;
	if (!binding) throw new Error("MATTE_CONTAINER binding is not configured");
	const stub = await getRandom(binding, MATTE_CONTAINER_INSTANCES);
	const res = await stub.fetch("http://matte-container/matte", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			capture: bytesToBase64(input.capture),
			band: input.band,
			params: input.params,
			mode: input.mode,
			// The container has no secret binding; hand it the token only when it needs one.
			replicateToken: input.mode === "ai" ? env.REPLICATE_API_KEY : undefined,
		}),
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
