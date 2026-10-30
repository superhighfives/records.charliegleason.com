import * as THREE from "three";

/**
 * The cover material, with a choice of shader transitions for when a record
 * appears (prototype: switch between them live from the wall's reveal panel).
 * Nothing is drawn until the record's image is ready; then, as `uReveal`
 * goes from 0 to 1, one of:
 *
 * - **wax** — melts down the sleeve from the top like warm wax: rounded drips
 *   running ahead, the image dragged into them, a darker wet lip, a wobble
 *   that settles out.
 * - **ripple** — emerges from the centre outward (a rounded square) like a
 *   picture rising through water, rings of refraction behind its edge.
 * - **develop** — fades up from a dim, washed-out, soft image to full colour
 *   and focus, like a print developing.
 * - **pixels** — resolves from coarse blocks that pop in at random, the
 *   blocks shrinking to nothing.
 * - **blinds** — horizontal slats, each opening downward, staggered.
 * - **focus** — fades in from blurred, with colour fringing, to sharp.
 * - **unfold** — opens like a sleeve folded in four, panel by panel from the
 *   top, each one foreshortened and shaded until it lies flat.
 * - **bloom** — a blown-out, glowing flash from the middle that cools down to
 *   the photo, like a light coming up through it.
 * - **polaroid** — instant film: a murky grey-green plate in a white frame;
 *   the shadows come up first, then colour from a cold cast to warm, and the
 *   frame shrinks away.
 * - **smoke** — the picture gathers out of curling smoke, soft edged and
 *   swirled, the swirl settling as it thickens.
 * - **dust** — settles out of fine specks, bottom up like sand, each one
 *   glinting as it lands, then closes up solid.
 * - **ink** — blooms from a few drops, like ink in water, the edges feathered
 *   and the colour bleeding in.
 * - **glitch** — tears in on a bad signal: slipping bands, split channels and
 *   blocky dropouts that lock into place.
 * - **streak** — a motion blur along the scroll: the picture smears in from
 *   its leading edge, streaked the way it's travelling, and comes to rest
 *   sharp.
 *
 * Every style follows the scroll (`uDir`): written for scrolling down — a
 * record rising into view, its top edge first — and flipped top to bottom
 * when scrolling up, so a reveal always starts from the edge that arrived
 * first. (Polaroid keeps its frame the right way up.)
 *
 * It's the standard lit material (lighting, shadows, the matte finish) with
 * its `map` step patched via `onBeforeCompile`; every cover shares one
 * program and picks its style with the `uMode` uniform. Covers also carry a
 * share of self-light (`uSelfLight`) so they stay true to their photos.
 */

export const REVEAL_STYLES = [
	"wax",
	"ripple",
	"develop",
	"pixels",
	"blinds",
	"focus",
	"unfold",
	"bloom",
	"polaroid",
	"smoke",
	"dust",
	"ink",
	"glitch",
	"streak",
] as const;
export type RevealStyle = (typeof REVEAL_STYLES)[number];

type RevealUniforms = {
	uReveal: { value: number };
	uMode: { value: number };
	/** 1 scrolling down (top edge first), -1 scrolling up (bottom first). */
	uDir: { value: number };
	uPlaceholder: { value: THREE.Color };
	/** Per record, so no two covers reveal the same way. */
	uSeed: { value: number };
	/**
	 * How much of the cover lights itself (its own image as glow). Lit only
	 * by a dim room, covers came out dark, contrasty and muddy next to the
	 * same photos on the plain grid; a share of self-light keeps them close
	 * to their true colours, with the room's lighting as shading on top.
	 */
	uSelfLight: { value: number };
};

