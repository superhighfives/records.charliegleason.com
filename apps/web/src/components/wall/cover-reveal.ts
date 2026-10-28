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
] as const;
export type RevealStyle = (typeof REVEAL_STYLES)[number];

type RevealUniforms = {
	uReveal: { value: number };
	uMode: { value: number };
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
		return texture2D(tex, clamp(uv, 0.0, 1.0)).rgb;
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
`;

const MAP_GLSL = /* glsl */ `
	vec3 coverSelf = vec3(0.0);
	#ifdef USE_MAP
		float t = uReveal;
		vec2 uv = vMapUv;
		vec3 img;
		float alpha = 1.0;
		float settle = 1.0 - smoothstep(0.55, 1.0, t);

		if (uMode < 0.5) {
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
		} else {
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
