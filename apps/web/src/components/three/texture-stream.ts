import { useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import { displayCoverKey, photoUrl } from "#/lib/cover";
import type { PublicRecord } from "#/lib/records";

/** The materials a streamed record's textures land on. */
export type StreamTarget = {
	/**
	 * The record these materials belong to. Checked before loading, so a
	 * frame where indices and handles briefly disagree (mid re-filter) can't
	 * send one record's cover to another record's material.
	 */
	id?: number;
	cover: THREE.MeshStandardMaterial;
	discMaterial: THREE.MeshStandardMaterial;
};

type StreamOptions = {
	/** Cover texture width requested from `/api/photos`, or per record. */
	coverPx: number | ((index: number) => number);
	/** Records either side of the centre to load covers for. */
	window: number;
	/** Records either side of the centre to load vinyl swatches for. */
	discWindow: number;
	/** Most textures held at once; the least recently used are evicted. */
	cacheMax: number;
};

/**
 * Streams cover + vinyl textures for records near a moving centre index and
 * evicts the least recently used beyond `cacheMax`, so a 300-record scene
 * never holds 300 textures on the GPU (phones kill tabs that try).
 * `update(center)` is cheap to call every time the centre changes. The cache
 * outlives `records` changes (filtering), so a re-filter reuses what's loaded.
 *
 * A material shows `userData.placeholder` (a theme colour) until its texture
 * arrives, and again if the texture is evicted — never a white flash.
 *
 * Images decode off the main thread (`ImageBitmapLoader`), and finished
 * textures queue until `flush(n)` — called once per frame — hands at most
 * `n` to their materials. Each one costs a GPU upload the first time it's
 * drawn, and a fast scroll otherwise lands a dozen uploads in one frame (the
 * single biggest cost in a profiled throttled-phone scroll).
 */
export function useTextureStream(
	records: PublicRecord[],
	getTarget: (index: number) => StreamTarget | null | undefined,
	options: StreamOptions,
) {
	const anisotropy = useThree((s) => s.gl.capabilities.getMaxAnisotropy());
	// `window` renamed: as a local it would shadow the global.
	const { coverPx, window: span, discWindow, cacheMax } = options;
	const recordsRef = useRef(records);
	recordsRef.current = records;
	// Read through a ref: a per-record function is usually a fresh closure
	// each render, and must not rebuild the stream (and drop its cache).
	const coverPxRef = useRef(coverPx);
	coverPxRef.current = coverPx;
	const stream = useMemo(() => {
		const loader = new THREE.ImageBitmapLoader();
		loader.setOptions({ imageOrientation: "flipY" });
		const cache = new Map<string, THREE.Texture>();
		/** Decoded, waiting for their turn to be handed to a material. */
		const ready: {
			texture: THREE.Texture;
			material: THREE.MeshStandardMaterial;
		}[] = [];
		/** In-flight loads, with every material waiting on each one. */
		const pending = new Map<string, Set<THREE.MeshStandardMaterial>>();
		// Which materials each cached texture is applied to, for eviction.
		const users = new Map<THREE.Texture, Set<THREE.MeshStandardMaterial>>();

		const apply = (material: THREE.MeshStandardMaterial, t: THREE.Texture) => {
			setMap(material, t);
			let set = users.get(t);
			if (!set) {
				set = new Set();
				users.set(t, set);
			}
			set.add(material);
		};

		const evict = () => {
			while (cache.size > cacheMax) {
				const [url, old] = cache.entries().next().value as [
					string,
					THREE.Texture,
				];
				cache.delete(url);
				for (const m of users.get(old) ?? []) {
					if (m.map === old) setMap(m, null);
				}
				users.delete(old);
				old.dispose();
				(old.image as ImageBitmap | undefined)?.close?.();
			}
		};

		const load = (url: string, material: THREE.MeshStandardMaterial) => {
			const hit = cache.get(url);
			if (hit) {
				// Refresh its LRU position.
				cache.delete(url);
				cache.set(url, hit);
				apply(material, hit);
				return;
			}
			// Already loading: wait on it too. (Many records share one vinyl
			// colour swatch, and a re-filter can re-request a cover mid-flight.)
			const waiting = pending.get(url);
			if (waiting) {
				waiting.add(material);
				return;
			}
			pending.set(url, new Set([material]));
			loader.load(
				url,
				(bitmap) => {
					const waiting = pending.get(url) ?? new Set();
					pending.delete(url);
					const texture = new THREE.Texture(bitmap);
					// The bitmap was decoded pre-flipped (see `setOptions`).
					texture.flipY = false;
					texture.colorSpace = THREE.SRGBColorSpace;
					texture.anisotropy = anisotropy;
					texture.needsUpdate = true;
					cache.set(url, texture);
					for (const m of waiting) ready.push({ texture, material: m });
					evict();
				},
				undefined,
				() => pending.delete(url),
			);
		};

		const update = (center: number) => {
			const records = recordsRef.current;
			// Nearest first, so what you're looking at loads before its neighbours.
			for (let r = 0; r <= span; r++) {
				for (const i of r === 0 ? [center] : [center + r, center - r]) {
					const record = records[i];
					const target = getTarget(i);
					if (!record || !target) continue;
					if (target.id != null && target.id !== record.id) continue;
					const key = displayCoverKey(record);
					if (key) {
						const size = coverPxRef.current;
						const px = typeof size === "number" ? size : size(i);
						load(photoUrl(key, px), target.cover);
					}
					if (record.colorTextureImageKey && r <= discWindow) {
						load(
							photoUrl(record.colorTextureImageKey, 256),
							target.discMaterial,
						);
					}
				}
			}
		};

		const flush = (max: number) => {
			for (let n = 0; n < max && ready.length > 0; n++) {
				const next = ready.shift();
				// Skip anything evicted while it waited.
				if (next && cache.has(urlOf(next.texture))) {
					apply(next.material, next.texture);
				}
			}
		};
		const urlOf = (t: THREE.Texture) => {
			for (const [url, cached] of cache) if (cached === t) return url;
			return "";
		};

		const disposeAll = () => {
			for (const t of cache.values()) {
				t.dispose();
				(t.image as ImageBitmap | undefined)?.close?.();
			}
			cache.clear();
			users.clear();
			ready.length = 0;
		};

		return { update, flush, disposeAll };
	}, [getTarget, anisotropy, span, discWindow, cacheMax]);

	useEffect(() => () => stream.disposeAll(), [stream]);
	return stream;
}

function setMap(
	material: THREE.MeshStandardMaterial,
	map: THREE.Texture | null,
) {
	if (material.map === map) return;
	material.map = map;
	if (material.userData.fadeIn) {
		// The scene eases `fade` from 0 to 1 (see `applyCoverFade`).
		material.userData.fade = 0;
		applyCoverFade(material, 0);
	} else {
		material.color.set(
			map ? "#ffffff" : (material.userData.placeholder ?? "#2a2a2a"),
		);
	}
	material.needsUpdate = true;
}

/**
 * For materials marked `userData.fadeIn`: crossfades the flat placeholder
 * (drawn as the material's own glow, so it reads the same lit or not) into
 * the lit cover texture as `t` goes 0 → 1, instead of the cover popping in.
 */
export function applyCoverFade(
	material: THREE.MeshStandardMaterial,
	t: number,
) {
	const shown = material.map ? t : 0;
	material.color.setScalar(shown);
	material.emissive.set(material.userData.placeholder ?? "#2a2a2a");
	material.emissiveIntensity = 1 - shown;
}

/**
 * A radial groove pattern for vinyl disc caps (CylinderGeometry maps its caps
 * as a unit square, so a centred canvas lines up with the disc). Grey levels
 * vary ring to ring; used as both bump and roughness map.
 */
export function makeGrooveTexture() {
	const size = 512;
	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d");
	if (ctx) {
		const c = size / 2;
		ctx.fillStyle = "#777";
		ctx.fillRect(0, 0, size, size);
		for (let r = c; r > c * 0.36; r -= 1.5) {
			const shade = 110 + Math.round(Math.sin(r * 0.9) * 30 + (r % 7) * 4);
			ctx.strokeStyle = `rgb(${shade},${shade},${shade})`;
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.arc(c, c, r, 0, Math.PI * 2);
			ctx.stroke();
		}
		// Smooth run-out between the grooves and the label.
		ctx.fillStyle = "#555";
		ctx.beginPath();
		ctx.arc(c, c, c * 0.36, 0, Math.PI * 2);
		ctx.fill();
	}
	const texture = new THREE.CanvasTexture(canvas);
	texture.anisotropy = 4;
	return texture;
}