const HEADER_GLSL = /* glsl */ `
	uniform float uReveal;
	uniform float uMode;
	uniform float uDir;
	// Shapes are worked out in a space flipped with the scroll direction;
	// sampling flips back, so the picture itself is never upside down.
	float revealFlip;
	uniform vec3 uPlaceholder;
	uniform float uSeed;
	uniform float uSelfLight;
	float revealHash(vec2 p) {
		return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
	}
	float revealNoise1(float x) {
		float i = floor(x);
		float f = fract(x);
		float a = fract(sin(i * 127.1) * 43758.5453);
		float b = fract(sin((i + 1.0) * 127.1) * 43758.5453);
		return mix(a, b, f * f * (3.0 - 2.0 * f));
	}
	vec3 revealSample(sampler2D tex, vec2 uv) {
		vec2 s = clamp(uv, 0.0, 1.0);
		if (revealFlip > 0.5) s.y = 1.0 - s.y;
		return texture2D(tex, s).rgb;
	}
	// A cheap soft blur: the centre plus four diagonal taps.
	vec3 revealBlur(sampler2D tex, vec2 uv, float r) {
		vec3 c = revealSample(tex, uv) * 0.4;
		c += revealSample(tex, uv + vec2(r, r)) * 0.15;
		c += revealSample(tex, uv + vec2(-r, r)) * 0.15;
		c += revealSample(tex, uv + vec2(r, -r)) * 0.15;
		c += revealSample(tex, uv + vec2(-r, -r)) * 0.15;
		return c;
	}
	float revealNoise2(vec2 p) {
		vec2 i = floor(p);
		vec2 f = fract(p);
		vec2 u = f * f * (3.0 - 2.0 * f);
		return mix(
			mix(revealHash(i), revealHash(i + vec2(1.0, 0.0)), u.x),
			mix(revealHash(i + vec2(0.0, 1.0)), revealHash(i + vec2(1.0, 1.0)), u.x),
			u.y
		);
	}
	float revealFbm(vec2 p) {
		float v = 0.0;
		float a = 0.5;
		for (int i = 0; i < 4; i++) {
			v += revealNoise2(p) * a;
			p = p * 2.03 + 17.0;
			a *= 0.5;
		}
		return v;
	}
`;

