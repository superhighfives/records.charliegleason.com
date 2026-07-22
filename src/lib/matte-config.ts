/**
 * The matte render's tunable constants + derived options, kept in their own pure,
 * dependency-free module (no `cloudflare:workers`, no Photon) so BOTH the Worker matte
 * pipeline (`matte.ts`) and the standalone matte container (`containers/matte/`) share a
 * single source of truth. Nothing here touches a binding — it's numbers + a small helper —
 * so tuning a value moves both renderers in lockstep and they can't drift.
 *
 * The prose behind each knob lives next to the code that reads it in `matte.ts`; this file
 * is deliberately just the values.
 */

import type { MatteOptions, ShadowOptions } from "#/lib/photo-processing";
import { matteToneFromParams, type ReframeParams } from "#/lib/reframe-params";

/** Master resolution for the matte canvas. */
export const CANVAS_SIZE = 2400;
/** Transparent margin each side (fraction of the canvas) left for the contact shadow. */
export const MARGIN = 0.02;
/** The sleeve fills the canvas minus the shadow margins. */
export const CONTENT_SIZE = Math.round(CANVAS_SIZE * (1 - 2 * MARGIN));
/** Edge feather (content scale). */
export const FEATHER = 2;
/** Tight, dark down-right contact shadow (canvas scale). */
export const SHADOW: ShadowOptions = {
	blur: Math.round(CANVAS_SIZE * 0.006),
	offsetX: Math.round(CANVAS_SIZE * 0.002),
	offsetY: Math.round(CANVAS_SIZE * 0.004),
	opacity: 0.55,
};

/** Deskewed square (sleeve + wood margin) fed to the matting model. */
export const MODEL_SIZE = 1600;
export const MODEL_PAD = 0.2;

/** Low-confidence edge clamp inset (a hair inside the band midline). */
export const CLAMP_LOWCONF_INSET = Math.round(MODEL_SIZE * 0.004);
/** Colour-veto policing depth + sample-ring width, and the foreground ring's inset. */
export const VETO_DEPTH = Math.round(MODEL_SIZE * 0.02);
export const VETO_RING = Math.round(MODEL_SIZE * 0.02);
export const VETO_FG_INSET = Math.round(MODEL_SIZE * 0.005);

/** Colour bleed into the transparent margin before the warp (kills the wood fringe). */
export const MATTE_BLEED = 10;
/** How far the sleeve is straightened toward a perfect upright rectangle (0…1). */
export const MATTE_STRAIGHTEN = 0.5;
/** Resolution the matting model computes its alpha at (its `max_size` input). */
export const MATTE_MODEL_MAX_SIZE = 2048;
/** Cap for the ESRGAN super-resolve of the opaque sleeve+wood content on the AI path. */
export const MATTE_ESRGAN_MAX = 2200;

/**
 * The pinned matting model version (Replicate) — our own ViTMatte cog
 * (`superhighfives/vitmatte-trimap`). Pinned so the input schema can't shift under us.
 */
export const MATTE_MODEL_VERSION =
	"193b4b013b262e9b64e57755d38ff82e497dd2f14537e2e274bc553a28c03237";

/** Build the shared matte options from the record's reframe knobs (softened grade). */
export function matteOptions(params: ReframeParams): MatteOptions {
	const { tone, polish } = matteToneFromParams(params);
	return {
		canvasSize: CANVAS_SIZE,
		contentSize: CONTENT_SIZE,
		feather: FEATHER,
		tone,
		polish,
		shadow: SHADOW,
		straighten: MATTE_STRAIGHTEN,
		bleed: MATTE_BLEED,
	};
}
