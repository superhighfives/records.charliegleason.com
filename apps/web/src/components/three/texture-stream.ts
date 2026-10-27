import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";

import { displayCoverKey, photoUrl } from "#/lib/cover";
import type { PublicRecord } from "#/lib/records";

/** The materials a streamed record's textures land on. */
export type StreamTarget = {
	cover: THREE.MeshStandardMaterial;
	discMaterial: THREE.MeshStandardMaterial;
};

type StreamOptions = {
	/** Cover texture width requested from `/api/photos`. */
	coverPx: number;
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
 * `update(center)` is cheap to call every time the centre changes.
 */
export function useTextureStream(
	records: PublicRecord[],
	getTarget: (index: number) => StreamTarget | null | undefined,
	options: StreamOptions,
) {
	const anisotropy = useThree((s) => s.gl.capabilities.getMaxAnisotropy());
	const { coverPx, window, discWindow, cacheMax } = options;
	const stream = useMemo(() => {
		const loader = new THREE.TextureLoader();
		const cache = new Map<string, THREE.Texture>();
		const pending = new Set<string>();
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
			if (pending.has(url)) return;
			pending.add(url);
			loader.load(
				url,
				(texture) => {
					pending.delete(url);
					texture.colorSpace = THREE.SRGBColorSpace;
					texture.anisotropy = anisotropy;
					cache.set(url, texture);
					apply(material, texture);
					evict();
				},
				undefined,
				() => pending.delete(url),
			);
		};

		const update = (center: number) => {
			// Nearest first, so what you're looking at loads before its neighbours.
			for (let r = 0; r <= window; r++) {
				for (const i of r === 0 ? [center] : [center + r, center - r]) {
					const record = records[i];
					const target = getTarget(i);
					if (!record || !target) continue;
					const key = displayCoverKey(record);
					if (key) load(photoUrl(key, coverPx), target.cover);
					if (record.colorTextureImageKey && r <= discWindow) {
						load(
							photoUrl(record.colorTextureImageKey, 256),
							target.discMaterial,
						);
					}
				}
			}
		};

		const disposeAll = () => {
			for (const t of cache.values()) t.dispose();
			cache.clear();
			users.clear();
		};

		return { update, disposeAll };
	}, [records, getTarget, anisotropy, coverPx, window, discWindow, cacheMax]);

	useEffect(() => () => stream.disposeAll(), [stream]);
	return stream;
}

function setMap(
	material: THREE.MeshStandardMaterial,
	map: THREE.Texture | null,
) {
	if (material.map === map) return;
	material.map = map;
	material.needsUpdate = true;
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