const MAP_GLSL = /* glsl */ `
	vec3 coverSelf = vec3(0.0);
	#ifdef USE_MAP
		float t = uReveal;
		vec2 uv = vMapUv;
		revealFlip = uDir < 0.0 && (uMode < 7.5 || uMode > 8.5) ? 1.0 : 0.0;
		if (revealFlip > 0.5) uv.y = 1.0 - uv.y;
		vec3 img;
		float alpha = 1.0;
		float settle = 1.0 - smoothstep(0.55, 1.0, t);

		if (t >= 0.999) {
			// Done: just the photo. (Most covers, most of the time — and the
			// styles below can cost a dozen texture reads a pixel.)
			img = revealSample(map, uv);
		} else if (uMode < 0.5) {
			// wax
			float down = 1.0 - uv.y;
			float x = uv.x;
			float drip = (sin(x * 11.0 + uSeed) * 0.5 + 0.5) * 0.14
				+ (sin(x * 23.0 + uSeed * 1.7) * 0.5 + 0.5) * 0.09
				+ (sin(x * 41.0 + uSeed * 2.3) * 0.5 + 0.5) * 0.05
				+ revealNoise1(x * 17.0 + uSeed) * 0.05;
			float behind = t * 1.55 - drip - down;
			if (behind < 0.0) discard;
			float drag = (1.0 - smoothstep(0.0, 0.35, behind)) * 0.22 * settle;
			vec2 s = uv;
			s.y += drag;
			s.x += sin(uv.y * 17.0 + t * 9.0) * 0.012 * settle;
			s.y += sin(uv.x * 13.0 + t * 7.0) * 0.008 * settle;
			float lip = 1.0 - smoothstep(0.0, 0.05, behind);
			img = revealSample(map, s) * (1.0 - lip * 0.35 * settle);
		} else if (uMode < 1.5) {
			// ripple
			vec2 c = uv - 0.5;
			vec2 q = abs(c) * 2.0;
			float dist = pow(pow(q.x, 4.0) + pow(q.y, 4.0), 0.25);
			float angle = atan(c.y, c.x);
			float wobble = (sin(angle * 5.0 + uSeed) * 0.5 + 0.5) * 0.03
				+ revealNoise1(angle * 3.0 + uSeed) * 0.02;
			float radius = smoothstep(0.0, 0.75, t) * 1.3 - wobble * settle;
			if (dist > radius) discard;
			float behindEdge = radius - dist;
			float ring = sin(behindEdge * 38.0 - t * 14.0)
				* (1.0 - smoothstep(0.0, 0.45, behindEdge));
			vec2 dir = length(c) > 0.0001 ? c / length(c) : vec2(0.0);
			vec2 s = uv + dir * ring * 0.022 * settle;
			vec2 split = dir * 0.006 * settle * (1.0 - smoothstep(0.0, 0.3, behindEdge));
			img = vec3(
				revealSample(map, s + split).r,
				revealSample(map, s).g,
				revealSample(map, s - split).b
			);
		} else if (uMode < 2.5) {
			// develop
			float k = smoothstep(0.0, 1.0, t);
			vec3 soft = revealBlur(map, uv, 0.02 * (1.0 - k));
			float lum = dot(soft, vec3(0.299, 0.587, 0.114));
			vec3 washed = mix(vec3(lum), soft, 0.35) * 0.55 + 0.08;
			img = mix(washed, soft, smoothstep(0.25, 1.0, t));
			alpha = smoothstep(0.0, 0.35, t);
		} else if (uMode < 3.5) {
			// pixels
			float blocks = mix(6.0, 220.0, t * t);
			vec2 cell = floor(uv * blocks);
			float appear = revealHash(cell + uSeed);
			if (appear > t * 1.4) discard;
			vec2 s = mix((cell + 0.5) / blocks, uv, smoothstep(0.75, 1.0, t));
			img = revealSample(map, s);
		} else if (uMode < 4.5) {
			// blinds
			float slats = 9.0;
			float slat = floor((1.0 - uv.y) * slats);
			float within = fract((1.0 - uv.y) * slats);
			float open = clamp(t * 1.7 - slat / slats * 0.7, 0.0, 1.0);
			if (within > open) discard;
			// Each slat's image slides down into place as it opens.
			vec2 s = uv;
			s.y += (1.0 - open) * (1.0 / slats) * 0.6;
			img = revealSample(map, s) * mix(0.7, 1.0, open);
		} else if (uMode < 5.5) {
			// focus
			float k = smoothstep(0.0, 1.0, t);
			float r = 0.035 * (1.0 - k);
			vec2 split = vec2(0.01 * (1.0 - k), 0.0);
			img = vec3(
				revealBlur(map, uv + split, r).r,
				revealBlur(map, uv, r).g,
				revealBlur(map, uv - split, r).b
			);
			alpha = smoothstep(0.0, 0.5, t);
		} else if (uMode < 6.5) {
			// unfold: four panels, folded accordion-style, opening top down.
			float down = 1.0 - uv.y;
			float top = 0.0;
			float found = -1.0;
			float local = 0.0;
			float open = 0.0;
			for (int k = 0; k < 4; k++) {
				float fk = float(k);
				float o = smoothstep(0.0, 1.0, clamp(t * 1.9 - fk * 0.3, 0.0, 1.0));
				// Foreshortened: a panel at angle a shows cos(a) of its height.
				float h = 0.25 * sin(o * 1.5708);
				if (found < 0.0 && down >= top && down < top + h) {
					found = fk;
					local = (down - top) / max(h, 0.0001);
					open = o;
				}
				top += h;
			}
			if (found < 0.0) discard;
			vec2 s = vec2(uv.x, 1.0 - (found + local) * 0.25);
			// Alternate panels face toward and away from the light as they turn.
			float lit = mod(found, 2.0) < 0.5
				? mix(1.25, 1.0, open)
				: mix(0.45, 1.0, open);
			// A soft crease shadow at each fold.
			float crease = 1.0 - (1.0 - smoothstep(0.0, 0.08, local)) * 0.3 * (1.0 - open);
			img = revealSample(map, s) * lit * crease;
		} else if (uMode < 7.5) {
			// bloom
			float k = smoothstep(0.0, 1.0, t);
			float d = length(uv - 0.5);
			float glow = (1.0 - k) * (1.0 - k);
			float core = 1.0 - smoothstep(0.0, mix(0.2, 1.2, k), d);
			vec3 soft = revealBlur(map, uv, 0.03 * glow);
			img = soft + glow * (soft * 2.2 + vec3(0.35, 0.3, 0.25)) * core;
			alpha = smoothstep(0.0, 0.3, t) * smoothstep(-0.05, 0.25, core + k - 0.2);
		} else if (uMode < 8.5) {
			// polaroid
			float k = smoothstep(0.0, 1.0, t);
			// The white frame, its wide bottom lip, shrinking off the edges.
			float side = 0.07 * (1.0 - smoothstep(0.55, 1.0, t));
			float bottom = side * 3.2;
			vec2 inner = vec2(
				(uv.x - side) / (1.0 - 2.0 * side),
				(uv.y - bottom) / (1.0 - side - bottom)
			);
			if (inner.x < 0.0 || inner.x > 1.0 || inner.y < 0.0 || inner.y > 1.0) {
				img = vec3(0.93, 0.92, 0.88);
			} else {
				vec3 photo = revealSample(map, inner);
				float lum = dot(photo, vec3(0.299, 0.587, 0.114));
				vec3 plate = vec3(0.16, 0.19, 0.18);
				// Shadows first: contrast arrives before colour.
				vec3 tone = mix(plate, plate + (vec3(lum) - 0.25) * 0.9, smoothstep(0.0, 0.45, k));
				vec3 cold = photo * vec3(0.8, 0.95, 1.1) * 0.9;
				vec3 c = mix(tone, cold, smoothstep(0.3, 0.75, k));
				img = mix(c, photo, smoothstep(0.65, 1.0, k));
			}
			alpha = smoothstep(0.0, 0.15, t);
		} else if (uMode < 9.5) {
			// smoke
			float settle2 = 1.0 - smoothstep(0.4, 1.0, t);
			vec2 p = uv * 3.0 + uSeed;
			vec2 warp = vec2(
				revealFbm(p + vec2(0.0, t * 1.5)),
				revealFbm(p + vec2(5.2, -t * 1.3))
			) - 0.5;
			vec2 s = uv + warp * 0.18 * settle2;
			float n = revealFbm(s * 4.0 + uSeed + t * 0.8);
			float density = smoothstep(n - 0.25, n + 0.25, t * 1.5 - 0.25);
			if (density <= 0.01) discard;
			vec3 photo = revealBlur(map, s, 0.02 * settle2);
			vec3 smoke = vec3(dot(photo, vec3(0.33))) * 0.6 + 0.15;
			img = mix(smoke, photo, smoothstep(0.25, 0.9, t));
			alpha = density;
		} else if (uMode < 10.5) {
			// dust
			float grains = 110.0;
			vec2 cell = floor(uv * grains);
			vec2 within = fract(uv * grains) - 0.5;
			// The leading edge settles first, with scatter.
			float land = (1.0 - uv.y) * 0.55 + revealHash(cell + uSeed) * 0.35;
			float since = t * 1.25 - land;
			if (since < 0.0) discard;
			float r = mix(0.22, 0.75, smoothstep(0.0, 0.25, since));
			float fill = smoothstep(0.82, 1.0, t);
			if (length(within) > r && fill < 0.5) discard;
			vec3 photo = revealSample(map, (cell + 0.5) / grains);
			photo = mix(photo, revealSample(map, uv), fill);
			float glint = 1.0 - smoothstep(0.0, 0.12, since);
			img = photo + glint * 0.6;
		} else if (uMode < 11.5) {
			// ink
			float spread = 0.0;
			for (int k = 0; k < 4; k++) {
				float fk = float(k);
				vec2 drop = vec2(
					revealHash(vec2(uSeed, fk)),
					revealHash(vec2(fk, uSeed + 3.0))
				) * 0.7 + 0.15;
				float start = fk * 0.12;
				float grow = clamp((t - start) / (1.0 - start), 0.0, 1.0);
				spread = max(spread, grow * 1.05 - length(uv - drop));
			}
			float edge = revealFbm(uv * 9.0 + uSeed) * 0.18;
			float wet = spread - edge;
			if (wet < 0.0) discard;
			float bleed = 1.0 - smoothstep(0.0, 0.12, wet);
			vec3 photo = revealBlur(map, uv, 0.012 * bleed);
			// The edge carries the most pigment, and soaks in toward the middle.
			img = photo * (1.0 - bleed * 0.45);
			alpha = smoothstep(0.0, 0.04, wet);
		} else if (uMode < 12.5) {
			// glitch
			float k = smoothstep(0.0, 1.0, t);
			float noisy = 1.0 - smoothstep(0.6, 1.0, t);
			float tick = floor(t * 24.0);
			float band = floor(uv.y * 18.0);
			float slip = (revealHash(vec2(band, tick + uSeed)) - 0.5)
				* step(0.55, revealHash(vec2(tick, band + 7.0))) * 0.25 * noisy;
			vec2 s = vec2(uv.x + slip, uv.y);
			vec2 split = vec2(0.02 * noisy, 0.0);
			img = vec3(
				revealSample(map, s + split).r,
				revealSample(map, s).g,
				revealSample(map, s - split).b
			);
			vec2 block = floor(uv * vec2(8.0, 14.0));
			if (revealHash(block + tick + uSeed) > k * 1.25) discard;
			img *= 0.85 + 0.15 * step(0.5, fract(uv.y * 120.0)) * noisy + 0.15 * (1.0 - noisy);
		} else {
			// streak: smeared back along the direction of travel (up the
			// cover, for a record rising into view), easing to sharp.
			float k = smoothstep(0.0, 1.0, t);
			float len = 0.45 * (1.0 - k) * (1.0 - k);
			vec3 acc = vec3(0.0);
			float wsum = 0.0;
			for (int i = 0; i < 12; i++) {
				float f = float(i) / 11.0;
				float w = 1.0 - f * 0.7;
				acc += revealSample(map, uv + vec2(0.0, f * len)) * w;
				wsum += w;
			}
			img = acc / wsum;
			// In from the leading edge, its own edge feathered by the smear.
			float down = 1.0 - uv.y;
			float front = t * 1.5 - down;
			alpha = smoothstep(0.0, 0.08 + len, front) * smoothstep(0.0, 0.2, t);
			if (alpha <= 0.0) discard;
		}

		diffuseColor.rgb *= img;
		diffuseColor.a *= alpha;
		coverSelf = img * alpha;
	#endif
`;

