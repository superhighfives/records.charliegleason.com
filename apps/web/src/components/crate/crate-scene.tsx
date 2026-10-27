import { Environment, Lightformer, Stats } from "@react-three/drei";
import {
	Canvas,
	type ThreeEvent,
	useFrame,
	useThree,
} from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import { displayCoverKey, photoUrl } from "#/lib/cover";
import type { PublicRecord } from "#/lib/records";

/**
 * Prototype: the collection as a crate you flip through. Records stand in a
 * row; everything in front of the cursor tips forward onto the stack, the
 * current record stands upright with its vinyl sliding out of the top of the
 * sleeve, and everything behind leans back. Scroll, drag or arrow-key to dig.
 *
 * One `useFrame` drives every record imperatively (no per-record React
 * state), only records within `RENDER_WINDOW` of the cursor are drawn, and
 * cover textures stream in and out around the cursor (`TEXTURE_WINDOW`) so
 * GPU memory stays bounded on phones.
 */

// Sleeve dimensions in world units (a 12" sleeve is 1×1).
const SLEEVE = 1;
const SLEEVE_DEPTH = 0.012;
/** Distance between records standing in the crate. */
const GAP = 0.045;
/** Extra space opened up in front of the current record. */
const OPENING = 0.42;
/** Forward tip of records you've flipped past, in radians. */
const FLIPPED_TILT = 1.08;
/** Backward lean of records still to come. */
const RESTING_LEAN = -0.13;
/** How far the current record's disc slides out the top of its sleeve. */
const DISC_RISE = 0.3;

const RENDER_WINDOW = 40;
const TEXTURE_WINDOW = 14;
const TEXTURE_CACHE_MAX = 60;
const COVER_PX = 512;

const SIZE_SCALE: Record<string, number> = {
	'12"': 1,
	'10"': 0.86,
	'7"': 0.72,
};

export type CrateSceneProps = {
	records: PublicRecord[];
	/**
	 * Fractional index the crate is flipped to; the scene eases toward it.
	 * A ref, read every frame, so scrolling never re-renders the scene.
	 */
	targetRef: React.RefObject<number>;
	/** A record other than the current one was clicked. */
	onSelectIndex: (index: number) => void;
	onCurrentChange: (index: number) => void;
	onOpen: (record: PublicRecord) => void;
	background: string;
	showStats?: boolean;
};

export default function CrateScene(props: CrateSceneProps) {
	return (
		<Canvas
			dpr={[1, 2]}
			camera={{ fov: 35, near: 0.1, far: 40, position: [0, 1.6, 2.4] }}
			gl={{ antialias: true, alpha: true }}
			style={{ touchAction: "none" }}
		>
			<fog attach="fog" args={[props.background, 3.5, 9]} />
			<hemisphereLight args={["#ffffff", "#3a2a1a", 0.6]} />
			<directionalLight position={[2.5, 4, 3]} intensity={1.6} />
			<Environment resolution={128}>
				<Lightformer
					form="rect"
					intensity={2}
					position={[0, 3, 2]}
					scale={[4, 1, 1]}
				/>
				<Lightformer
					form="rect"
					intensity={1}
					position={[-3, 1, -1]}
					scale={[2, 2, 1]}
					color="#ffe8b0"
				/>
			</Environment>
			<Crate {...props} />
			{props.showStats && <Stats />}
		</Canvas>
	);
}

/** Shared, never-disposed resources for every record. */
function useSharedResources() {
	return useMemo(() => {
		const sleeveGeometry = new THREE.BoxGeometry(SLEEVE, SLEEVE, SLEEVE_DEPTH);
		// Pivot the sleeve on its bottom edge so tilting reads as tipping.
		sleeveGeometry.translate(0, SLEEVE / 2, 0);
		const discGeometry = new THREE.CylinderGeometry(0.47, 0.47, 0.006, 96);
		discGeometry.rotateX(Math.PI / 2);
		const cardboard = new THREE.MeshStandardMaterial({
			color: "#d9d2c3",
			roughness: 0.9,
		});
		const sleeveBack = new THREE.MeshStandardMaterial({
			color: "#bfb6a3",
			roughness: 0.85,
		});
		const loader = new THREE.TextureLoader();
		const grooves = makeGrooveTexture();
		return {
			sleeveGeometry,
			discGeometry,
			cardboard,
			sleeveBack,
			loader,
			grooves,
		};
	}, []);
}

type RecordHandle = {
	group: THREE.Group;
	disc: THREE.Mesh;
	cover: THREE.MeshStandardMaterial;
	discMaterial: THREE.MeshStandardMaterial;
	scale: number;
};

