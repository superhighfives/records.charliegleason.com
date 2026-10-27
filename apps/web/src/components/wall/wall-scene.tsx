import { Sparkles, Stats } from "@react-three/drei";
import {
	Canvas,
	type ThreeEvent,
	useFrame,
	useThree,
} from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import {
	makeGrooveTexture,
	type StreamTarget,
	useTextureStream,
} from "#/components/three/texture-stream";
import { displayCoverKey } from "#/lib/cover";
import type { PublicRecord } from "#/lib/records";

/**
 * Prototype: the collection as a grid hung on a dark wall. Covers sit at
 * slightly different depths and tilt gently as they pass, the camera drifts
 * with the pointer (parallax against the wall and the dust), a spotlight
 * follows the cursor and throws each cover's shadow onto the wall, and the
 * hovered record lifts off the wall with its vinyl sliding out.
 *
 * Scrolling is the page's own native scroll (a spacer sized from
 * `onContentHeight`), so iOS momentum works for free; the camera reads
 * `window.scrollY` every frame. On touch, the record at the centre of the
 * screen is the "hovered" one.
 */

const TILE = 1;
const GAP = 0.24;
const PITCH = TILE + GAP;
const SLEEVE_DEPTH = 0.02;
const FOV = 30;
/** Space above the first row, in world units. */
const TOP_PAD = 0.7;
/** How far a hovered record comes off the wall. */
const LIFT_Z = 0.42;
/** How far the hovered record's vinyl slides out to the right. */
const DISC_SLIDE = 0.4;
const WALL_Z = -0.32;

const SIZE_SCALE: Record<string, number> = {
	'12"': 1,
	'10"': 0.86,
	'7"': 0.72,
};

export type WallSceneProps = {
	records: PublicRecord[];
	onActiveChange: (index: number | null) => void;
	onOpen: (record: PublicRecord) => void;
	/** The scroll height the page needs for the whole wall, in CSS px. */
	onContentHeight: (px: number) => void;
	background: string;
	isTouch: boolean;
	showStats?: boolean;
};

export default function WallScene(props: WallSceneProps) {
	return (
		<Canvas
			dpr={[1, 2]}
			shadows={props.isTouch ? false : "percentage"}
			camera={{ fov: FOV, near: 0.1, far: 60, position: [0, 0, 10] }}
			gl={{ antialias: true, alpha: true }}
			style={{ touchAction: "pan-y" }}
		>
			<Wall {...props} />
			{props.showStats && <Stats />}
		</Canvas>
	);
}

function columnsFor(width: number) {
	if (width < 640) return 3;
	if (width < 1100) return 5;
	return 7;
}

type TileHandle = StreamTarget & {
	group: THREE.Group;
	disc: THREE.Mesh;
	scale: number;
};

