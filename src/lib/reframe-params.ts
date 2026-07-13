/**
 * The tweakable knobs for the (free) reframe step of the professional-photo
 * pipeline, kept in their own dependency-free module so both the server pipeline
 * (`professional.ts`, which pulls in `cloudflare:workers` + Photon) and the admin
 * client route can share the type, defaults and parser without dragging server-only
 * code into the browser bundle.
 */

export interface ReframeParams {
	/** Bypass auto-tone entirely, keeping the warped capture's original exposure. */
	skipTone?: boolean;
	/** Grey-world white-balance strength, 0 (off) … 1 (full). */
	wbStrength?: number;
	/** Levels low/high clip percentiles (e.g. 0.005 / 0.995). */
	lowPct?: number;
	highPct?: number;
	/** Transparent margin on each side, as a % of the canvas (0 … ~6). */
	marginPct?: number;
}

export const DEFAULT_REFRAME_PARAMS: Required<ReframeParams> = {
	skipTone: false,
	wbStrength: 1.0,
	lowPct: 0.005,
	highPct: 0.995,
	marginPct: 2,
};

/** Parse a stored `professionalParamsJson` string into params (defaults on junk/null). */
export function parseReframeParams(
	json: string | null | undefined,
): ReframeParams {
	if (!json) return {};
	try {
		const p = JSON.parse(json) as ReframeParams;
		return p && typeof p === "object" ? p : {};
	} catch {
		return {};
	}
}
