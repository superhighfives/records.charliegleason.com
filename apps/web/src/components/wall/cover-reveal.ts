import * as THREE from "three";

/**
 * The cover material, with a shader transition for when its image arrives:
 * the cover melts down the sleeve from the top like thick paint — drips
 * running ahead in uneven columns, the image dragged and stretched just
 * behind the front, and a liquid wobble across the whole picture that
 * settles out to crisp as the pour finishes.
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
	/** Per record, so no two covers drip the same way. */
	uSeed: { value: number };
};

const NOISE_GLSL = /* glsl */ `
	uniform float uReveal;
	uniform vec3 uPlaceholder;
	uniform float uSeed;
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
	#ifdef USE_MAP
		float t = uReveal;
		// 0 at the sleeve's top edge, 1 at its bottom.
		float down = 1.0 - vMapUv.y;

		// Uneven drip columns: some run ahead of the pour, some lag behind.
		// Mixed sines (not value noise, which peaks at every lattice point
		// and reads as a jagged mountain range) give round, liquid tongues.
		float x = vMapUv.x;
		float drip = (sin(x * 11.0 + uSeed) * 0.5 + 0.5) * 0.14
			+ (sin(x * 23.0 + uSeed * 1.7) * 0.5 + 0.5) * 0.09
			+ (sin(x * 41.0 + uSeed * 2.3) * 0.5 + 0.5) * 0.05
			+ meltNoise(x * 17.0 + uSeed) * 0.05;
		float front = t * 1.55 - drip;
		float behind = front - down; // > 0 where the paint has reached
		float shown = smoothstep(0.0, 0.02, behind);

		// Just behind the front the image is dragged down (sampled from
		// higher up), stretching it into the drip; the drag eases off with
		// distance from the front and with the pour's progress.
		float settle = 1.0 - smoothstep(0.55, 1.0, t);
		float drag = (1.0 - smoothstep(0.0, 0.35, behind)) * 0.22 * settle;
		// A liquid wobble across the whole picture, also settling out.
		vec2 sampleUv = vMapUv;
		sampleUv.y += drag;
		sampleUv.x += sin(vMapUv.y * 17.0 + t * 9.0) * 0.012 * settle;
		sampleUv.y += sin(vMapUv.x * 13.0 + t * 7.0) * 0.008 * settle;
		vec4 sampledDiffuseColor = texture2D(map, clamp(sampleUv, 0.0, 1.0));

		// A slightly darker, wet lip right at the front.
		float lip = 1.0 - smoothstep(0.0, 0.05, behind);
		vec3 paint = diffuseColor.rgb * sampledDiffuseColor.rgb * (1.0 - lip * 0.35 * settle);

		diffuseColor.rgb = mix(uPlaceholder, paint, shown);
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
	};
	material.userData.revealUniforms = uniforms;
	material.onBeforeCompile = (shader) => {
		Object.assign(shader.uniforms, uniforms);
		shader.fragmentShader = shader.fragmentShader
			.replace("#include <common>", `#include <common>\n${NOISE_GLSL}`)
			.replace("#include <map_fragment>", MAP_GLSL);
	};
	material.customProgramCacheKey = () => "cover-melt";
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

/** Theme changes: the placeholder the cover melts down over. */
export function setCoverTheme(
	material: THREE.MeshStandardMaterial,
	placeholder: string,
) {
	material.userData.placeholder = placeholder;
	if (!material.map) material.color.set(placeholder);
	const u = uniformsOf(material);
	if (u) u.uPlaceholder.value.set(placeholder);
}