function Wall({
	records,
	onActiveChange,
	onOpen,
	onContentHeight,
	background,
	isTouch,
}: WallSceneProps) {
	const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
	const size = useThree((s) => s.size);
	const cols = columnsFor(size.width);
	const rows = Math.ceil(records.length / cols);

	// Fit the grid's width (plus a margin) to the viewport.
	const gridWidth = cols * PITCH - GAP;
	const tanHalf = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
	const aspect = size.width / size.height;
	const distance = (gridWidth * 1.12) / 2 / (tanHalf * aspect);
	const viewHeight = 2 * distance * tanHalf;
	const viewWidth = viewHeight * aspect;
	const unitsPerPx = viewHeight / size.height;
	// Camera y when scrolled to the top: first row just under the top edge.
	const topY = -viewHeight / 2 + TILE / 2 + TOP_PAD;
	const wallHeight = rows * PITCH + TOP_PAD * 2;

	useEffect(() => {
		onContentHeight(wallHeight / unitsPerPx);
	}, [wallHeight, unitsPerPx, onContentHeight]);

	// Stable per-tile layout: grid slot plus a little depth jitter, so the
	// parallax has layers to work with.
	const layout = useMemo(
		() =>
			records.map((record, i) => {
				const col = i % cols;
				const row = Math.floor(i / cols);
				const jitter = Math.sin(record.id * 12.9898) * 43758.5453;
				return {
					x: (col - (cols - 1) / 2) * PITCH,
					y: -row * PITCH,
					z: (jitter - Math.floor(jitter) - 0.5) * 0.14,
				};
			}),
		[records, cols],
	);

	const shared = useMemo(() => {
		const sleeveGeometry = new THREE.BoxGeometry(TILE, TILE, SLEEVE_DEPTH);
		const discGeometry = new THREE.CylinderGeometry(0.46, 0.46, 0.006, 96);
		discGeometry.rotateX(Math.PI / 2);
		const edge = new THREE.MeshStandardMaterial({
			color: "#cfc7b6",
			roughness: 0.9,
		});
		return {
			sleeveGeometry,
			discGeometry,
			edge,
			grooves: makeGrooveTexture(),
		};
	}, []);

	const handles = useRef<(TileHandle | null)[]>([]);
	const lift = useRef(new Float32Array(records.length));
	const hovered = useRef<number | null>(null);
	const active = useRef<number | null>(null);
	const lastCenter = useRef(-1);
	const parallax = useRef(new THREE.Vector2());
	const spot = useRef<THREE.SpotLight>(null);
	const dust = useRef<THREE.Group>(null);
	const wall = useRef<THREE.Mesh>(null);
	const lookAt = useMemo(() => new THREE.Vector3(), []);

	const getTarget = useCallback((i: number) => handles.current[i], []);
	const textures = useTextureStream(records, getTarget, {
		coverPx: 512,
		window: cols * 4,
		discWindow: cols,
		cacheMax: cols * 12,
	});

	useEffect(() => {
		if (spot.current) {
			spot.current.shadow.mapSize.set(1024, 1024);
			spot.current.shadow.bias = -0.0004;
			spot.current.shadow.radius = 6;
		}
	}, []);

	useFrame((state, delta) => {
		const dt = Math.min(delta, 0.05);
		const t = state.clock.elapsedTime;
		const camY = topY - window.scrollY * unitsPerPx;

		// Parallax: the camera drifts toward the pointer (or a slow idle sway
		// on touch, where there's no pointer to follow).
		const goalX = isTouch ? Math.sin(t * 0.3) * 0.12 : state.pointer.x * 0.35;
		const goalY = isTouch ? Math.cos(t * 0.23) * 0.08 : state.pointer.y * 0.22;
		parallax.current.x = THREE.MathUtils.damp(parallax.current.x, goalX, 3, dt);
		parallax.current.y = THREE.MathUtils.damp(parallax.current.y, goalY, 3, dt);
		camera.position.set(
			parallax.current.x,
			camY + parallax.current.y,
			distance,
		);
		lookAt.set(0, camY, 0);
		camera.lookAt(lookAt);

		// Touch has no hover: whatever sits at the centre of the screen is it.
		const centerRow = Math.round(-camY / PITCH);
		if (isTouch) {
			const row = Math.min(rows - 1, Math.max(0, centerRow));
			const col = Math.floor(cols / 2);
			hovered.current = Math.min(records.length - 1, row * cols + col);
		}
		if (hovered.current !== active.current) {
			active.current = hovered.current;
			onActiveChange(active.current);
		}

		const centerIndex = Math.max(0, centerRow) * cols + Math.floor(cols / 2);
		if (centerIndex !== lastCenter.current) {
			lastCenter.current = centerIndex;
			textures.update(centerIndex);
		}

		// The spotlight tracks the pointer across the wall (on touch, it rests
		// on the centred record).
		const lightX = isTouch ? 0 : (state.pointer.x * viewWidth) / 2;
		const lightY = isTouch ? camY : camY + (state.pointer.y * viewHeight) / 2;
		if (spot.current) {
			const s = spot.current;
			s.position.x = THREE.MathUtils.damp(s.position.x, lightX, 5, dt);
			s.position.y = THREE.MathUtils.damp(s.position.y, lightY + 0.6, 5, dt);
			s.position.z = 3.2;
			s.target.position.set(s.position.x, s.position.y - 0.6, 0);
			s.target.updateMatrixWorld();
		}
		if (dust.current) dust.current.position.y = camY;
		if (wall.current) wall.current.position.y = camY;

		// Only rows near the viewport are animated (and drawn).
		const halfRows = Math.ceil(viewHeight / 2 / PITCH) + 2;
		for (let i = 0; i < records.length; i++) {
			const h = handles.current[i];
			if (!h) continue;
			const p = layout[i];
			const row = Math.floor(i / cols);
			const visible = Math.abs(row - centerRow) <= halfRows;
			h.group.visible = visible;
			if (!visible) {
				lift.current[i] = 0;
				continue;
			}
			const goal = hovered.current === i ? 1 : 0;
			const l = THREE.MathUtils.damp(lift.current[i], goal, 9, dt);
			lift.current[i] = l;

			// A gentle curve: tiles tip back as they pass above or below the
			// centre of the screen, and turn slightly toward it sideways.
			const dy = p.y - camY;
			h.group.position.set(p.x, p.y, p.z + l * LIFT_Z);
			h.group.rotation.x = -dy * 0.05 + l * -state.pointer.y * 0.18;
			h.group.rotation.y = -p.x * 0.035 + l * state.pointer.x * 0.25;
			const s = h.scale * (1 + l * 0.05);
			h.group.scale.setScalar(s);

			h.disc.visible = l > 0.01;
			if (h.disc.visible) {
				h.disc.position.x = (l * DISC_SLIDE) / h.scale;
				h.disc.rotation.z -= dt * 1.2 * l;
			}
		}
	});

	const register = useCallback((i: number, h: TileHandle | null) => {
		handles.current[i] = h;
	}, []);
	const hover = useCallback((i: number | null) => {
		hovered.current = i;
		document.body.style.cursor = i == null ? "" : "pointer";
	}, []);
	const open = useCallback(
		(i: number) => onOpen(records[i]),
		[onOpen, records],
	);

	return (
		<>
			<color attach="background" args={[background]} />
			<ambientLight intensity={0.35} />
			<hemisphereLight args={["#fff6e0", "#20160c", 0.35]} />
			<spotLight
				ref={spot}
				color="#ffe7c2"
				intensity={60}
				angle={0.55}
				penumbra={0.9}
				distance={12}
				decay={1.6}
				castShadow={!isTouch}
			/>
			{/* The wall the records hang on — only there to catch shadows. */}
			<mesh ref={wall} position={[0, 0, WALL_Z]} receiveShadow>
				<planeGeometry args={[viewWidth * 3, viewHeight * 3]} />
				<meshStandardMaterial color={background} roughness={1} />
			</mesh>
			<group ref={dust}>
				<Sparkles
					count={isTouch ? 90 : 220}
					scale={[viewWidth, viewHeight, 3]}
					position={[0, 0, 1]}
					size={2.2}
					speed={0.18}
					opacity={0.45}
					noise={0.6}
					color="#fff1d0"
				/>
			</group>
			{records.map((record, i) => (
				<Tile
					key={record.id}
					index={i}
					record={record}
					shared={shared}
					register={register}
					onHover={isTouch ? undefined : hover}
					onOpen={open}
				/>
			))}
		</>
	);
}

