import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

/**
 * One layer of drifting dust that scrolls at its own rate. Particles live in
 * a box centred on the camera; each one's height wraps inside the box in the
 * vertex shader (`mod`), so shifting the whole layer by any scroll offset is
 * seamless — no pop when a particle leaves one edge, it re-enters the other.
 * Several layers at different depths and `parallax` rates read as depth.
 *
 * `parallax` is how fast the layer moves relative to the wall: 1 moves with
 * it, below 1 is further back, above 1 is closer than the records.
 */
export function Dust({
	count,
	width,
	height,
	depth,
	z,
	parallax,
	size,
	opacity,
	color,
	getScroll,
}: {
	count: number;
	width: number;
	height: number;
	depth: number;
	/** Centre of the layer's depth range, in world units. */
	z: number;
	parallax: number;
	/** Particle size in CSS px at the layer's centre. */
	size: number;
	opacity: number;
	color: string;
	/** How far the camera has travelled down the wall, in world units. */
	getScroll: () => number;
}) {
	const geometry = useMemo(() => {
		const positions = new Float32Array(count * 3);
		const seeds = new Float32Array(count);
		for (let i = 0; i < count; i++) {
			positions[i * 3] = (Math.random() - 0.5) * width;
			positions[i * 3 + 1] = Math.random() * height;
			positions[i * 3 + 2] = (Math.random() - 0.5) * depth;
			seeds[i] = Math.random();
		}
		const g = new THREE.BufferGeometry();
		g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
		g.setAttribute("seed", new THREE.BufferAttribute(seeds, 1));
		// The box moves with the camera; never cull it.
		g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
		return g;
	}, [count, width, height, depth]);

	// Created once per box height; size/opacity/colour are updated in place
	// by the effect below rather than rebuilding the shader.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above
	const material = useMemo(
		() =>
			new THREE.ShaderMaterial({
				transparent: true,
				depthWrite: false,
				uniforms: {
					uTime: { value: 0 },
					uOffset: { value: 0 },
					uHeight: { value: height },
					uSize: { value: size },
					uPixelRatio: { value: 1 },
					uOpacity: { value: opacity },
					uColor: { value: new THREE.Color(color) },
				},
				vertexShader: /* glsl */ `
					attribute float seed;
					uniform float uTime;
					uniform float uOffset;
					uniform float uHeight;
					uniform float uSize;
					uniform float uPixelRatio;
					varying float vTwinkle;
					void main() {
						vec3 p = position;
						// Slow individual drift, then wrap the height into the box.
						p.x += sin(uTime * 0.21 + seed * 40.0) * 0.12;
						p.y = mod(p.y + uOffset + sin(uTime * 0.17 + seed * 25.0) * 0.1, uHeight)
							- uHeight * 0.5;
						vec4 mv = modelViewMatrix * vec4(p, 1.0);
						gl_Position = projectionMatrix * mv;
						gl_PointSize = uSize * uPixelRatio * (0.6 + seed * 0.8) * (10.0 / -mv.z);
						vTwinkle = 0.55 + 0.45 * sin(uTime * (0.6 + seed) + seed * 12.0);
					}
				`,
				fragmentShader: /* glsl */ `
					uniform vec3 uColor;
					uniform float uOpacity;
					varying float vTwinkle;
					void main() {
						float d = length(gl_PointCoord - 0.5);
						float a = smoothstep(0.5, 0.0, d);
						gl_FragColor = vec4(uColor, a * uOpacity * vTwinkle);
					}
				`,
			}),
		[height],
	);

	useEffect(() => {
		material.uniforms.uSize.value = size;
		material.uniforms.uOpacity.value = opacity;
		material.uniforms.uColor.value.set(color);
	}, [material, size, opacity, color]);

	useEffect(
		() => () => {
			geometry.dispose();
			material.dispose();
		},
		[geometry, material],
	);

	const points = useRef<THREE.Points>(null);
	useFrame((state) => {
		const u = material.uniforms;
		u.uTime.value = state.clock.elapsedTime;
		u.uPixelRatio.value = state.gl.getPixelRatio();
		// The layer box rides along with the camera, so on its own it would sit
		// still on screen; sliding its particles up by `parallax` × the scroll
		// moves them against the view at that rate (the wall moves at 1).
		u.uOffset.value = getScroll() * parallax;
		if (points.current) {
			points.current.position.set(0, state.camera.position.y, z);
		}
	});

	return <points ref={points} geometry={geometry} material={material} />;
}
