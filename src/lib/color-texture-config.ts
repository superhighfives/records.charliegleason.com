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
// procedural grooves/spindle hole, so it only needs to read as a seamless-ish patch
// of the color/material at a middling resolution (it's tiled behind grooves, never
// shown edge-to-edge at full size).
export const COLOR_TEXTURE_SIZE = 512;

/**
 * Build the generation prompt from a color's display name (e.g. "Black",
 * "Red/Blue Splatter", "Clear"). Kept deliberately literal/photographic — this is a
 * material reference, not album art.
 */
export function colorTexturePrompt(colorName: string): string {
	return (
		`extreme close-up top-down photo of the flat playing surface of a vinyl record, ` +
		`colored: ${colorName}. Studio lighting, seamless texture, no label, no text, ` +
		`no spindle hole, fills the entire frame edge to edge.`
	);
}