function Tile({
	index,
	record,
	shared,
	register,
	onHover,
	onOpen,
}: {
	index: number;
	record: PublicRecord;
	shared: {
		sleeveGeometry: THREE.BoxGeometry;
		discGeometry: THREE.CylinderGeometry;
		edge: THREE.MeshStandardMaterial;
		grooves: THREE.Texture;
	};
	register: (index: number, handle: TileHandle | null) => void;
	onHover?: (index: number | null) => void;
	onOpen: (index: number) => void;
}) {
	const group = useRef<THREE.Group>(null);
	const disc = useRef<THREE.Mesh>(null);
	const scale = SIZE_SCALE[record.size ?? ""] ?? 1;
	const cover = useMemo(
		() =>
			new THREE.MeshStandardMaterial({
				color: displayCoverKey(record) ? "#ffffff" : "#2a2a2a",
				roughness: 0.6,
			}),
		[record],
	);
	const discMaterial = useMemo(
		() =>
			new THREE.MeshStandardMaterial({
				color: record.colorTextureImageKey ? "#ffffff" : "#181818",
				roughness: 0.3,
				metalness: 0.45,
				bumpMap: shared.grooves,
				bumpScale: 0.6,
				roughnessMap: shared.grooves,
				transparent: !!record.colorTranslucent,
				opacity: record.colorTranslucent ? 0.72 : 1,
			}),
		[record, shared],
	);
	// BoxGeometry faces: +x, -x, +y, -y, +z (the cover), -z.
	const materials = useMemo(
		() => [
			shared.edge,
			shared.edge,
			shared.edge,
			shared.edge,
			cover,
			shared.edge,
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
		<group ref={group}>
			<mesh
				ref={disc}
				geometry={shared.discGeometry}
				material={discMaterial}
				position={[0, 0, -SLEEVE_DEPTH]}
				visible={false}
				castShadow
			/>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: a three.js mesh, not DOM — the page overlay names the active record */}
			<mesh
				geometry={shared.sleeveGeometry}
				material={materials}
				castShadow
				onPointerOver={
					onHover
						? (e: ThreeEvent<PointerEvent>) => {
								e.stopPropagation();
								onHover(index);
							}
						: undefined
				}
				onPointerOut={onHover ? () => onHover(null) : undefined}
				onClick={(e: ThreeEvent<MouseEvent>) => {
					e.stopPropagation();
					onOpen(index);
				}}
			/>
		</group>
	);
}