function Crate({
	records,
	targetRef,
	onSelectIndex,
	onCurrentChange,
	onOpen,
}: CrateSceneProps) {
	const shared = useSharedResources();
	const handles = useRef<(RecordHandle | null)[]>([]);
	const current = useRef(targetRef.current);
	const lastReported = useRef(-1);
	const camera = useThree((s) => s.camera);
	const size = useThree((s) => s.size);
	const maxAnisotropy = useThree((s) => s.gl.capabilities.getMaxAnisotropy());
	const lookAt = useMemo(() => new THREE.Vector3(), []);
	const camGoal = useMemo(() => new THREE.Vector3(), []);
	const textures = useTextureStream(
		records,
		shared.loader,
		maxAnisotropy,
		handles,
	);

	const portrait = size.width < size.height;

	useFrame((_, delta) => {
		const dt = Math.min(delta, 0.05);
		current.current = THREE.MathUtils.damp(
			current.current,
			targetRef.current,
			7,
			dt,
		);
		const c = current.current;
		const nearest = Math.round(c);
		if (nearest !== lastReported.current) {
			lastReported.current = nearest;
			onCurrentChange(nearest);
			textures.update(nearest);
		}

		for (let i = 0; i < records.length; i++) {
			const h = handles.current[i];
			if (!h) continue;
			const d = i - c;
			const visible = Math.abs(d) < RENDER_WINDOW;
			h.group.visible = visible;
			if (!visible) continue;
			// 0 = still standing behind the cursor, 1 = flipped forward.
			const flipped = THREE.MathUtils.smoothstep(-d, -0.5, 0.5);
			// 1 only for the record exactly at the cursor.
			const focus = Math.max(0, 1 - Math.abs(d) * 1.6);
			const z = -i * GAP + OPENING * flipped;
			h.group.position.set(0, focus * 0.04, z);
			// Records further back lean a touch less, like a real crate.
			const lean = RESTING_LEAN * (1 - Math.min(Math.max(d, 0), 6) / 12);
			h.group.rotation.x = THREE.MathUtils.lerp(lean, FLIPPED_TILT, flipped);
			// The disc slides up out of the sleeve's open top and spins slowly.
			const rise = focus * focus * DISC_RISE;
			h.disc.position.y = SLEEVE / 2 + rise / h.scale;
			h.disc.visible = rise > 0.002;
			h.disc.rotation.z -= dt * 0.6 * focus;
		}

		// Camera rides along above the cursor, looking down into the crate.
		const zc = -c * GAP;
		const back = portrait ? 3.6 : 2.3;
		const up = portrait ? 2.6 : 1.9;
		camGoal.set(0, up, zc + back);
		camera.position.lerp(camGoal, 1 - Math.exp(-6 * dt));
		lookAt.set(0, 0.42, zc - 0.15);
		camera.lookAt(lookAt);
	});

	useEffect(() => {
		return () => textures.disposeAll();
	}, [textures]);

	const crateLength = records.length * GAP + 2;
	const register = useCallback((i: number, h: RecordHandle | null) => {
		handles.current[i] = h;
	}, []);
	const select = useCallback(
		(i: number) => {
			if (Math.round(current.current) === i) onOpen(records[i]);
			else onSelectIndex(i);
		},
		[records, onOpen, onSelectIndex],
	);

	return (
		<group>
			<CrateBox length={crateLength} />
			{records.map((record, i) => (
				<RecordMesh
					key={record.id}
					index={i}
					record={record}
					shared={shared}
					register={register}
					onSelect={select}
				/>
			))}
		</group>
	);
}

