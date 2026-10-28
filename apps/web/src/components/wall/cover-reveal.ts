import * as THREE from "three";

/**
 * The cover material, with a shader transition for when its image arrives:
 * nothing is drawn until the image is ready, then the cover emerges from its
 * centre outward (as a rounded square) like a picture rising up through
 * water — a softly wobbling
 * edge with rings of refraction (and a touch of colour separation) rippling
 * through the image behind it, settling out to crisp.
 *
 * It's the standard lit material (lighting, shadows, the matte finish) with
 * its `map` step patched via `onBeforeCompile`. Every cover shares one
 * compiled program (`customProgramCacheKey`); each material only carries its
 * own uniforms. Drive it with `setCoverReveal(material, t)`, t from 0 to 1;
 * the texture stream resets `userData.reveal` to 0 whenever a cover arrives.
 */

type RevealUniforms = {
	uReveal: { value: number };
	uPlaceholder: { value: THREE.Color };
	/** Per record, so no two covers ripple in the same way. */
	uSeed: { value: number };
	/**
	 * How much of the cover lights itself (its own image as glow). Lit only
	 * by a dim room, covers came out dark, contrasty and muddy next to the
	 * same photos on the plain grid; a share of self-light keeps them close
	 * to their true colours, with the room's lighting as shading on top.
	 */
	uSelfLight: { value: number };
};

const NOISE_GLSL = /* glsl */ `
	uniform float uReveal;
	uniform vec3 uPlaceholder;
	uniform float uSeed;
	uniform float uSelfLight;
	float meltHash(float x) {
		return fract(sin(x * 127.1) * 43758.5453);
	}
	// Smooth 1D noise across the sleeve's width: one value per drip column.
	float meltNoise(float x) {
		float i = floor(x);
		float f = fract(x);
		return mix(meltHash(i), meltHash(i + 1.0), f * f * (3.0 - 2.0 * f));
	}
`;

const MAP_GLSL = /* glsl */ `
	vec3 coverSelf = vec3(0.0);
	#ifdef USE_MAP
		float t = uReveal;
		vec2 fromCentre = vMapUv - 0.5;
		// A rounded square, not a circle: a circle left the corners hidden
		// longest, and on a big record those dark, curved corners read as
		// vinyls sliding away. 1 at the middle of each edge, ~1.19 at corners.
		vec2 q = abs(fromCentre) * 2.0;
		float dist = pow(pow(q.x, 4.0) + pow(q.y, 4.0), 0.25);
		float angle = atan(fromCentre.y, fromCentre.x);

		// The image emerges from the centre outward, finished by t ≈ 0.75.
		// Its edge is a soft circle that wobbles a little, like a meniscus.
		float settle = 1.0 - smoothstep(0.55, 1.0, t);
		float wobble = (sin(angle * 5.0 + uSeed) * 0.5 + 0.5) * 0.03
			+ meltNoise(angle * 3.0 + uSeed) * 0.02;
		float radius = smoothstep(0.0, 0.75, t) * 1.3 - wobble * settle;
		if (dist > radius) discard;

		// Behind the edge, rings of refraction ripple through the picture —
		// strongest right at the edge, settling everywhere as t → 1.
		float behindEdge = radius - dist;
		float ring = sin(behindEdge * 38.0 - t * 14.0)
			* (1.0 - smoothstep(0.0, 0.45, behindEdge));
		vec2 dir = dist > 0.0001 ? fromCentre / length(fromCentre) : vec2(0.0);
		vec2 refract = dir * ring * 0.022 * settle;
		// A touch of colour separation where the refraction is strongest.
		vec2 split = dir * 0.006 * settle * (1.0 - smoothstep(0.0, 0.3, behindEdge));
		vec2 uv = clamp(vMapUv + refract, 0.0, 1.0);
		vec4 sampledDiffuseColor = vec4(
			texture2D(map, clamp(uv + split, 0.0, 1.0)).r,
			texture2D(map, uv).g,
			texture2D(map, clamp(uv - split, 0.0, 1.0)).b,
			1.0
		);
		diffuseColor.rgb *= sampledDiffuseColor.rgb;
		coverSelf = sampledDiffuseColor.rgb;
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
	});
	material.userData.placeholder = placeholder;
	material.userData.animateIn = true;
	material.userData.reveal = 0;
	const uniforms: RevealUniforms = {
		uReveal: { value: 0 },
		uPlaceholder: { value: new THREE.Color(placeholder) },
		uSeed: { value: (seed * 12.9898) % 100 },
		uSelfLight: { value: 0 },
	};
	material.userData.revealUniforms = uniforms;
	material.onBeforeCompile = (shader) => {
		Object.assign(shader.uniforms, uniforms);
		shader.fragmentShader = shader.fragmentShader
			.replace("#include <common>", `#include <common>\n${NOISE_GLSL}`)
			.replace("#include <map_fragment>", MAP_GLSL)
			.replace(
				"#include <emissivemap_fragment>",
				"#include <emissivemap_fragment>\ntotalEmissiveRadiance += coverSelf * uSelfLight;",
			);
	};
	material.customProgramCacheKey = () => "cover-ripple";
	return material;
}

function uniformsOf(material: THREE.MeshStandardMaterial) {
	return material.userData.revealUniforms as RevealUniforms | undefined;
}

/** Sets the reveal (0 = placeholder, 1 = the full cover). */
export function setCoverReveal(
	material: THREE.MeshStandardMaterial,
	t: number,
) {
	const u = uniformsOf(material);
	if (u) u.uReveal.value = t;
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
