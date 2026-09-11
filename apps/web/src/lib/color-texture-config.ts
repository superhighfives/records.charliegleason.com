/**
 * Vinyl color texture generation — tunable constants, kept in their own pure module
 * (no `cloudflare:workers`) alongside the other `*-config.ts` files (see
 * `esrgan-config.ts`, `matte-config.ts`).
 */

// black-forest-labs/flux-schnell — a first-party Replicate "official model". Unlike
// the custom/community models elsewhere in this app (pinned to a version hash so
// their input schema can't shift under us), official models are referenced by
// owner/name and Replicate always resolves them to its own latest version — there is
// no hash to pin. Fast + cheap, appropriate for a low-stakes texture swatch.
export const COLOR_TEXTURE_MODEL = "black-forest-labs/flux-schnell";

// A flat material swatch, not a full disc render — VinylDisc composites this with
// procedural grooves/spindle hole, so it doesn't need to be huge, but 1024 gives a
// bit of headroom for the swatch to be zoomed/cropped in VinylDisc's pattern fill
// without visibly softening. Square: both the Replicate generation (aspect_ratio
// "1:1" in color-texture.ts) and a manual upload (color-texture-upload.ts) are
// cropped/resized to exactly this via the Images binding.
export const COLOR_TEXTURE_SIZE = 1024;

/**
 * Build the generation prompt from a color's display name (e.g. "Black",
 * "Red/Blue Splatter", "Clear"). Kept deliberately literal/photographic — this is a
 * material reference, not album art.
 */
export function colorTexturePrompt(colorName: string): string {
	// Steer hard AWAY from rendering a whole record: naming "vinyl record" makes
	// the model paint the entire disc — shape, centre label, spindle hole, white
	// backdrop — but VinylDisc supplies all of that itself and only needs the raw
	// coloured surface. So we ask for a flat, seamless, frame-filling MATERIAL
	// swatch and explicitly forbid every whole-object cue.
	return (
		`Seamless flat macro texture swatch of ${colorName} vinyl material — the raw ` +
		`coloured record plastic surface only, filling the entire frame edge to edge ` +
		`with no background. Extreme close-up, top-down, even studio lighting, subtle ` +
		`groove sheen. Absolutely no disc shape, no round record, no edges or rim, no ` +
		`centre label, no spindle hole, no text — just a continuous flat surface.`
	);
}