function RecordMesh({
	index,
	record,
	shared,
	register,
	onSelect,
}: {
	index: number;
	record: PublicRecord;
	shared: ReturnType<typeof useSharedResources>;
	register: (index: number, handle: RecordHandle | null) => void;
	onSelect: (index: number) => void;
}) {
	const group = useRef<THREE.Group>(null);
	const disc = useRef<THREE.Mesh>(null);
	const scale = SIZE_SCALE[record.size ?? ""] ?? 1;
	const cover = useMemo(
		() =>
			new THREE.MeshStandardMaterial({
				color: displayCoverKey(record) ? "#ffffff" : "#2a2a2a",
				roughness: 0.55,
			}),
		[record],
	);
	const discMaterial = useMemo(
		() =>
			new THREE.MeshStandardMaterial({
				color: record.colorTextureImageKey ? "#ffffff" : "#181818",
				roughness: 0.3,
				metalness: 0.45,
				envMapIntensity: 1.6,
				// Concentric grooves as a bump + roughness map, so the disc
				// catches the light in rings like real vinyl.
				bumpMap: shared.grooves,
				bumpScale: 0.6,
				roughnessMap: shared.grooves,
				transparent: !!record.colorTranslucent,
				opacity: record.colorTranslucent ? 0.72 : 1,
			}),
		[record, shared],
	);
	// BoxGeometry faces: +x, -x, +y, -y, +z (front, towards the camera), -z.
	const materials = useMemo(
		() => [
			shared.cardboard,
			shared.cardboard,
			shared.cardboard,
			shared.cardboard,
			cover,
			shared.sleeveBack,
		],
		[shared, cover],
	);

	useEffect(() => {
		if (!group.current || !disc.current) return;
		register(index, {
			group: group.current,
			disc: disc.current,
			cover,
			discMaterial,
			scale,
		});
		return () => {
			register(index, null);
			cover.dispose();
			discMaterial.dispose();
		};
	}, [index, register, cover, discMaterial, scale]);

	return (
		<group ref={group} scale={scale}>
			{/* The disc sits inside the sleeve, so it's drawn first and slid up. */}
			<mesh
				ref={disc}
				geometry={shared.discGeometry}
				material={discMaterial}
				visible={false}
			/>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: a three.js mesh, not DOM — keyboard access is the page-level arrow keys */}
			<mesh
				geometry={shared.sleeveGeometry}
				material={materials}
				onClick={(e: ThreeEvent<MouseEvent>) => {
					e.stopPropagation();
					onSelect(index);
				}}
				onPointerOver={() => {
					document.body.style.cursor = "pointer";
				}}
				onPointerOut={() => {
					document.body.style.cursor = "";
				}}
			/>
		</group>
	);
}

function CrateBox({ length }: { length: number }) {
	const wood = useMemo(
		() => new THREE.MeshStandardMaterial({ color: "#6b4a2e", roughness: 0.8 }),
		[],
	);
	const width = SLEEVE + 0.12;
	const wallHeight = 0.42;
	const zMid = -(length / 2) + 0.9;
	return (
		<group>
			<mesh position={[0, -0.02, zMid]} material={wood}>
				<boxGeometry args={[width, 0.04, length]} />
			</mesh>
			{[-1, 1].map((side) => (
				<mesh
					key={side}
					position={[(side * width) / 2, wallHeight / 2 - 0.04, zMid]}
					material={wood}
				>
					<boxGeometry args={[0.04, wallHeight, length]} />
				</mesh>
			))}
		</group>
	);
}

/**
 * Loads cover + vinyl textures for records near the cursor and evicts the
 * oldest beyond `TEXTURE_CACHE_MAX`, so a 300-record crate never holds 300
 * textures on the GPU at once.
 */
function useTextureStream(
	records: PublicRecord[],
	loader: THREE.TextureLoader,
	anisotropy: number,
	handles: React.RefObject<(RecordHandle | null)[]>,
) {
	return useMemo(() => {
		const cache = new Map<string, THREE.Texture>();
		const pending = new Set<string>();

		const load = (url: string, apply: (t: THREE.Texture) => void) => {
			const hit = cache.get(url);
			if (hit) {
				// Refresh LRU position.
				cache.delete(url);
				cache.set(url, hit);
				apply(hit);
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
					apply(texture);
					while (cache.size > TEXTURE_CACHE_MAX) {
						const [oldUrl, old] = cache.entries().next().value as [
							string,
							THREE.Texture,
						];
						cache.delete(oldUrl);
						for (const h of handles.current ?? []) {
							if (h?.cover.map === old) setMap(h.cover, null);
							if (h?.discMaterial.map === old) setMap(h.discMaterial, null);
						}
						old.dispose();
					}
				},
				undefined,
				() => pending.delete(url),
			);
		};

		const update = (center: number) => {
			// Nearest first, so the record you're on loads before its neighbours.
			const order: number[] = [];
			for (let r = 0; r <= TEXTURE_WINDOW; r++) {
				if (r === 0) order.push(center);
				else order.push(center + r, center - r);
			}
			for (const i of order) {
				const record = records[i];
				const h = handles.current?.[i];
				if (!record || !h) continue;
				const key = displayCoverKey(record);
				if (key) load(photoUrl(key, COVER_PX), (t) => setMap(h.cover, t));
				if (record.colorTextureImageKey && Math.abs(i - center) <= 2) {
					load(photoUrl(record.colorTextureImageKey, 256), (t) =>
						setMap(h.discMaterial, t),
					);
				}
			}
		};

		const disposeAll = () => {
			for (const t of cache.values()) t.dispose();
			cache.clear();
		};

		return { update, disposeAll };
	}, [records, loader, anisotropy, handles]);
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
 * A radial groove pattern for the disc caps (CylinderGeometry maps its caps
 * as a unit square, so a centred canvas lines up with the disc). Grey levels
 * vary ring to ring; used as both bump and roughness.
 */
function makeGrooveTexture() {
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