export function makeCoverMaterial(
	placeholder: string,
	seed: number,
): THREE.MeshStandardMaterial {
	const material = new THREE.MeshStandardMaterial({
		color: placeholder,
		// Matte, like printed card — a glossier cover caught a hot glare from
		// the spotlight once lifted toward it.
		roughness: 0.85,
		// For the styles that fade (develop, focus). Records don't overlap,
		// so sorting isn't a concern, and it still writes depth.
		transparent: true,
	});
	material.userData.placeholder = placeholder;
	material.userData.animateIn = true;
	material.userData.reveal = 0;
	const uniforms: RevealUniforms = {
		uReveal: { value: 0 },
		uMode: { value: 0 },
		uDir: { value: 1 },
		uPlaceholder: { value: new THREE.Color(placeholder) },
		uSeed: { value: (seed * 12.9898) % 100 },
		uSelfLight: { value: 0 },
	};
	material.userData.revealUniforms = uniforms;
	material.onBeforeCompile = (shader) => {
		Object.assign(shader.uniforms, uniforms);
		shader.fragmentShader = shader.fragmentShader
			.replace("#include <common>", `#include <common>\n${HEADER_GLSL}`)
			.replace("#include <map_fragment>", MAP_GLSL)
			.replace(
				"#include <emissivemap_fragment>",
				"#include <emissivemap_fragment>\ntotalEmissiveRadiance += coverSelf * uSelfLight;",
			);
	};
	material.customProgramCacheKey = () => "cover-reveal-styles";
	return material;
}

