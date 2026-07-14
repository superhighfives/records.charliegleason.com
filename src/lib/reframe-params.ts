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
	 * Auto-tone does the smart per-image correction; these are for taste. The defaults
	 * are a gentle "studio pop" (a little more saturation + contrast) so a fresh capture
	 * looks its best without touching the sliders.
	 */
	saturation?: number;
	contrast?: number;
	gamma?: number;
}

export const DEFAULT_REFRAME_PARAMS: Required<ReframeParams> = {
	skipTone: false,
	wbStrength: 1.0,
	lowPct: 0.005,
	highPct: 0.995,
	saturation: 1.12,
	contrast: 1.08,
	gamma: 1.0,
};

/**
 * A gentler read of the knobs for the alpha matte than the square hero gets: a light
 * touch of white-balance, and the saturation/contrast "studio pop" pulled halfway back
 * to neutral. A strongly-coloured cover (a saturated sleeve) makes the white-patch
 * balance over-correct — a pink cover pushes the reference toward red, greening the
 * midtones — which is jarring on an object floating in space, so the matte wears a much
 * softer white-balance (a quarter of the square's push) to keep that cast off.
 * Shared by the server matte pipeline and the live preview so they match.
 */
export function matteToneFromParams(params: ReframeParams): {
	tone: { wbStrength: number; lowPct: number; highPct: number } | false;
	polish: { saturation: number; contrast: number; gamma: number };
} {
	const p = { ...DEFAULT_REFRAME_PARAMS, ...params };
	const halfway = (v: number) => 1 + (v - 1) * 0.5;
	return {
		tone: p.skipTone
			? false
			: {
					wbStrength: p.wbStrength * 0.25,
					lowPct: p.lowPct,
					highPct: p.highPct,
				},
		polish: {
			saturation: halfway(p.saturation),
			contrast: halfway(p.contrast),
			gamma: p.gamma,
		},
	};
}

/** The numeric knobs, whose values must be finite numbers to be kept. */
const NUMERIC_KEYS = [
	"wbStrength",
	"lowPct",
	"highPct",
	"saturation",
	"contrast",
	"gamma",
] as const;

/**
 * Coerce an arbitrary value into valid {@link ReframeParams}: keep only the known
 * keys, and only when well-typed (a boolean `skipTone`, finite numbers elsewhere).
 * Anything else is dropped, so it falls back to {@link DEFAULT_REFRAME_PARAMS}. Used
 * both to parse stored JSON and to sanitise untrusted API input before it drives the
 * tone math.
 */
export function sanitizeReframeParams(value: unknown): ReframeParams {
	if (!value || typeof value !== "object") return {};
	const v = value as Record<string, unknown>;
	const out: ReframeParams = {};
	if (typeof v.skipTone === "boolean") out.skipTone = v.skipTone;
	for (const k of NUMERIC_KEYS) {
		if (typeof v[k] === "number" && Number.isFinite(v[k]))
			out[k] = v[k] as number;
	}
	return out;
}

/** Parse a stored `professionalParamsJson` string into params (defaults on junk/null). */
export function parseReframeParams(
	json: string | null | undefined,
): ReframeParams {
	if (!json) return {};
	try {
		return sanitizeReframeParams(JSON.parse(json));
	} catch {
		return {};
	}
}
