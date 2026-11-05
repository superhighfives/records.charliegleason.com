import { Effect } from "postprocessing";
import * as THREE from "three";

/**
 * Neutral (Khronos) tone mapping never quite reaches white: it compresses
 * everything above ~0.76 toward 1, and pure white comes out at ~0.871 linear
 * (measured: 240 of 255 on screen) — so the light theme's white wall rendered
 * a flat grey instead of the page's white. This runs after it and stretches
 * only that top band back up, so white is white again; anything below the
 * highlights is untouched.
 */
const NEUTRAL_WHITE = 0.871;

const fragmentShader = /* glsl */ `
	uniform float white;
	void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
		vec3 c = inputColor.rgb;
		vec3 k = smoothstep(vec3(white - 0.08), vec3(white), c);
		outputColor = vec4(min(mix(c, c / white, k), 1.0), inputColor.a);
	}
`;

export class WhitePointEffect extends Effect {
	constructor() {
		super("WhitePointEffect", fragmentShader, {
			uniforms: new Map([["white", new THREE.Uniform(NEUTRAL_WHITE)]]),
		});
	}
}