function uniformsOf(material: THREE.MeshStandardMaterial) {
	return material.userData.revealUniforms as RevealUniforms | undefined;
}

/** Sets the reveal (0 = nothing, 1 = the full cover). */
export function setCoverReveal(
	material: THREE.MeshStandardMaterial,
	t: number,
) {
	const u = uniformsOf(material);
	if (u) u.uReveal.value = t;
}

/** Which way the reveal runs: 1 scrolling down, -1 scrolling up. */
export function setCoverDirection(
	material: THREE.MeshStandardMaterial,
	dir: number,
) {
	const u = uniformsOf(material);
	if (u) u.uDir.value = dir;
}

/** Picks the transition style. */
export function setCoverStyle(
	material: THREE.MeshStandardMaterial,
	style: RevealStyle,
) {
	const u = uniformsOf(material);
	if (u) u.uMode.value = REVEAL_STYLES.indexOf(style);
}

/** Theme changes: the placeholder colour (records with no photo). */
export function setCoverTheme(
	material: THREE.MeshStandardMaterial,
	placeholder: string,
) {
	material.userData.placeholder = placeholder;
	if (!material.map) material.color.set(placeholder);
	const u = uniformsOf(material);
	if (u) u.uPlaceholder.value.set(placeholder);
}

/** How much of the cover lights itself — see `uSelfLight`. */
export function setCoverSelfLight(
	material: THREE.MeshStandardMaterial,
	amount: number,
) {
	const u = uniformsOf(material);
	if (u) u.uSelfLight.value = amount;
}
