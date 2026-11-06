import * as THREE from "three";

/**
 * The cover material: the standard lit material (lighting, shadows, the
 * matte finish) with its `map` step patched via `onBeforeCompile`, so a
 * cover can fade up as its image arrives (`uFade`), carry a share of
 * self-light (`uSelfLight`) to stay true to its photo, and drain to black
 * and white (`uDesaturate`) while another record is open.
 */

type CoverUniforms = {
	/** Opacity: the quick fade as a cover loads. */
	uFade: { value: number };
	/**
	 * How much of the cover lights itself (its own image as glow). Lit only
	 * by a dim room, covers came out dark, contrasty and muddy next to the
	 * same photos on the plain grid; a share of self-light keeps them close
	 * to their true colours, with the room's lighting as shading on top.
	 */
	uSelfLight: { value: number };
	/** 0 = full colour, 1 = black and white. */
	uDesaturate: { value: number };
};

const HEADER_GLSL = /* glsl */ `
	uniform float uFade;
	uniform float uSelfLight;
	uniform float uDesaturate;
`;

const MAP_GLSL = /* glsl */ `
	vec3 coverSelf = vec3(0.0);
	#ifdef USE_MAP
		vec3 img = texture2D(map, vMapUv).rgb;
		img = mix(img, vec3(dot(img, vec3(0.2126, 0.7152, 0.0722))), uDesaturate);
		diffuseColor.rgb *= img;
		diffuseColor.a *= uFade;
		coverSelf = img * uFade;
	#endif
`;

export function makeCoverMaterial(
	placeholder: string,
): THREE.MeshStandardMaterial {
	const material = new THREE.MeshStandardMaterial({
		color: placeholder,
		// Matte, like printed card — a glossier cover caught a hot glare from
		// the spotlight once lifted toward it.
		roughness: 0.85,
		// For the fade as it loads. Records don't overlap, so sorting isn't a
		// concern, and it still writes depth.
		transparent: true,
	});
	material.userData.placeholder = placeholder;
	material.userData.animateIn = true;
	const uniforms: CoverUniforms = {
		uFade: { value: 1 },
		uSelfLight: { value: 0 },
		uDesaturate: { value: 0 },
	};
	material.userData.coverUniforms = uniforms;
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
	material.customProgramCacheKey = () => "cover";
	return material;
}

function uniformsOf(material: THREE.MeshStandardMaterial) {
	return material.userData.coverUniforms as CoverUniforms | undefined;
}

/** Opacity (0–1) — see `uFade`. */
export function setCoverFade(material: THREE.MeshStandardMaterial, t: number) {
	const u = uniformsOf(material);
	if (u) u.uFade.value = t;
}

/** Theme changes: the placeholder colour (records with no photo). */
export function setCoverTheme(
	material: THREE.MeshStandardMaterial,
	placeholder: string,
) {
	material.userData.placeholder = placeholder;
	if (!material.map) material.color.set(placeholder);
}

/** How much of the cover lights itself — see `uSelfLight`. */
export function setCoverSelfLight(
	material: THREE.MeshStandardMaterial,
	amount: number,
) {
	const u = uniformsOf(material);
	if (u) u.uSelfLight.value = amount;
}

/** How far the cover drains to black and white — see `uDesaturate`. */
export function setCoverDesaturate(
	material: THREE.MeshStandardMaterial,
	amount: number,
) {
	const u = uniformsOf(material);
	if (u) u.uDesaturate.value = amount;
}
