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
	/** White-patch white-balance strength, 0 (off) … 1 (full). */
	wbStrength?: number;
	/** Levels low/high clip percentiles (e.g. 0.005 / 0.995). */
	lowPct?: number;
	highPct?: number;
	/**
	 * Final "polish" factors applied on the Cloudflare Images encode pass, *after*
	 * the foreground-aware auto-tone — blunt global multipliers where 1.0 = no change.
	 * Auto-tone does the smart per-image correction; these are for taste.
	 */
	saturation?: number;
	contrast?: number;
	gamma?: number;
	/** Transparent margin on each side, as a % of the canvas (0 … ~6). */
	marginPct?: number;
}

export const DEFAULT_REFRAME_PARAMS: Required<ReframeParams> = {
	skipTone: false,
	wbStrength: 1.0,
	lowPct: 0.005,
	highPct: 0.995,
	saturation: 1.0,
	contrast: 1.0,
	gamma: 1.0,
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
