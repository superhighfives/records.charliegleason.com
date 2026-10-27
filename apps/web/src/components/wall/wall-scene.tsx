import { Stats } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
	DepthOfField,
	EffectComposer,
	Vignette,
} from "@react-three/postprocessing";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import {
	GRID_SCROLL_DURATION_MS,
	smoothScrollTo,
} from "#/components/collection-grid";
import {
	makeGrooveTexture,
	type StreamTarget,
	useTextureStream,
} from "#/components/three/texture-stream";
import type { PublicRecord } from "#/lib/records";
import { Dust } from "./dust";

/**
 * Prototype: the collection grid as records hung on a dark, gently curved
 * wall. The canvas sits fixed *behind* the page (see `WallGrid`), which
 * reserves the grid's space with a slot element; the camera tracks that
 * slot's position on screen, so native page scroll moves the wall exactly
 * like it moved the DOM grid — header, filters and footer scroll over it.
 *
 * - The wall curves away above and below the middle of the screen, and depth
 *   of field focuses on the middle, so rows blur as they recede.
 * - The camera drifts with the pointer (parallax against wall and dust), and a
 *   spotlight follows the cursor, throwing each cover's shadow on the wall.
 * - The hovered record lifts off the wall and its vinyl slides out. On touch,
 *   the record at the centre of the screen is the "hovered" one.
 *
 * Page content covers the canvas, so the canvas never gets pointer events
 * itself. The scene tracks the pointer on `window` and raycasts against the
 * visible records itself (once per frame for hover, once per click) — and
 * only for events whose DOM target is the slot, never through the header,
 * the filters or an open record panel. (R3F's own per-mesh events, driven
 * from `document.body`, intermittently stopped reporting hovers after a
 * re-filter; doing it by hand is also cheaper than R3F tracking every record
 * as interactive.)
 */

const TILE = 1;
const GAP = 0.24;
const PITCH = TILE + GAP;
const SLEEVE_DEPTH = 0.02;
const FOV = 30;
/**
 * How far the wall bows away at the top/bottom edge of the screen, in world
 * units. Relative to the view height so a tall phone screen curves the same
 * as a wide desktop one.
 */
const CURVE_DEPTH = 0.45;
/** How far a hovered record comes off the wall. */
const LIFT_Z = 0.42;
/** How far the hovered record's vinyl slides out to the right. */
const DISC_SLIDE = 0.4;
const WALL_Z = -0.32;
/** Space above the first row / below the last, in world units. */
const TOP_PAD = 0.1;
const BOTTOM_PAD = 0.45;
/** Clearance kept between the selected record and the record panel's edge. */
const PANEL_MARGIN = 0.35;

const SIZE_SCALE: Record<string, number> = {
	'12"': 1,
	'10"': 0.86,
	'7"': 0.72,
};

export type WallTheme = {
	dark: boolean;
	/** Page background — also the wall's colour. */
	background: string;
	/** Cover colour until its texture loads. */
	placeholder: string;
};

export type WallSceneProps = {
	records: PublicRecord[];
	/** The in-page element that reserves the wall's space. */
	slot: HTMLElement;
	onActiveChange: (index: number | null) => void;
	onOpen: (record: PublicRecord) => void;
	/**
	 * The record the panel has open, if any: it stays lifted and lit, the page
	 * scrolls to keep it in view as the panel pages, and the camera pans right
	 * just enough to keep it clear of the panel.
	 */
	focusedRecordId: number | null;
	/** The slot height the wall needs, in CSS px. */
	onContentHeight: (px: number) => void;
	theme: WallTheme;
	isTouch: boolean;
	showStats?: boolean;
};

/**
 * Memoised: `WallGrid` re-renders whenever the active record changes (its
 * now-showing bar), and that must not re-render 300 tiles with it.
 */
export default memo(function WallScene(props: WallSceneProps) {
	return (
		<Canvas
			dpr={[1, 2]}
			shadows={props.isTouch ? false : "percentage"}
			camera={{ fov: FOV, near: 0.1, far: 60, position: [0, 0, 10] }}
			gl={{ antialias: false, alpha: false }}
		>
			<Wall {...props} />
			<Effects isTouch={props.isTouch} dark={props.theme.dark} />
			{props.showStats && <Stats />}
		</Canvas>
	);
});

function Effects({ isTouch, dark }: { isTouch: boolean; dark: boolean }) {
	const camera = useThree((s) => s.camera);
	// The wall's centre sits at z = 0 and the camera looks straight at it.
	const focus = camera.position.z;
	return (
		<EffectComposer multisampling={isTouch ? 0 : 4}>
			<DepthOfField
				focusDistance={focus}
				focusRange={1.1}
				bokehScale={isTouch ? 2 : 3.5}
				resolutionScale={isTouch ? 0.35 : 0.5}
			/>
			<Vignette offset={0.25} darkness={dark ? 0.75 : 0.35} />
		</EffectComposer>
	);
}

function columnsFor(width: number) {
	if (width < 640) return 3;
	if (width < 1100) return 5;
	return 7;
}

type TileHandle = StreamTarget & {
	group: THREE.Group;
	sleeve: THREE.Mesh;
	disc: THREE.Mesh;
	scale: number;
};

type Shared = {
	sleeveGeometry: THREE.BoxGeometry;
	discGeometry: THREE.CylinderGeometry;
	edge: THREE.MeshStandardMaterial;
	grooves: THREE.Texture;
};

function Wall({
	records,
	slot,
	onActiveChange,
	onOpen,
	focusedRecordId,
	onContentHeight,
	theme,
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
	const distance = (gridWidth * 1.2) / 2 / (tanHalf * aspect);
	const viewHeight = 2 * distance * tanHalf;
	const viewWidth = viewHeight * aspect;
	const unitsPerPx = viewHeight / size.height;
	const wallHeight = TOP_PAD + rows * PITCH - GAP + BOTTOM_PAD;

	useEffect(() => {
		onContentHeight(wallHeight / unitsPerPx);
	}, [wallHeight, unitsPerPx, onContentHeight]);

	// Grid slot plus a little depth jitter, so the parallax has layers.
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

	const shared = useMemo<Shared>(() => {
		const sleeveGeometry = new THREE.BoxGeometry(TILE, TILE, SLEEVE_DEPTH);
		const discGeometry = new THREE.CylinderGeometry(0.46, 0.46, 0.006, 96);
		discGeometry.rotateX(Math.PI / 2);
		const edge = new THREE.MeshStandardMaterial({ roughness: 0.9 });
		return {
			sleeveGeometry,
			discGeometry,
			edge,
			grooves: makeGrooveTexture(),
		};
	}, []);

	const handles = useRef<(TileHandle | null)[]>([]);
	const lift = useRef(new Float32Array(0));
	if (lift.current.length !== records.length) {
		lift.current = new Float32Array(records.length);
	}
	const recordsRef = useRef(records);
	recordsRef.current = records;
	const hovered = useRef<number | null>(null);
	const active = useRef<number | null>(null);
	const lastCenter = useRef(-1);
	const parallax = useRef(new THREE.Vector2());
	const spot = useRef<THREE.SpotLight>(null);
	const wall = useRef<THREE.Mesh>(null);
	/** Camera travel down the wall, in world units (drives the dust). */
	const travel = useRef(0);
	const getTravel = useCallback(() => travel.current, []);
	/** Rightward camera pan that keeps the selected record clear of the panel. */
	const panelShift = useRef(0);

	const focusedIndex = useMemo(
		() =>
			focusedRecordId == null
				? -1
				: records.findIndex((r) => r.id === focusedRecordId),
		[records, focusedRecordId],
	);
	const focusedRef = useRef(focusedIndex);
	focusedRef.current = focusedIndex;

	// Keep the selected record on screen as the panel pages through records —
	// the same eased scroll the DOM grid uses. The first run (a direct link to
	// a record) jumps straight there instead.
	const firstFocus = useRef(true);
	useEffect(() => {
		if (focusedIndex < 0) return;
		const row = Math.floor(focusedIndex / cols);
		const slotDocTop = slot.getBoundingClientRect().top + window.scrollY;
		const fromSlotTop = (TOP_PAD + TILE / 2 + row * PITCH) / unitsPerPx;
		const target = slotDocTop + fromSlotTop - window.innerHeight / 2;
		const reduced = window.matchMedia(
			"(prefers-reduced-motion: reduce)",
		).matches;
		if (firstFocus.current || reduced) window.scrollTo(0, target);
		else smoothScrollTo(target, GRID_SCROLL_DURATION_MS);
		firstFocus.current = false;
	}, [focusedIndex, cols, unitsPerPx, slot]);

	// The shadow-catching wall bows back exactly like the records do (see the
	// curve in the frame loop), so a record never passes through it.
	const wallGeometry = useMemo(() => {
		const g = new THREE.PlaneGeometry(viewWidth * 3, viewHeight * 3, 1, 120);
		const pos = g.attributes.position;
		const half = viewHeight / 2;
		for (let i = 0; i < pos.count; i++) {
			const dy = pos.getY(i) / half;
			pos.setZ(i, -CURVE_DEPTH * dy * dy);
		}
		g.computeVertexNormals();
		return g;
	}, [viewWidth, viewHeight]);
	useEffect(() => () => wallGeometry.dispose(), [wallGeometry]);
	const lookAt = useMemo(() => new THREE.Vector3(), []);
	const raycaster = useMemo(() => new THREE.Raycaster(), []);
	/** Pointer in NDC (-1…1), and whether it's over the slot right now. */
	const pointer = useRef({ ndc: new THREE.Vector2(), overSlot: false });
	/** Sleeves drawn last frame — the only things worth raycasting. */
	const pickable = useRef<THREE.Mesh[]>([]);

	const pick = useCallback(
		(ndc: THREE.Vector2): number | null => {
			raycaster.setFromCamera(ndc, camera);
			const hit = raycaster.intersectObjects(pickable.current, false)[0];
			const index = hit?.object.userData.index;
			return typeof index === "number" ? index : null;
		},
		[raycaster, camera],
	);

	// Pointer + click, from `window` (the page covers the canvas).
	useEffect(() => {
		if (isTouch) return;
		const toNdc = (e: MouseEvent) =>
			pointer.current.ndc.set(
				(e.clientX / window.innerWidth) * 2 - 1,
				-(e.clientY / window.innerHeight) * 2 + 1,
			);
		const onMove = (e: PointerEvent) => {
			toNdc(e);
			pointer.current.overSlot = e.target === slot;
		};
		const onClick = (e: MouseEvent) => {
			if (e.target !== slot) return;
			const index = pick(toNdc(e));
			if (index != null) onOpen(recordsRef.current[index]);
		};
		window.addEventListener("pointermove", onMove, { passive: true });
		window.addEventListener("click", onClick);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("click", onClick);
			document.body.style.cursor = "";
		};
	}, [isTouch, slot, pick, onOpen]);

	const getTarget = useCallback((i: number) => handles.current[i], []);
	const textures = useTextureStream(records, getTarget, {
		// Phone tiles are ~120 CSS px wide; 256px covers are plenty there.
		coverPx: isTouch ? 256 : 512,
		window: cols * 4,
		discWindow: cols,
		cacheMax: cols * 12,
	});

	// A re-filter changes what's at the centre — force a texture pass.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above
	useEffect(() => {
		lastCenter.current = -1;
		hovered.current = null;
	}, [records]);

	// Theme: sleeve edges and not-yet-loaded covers follow light/dark.
	useEffect(() => {
		shared.edge.color.set(theme.dark ? "#3a3632" : "#d6d0c4");
		for (const h of handles.current) {
			if (!h) continue;
			h.cover.userData.placeholder = theme.placeholder;
			if (!h.cover.map) h.cover.color.set(theme.placeholder);
		}
	}, [theme, shared]);

	useEffect(() => {
		if (spot.current) {
			spot.current.shadow.mapSize.set(1024, 1024);
			spot.current.shadow.bias = -0.0004;
		}
	}, []);

	useFrame((state, delta) => {
		const dt = Math.min(delta, 0.05);
		const t = state.clock.elapsedTime;
		const ndc = pointer.current.ndc;

		// Where the slot's top edge is on screen → where row 0 sits in the
		// view. Row 0's top edge (y = TILE / 2) lines up with the slot's top.
		const slotTop = slot.getBoundingClientRect().top;
		const camY = TILE / 2 + TOP_PAD - (size.height / 2 - slotTop) * unitsPerPx;
		travel.current = -camY;
		const focused = focusedRef.current;

		// With the record panel open, pan right just enough that the selected
		// record sits clear of the panel's left edge (desktop — on phones the
		// panel covers everything anyway).
		let shiftGoal = 0;
		if (focused >= 0 && !isTouch) {
			const panel = document.querySelector('[data-slot="sheet-content"]');
			const left = panel?.getBoundingClientRect().left ?? size.width;
			if (left > size.width * 0.3) {
				const visibleRight = ((left / size.width) * 2 - 1) * (viewWidth / 2);
				const tileRight = layout[focused].x + TILE / 2 + PANEL_MARGIN;
				shiftGoal = Math.max(0, tileRight - visibleRight);
			}
		}
		panelShift.current = THREE.MathUtils.damp(
			panelShift.current,
			shiftGoal,
			4,
			dt,
		);

		// Parallax: the camera drifts toward the pointer (a slow idle sway on
		// touch, where there's no pointer to follow).
		const goalX = isTouch ? Math.sin(t * 0.3) * 0.12 : ndc.x * 0.18;
		const goalY = isTouch ? Math.cos(t * 0.23) * 0.08 : ndc.y * 0.14;
		const p = parallax.current;
		p.x = THREE.MathUtils.damp(p.x, goalX, 3, dt);
		p.y = THREE.MathUtils.damp(p.y, goalY, 3, dt);
		camera.position.set(p.x + panelShift.current, camY + p.y, distance);
		lookAt.set(panelShift.current, camY, 0);
		camera.lookAt(lookAt);
		camera.updateMatrixWorld();

		const centerRow = Math.round(-camY / PITCH);
		// Desktop: whatever's under the pointer. Touch has no hover: the record
		// at the centre of the screen is it, while the wall is on screen.
		if (focused >= 0) {
			hovered.current = focused;
		} else if (!isTouch) {
			hovered.current = pointer.current.overSlot ? pick(ndc) : null;
			document.body.style.cursor = hovered.current == null ? "" : "pointer";
		} else {
			const onScreen = centerRow >= 0 && centerRow < rows;
			hovered.current = onScreen
				? Math.min(records.length - 1, centerRow * cols + Math.floor(cols / 2))
				: null;
		}
		if (hovered.current !== active.current) {
			active.current = hovered.current;
			onActiveChange(active.current);
		}

		const clampedRow = Math.min(rows - 1, Math.max(0, centerRow));
		const centerIndex = Math.min(
			records.length - 1,
			clampedRow * cols + Math.floor(cols / 2),
		);
		if (centerIndex !== lastCenter.current) {
			lastCenter.current = centerIndex;
			textures.update(centerIndex);
		}
		textures.flush(isTouch ? 1 : 2);

		// The spotlight tracks the pointer across the wall (on touch, it rests
		// on the centred record; with the panel open, on the selected one).
		let lightX = isTouch ? 0 : (ndc.x * viewWidth) / 2 + panelShift.current;
		let lightY = isTouch ? camY : camY + (ndc.y * viewHeight) / 2;
		if (focused >= 0) {
			lightX = layout[focused].x;
			lightY = layout[focused].y;
		}
		if (spot.current) {
			const s = spot.current;
			s.position.x = THREE.MathUtils.damp(s.position.x, lightX, 5, dt);
			s.position.y = THREE.MathUtils.damp(s.position.y, lightY + 0.6, 5, dt);
			s.position.z = 3.4;
			s.target.position.set(s.position.x, s.position.y - 0.6, 0);
			s.target.updateMatrixWorld();
		}
		if (wall.current) wall.current.position.y = camY;

		// Only rows near the viewport are animated (and drawn, and pickable).
		const halfRows = Math.ceil(viewHeight / 2 / PITCH) + 2;
		pickable.current.length = 0;
		for (let i = 0; i < records.length; i++) {
			const h = handles.current[i];
			if (!h) continue;
			const pos = layout[i];
			const row = Math.floor(i / cols);
			const visible = Math.abs(row - centerRow) <= halfRows;
			h.group.visible = visible;
			if (!visible) {
				lift.current[i] = 0;
				continue;
			}
			pickable.current.push(h.sleeve);
			const goal = hovered.current === i ? 1 : 0;
			const l = THREE.MathUtils.damp(lift.current[i], goal, 9, dt);
			lift.current[i] = l;

			// The curve: rows recede (and tip back) the further they are from
			// the middle of the screen, which the depth of field then blurs.
			const half = viewHeight / 2;
			const dy = (pos.y - camY) / half;
			h.group.position.set(
				pos.x,
				pos.y,
				pos.z - CURVE_DEPTH * dy * dy + l * LIFT_Z,
			);
			h.group.rotation.x =
				-Math.atan((2 * CURVE_DEPTH * dy) / half) + l * -ndc.y * 0.18;
			h.group.rotation.y = -pos.x * 0.035 + l * ndc.x * 0.25;
			h.group.scale.setScalar(h.scale * (1 + l * 0.05));

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

	return (
		<>
			<color attach="background" args={[theme.background]} />
			{/* Touch gets more fill light: its spotlight can't follow a pointer, so it
			    can't sweep light over the rows above and below the middle. */}
			<ambientLight
				intensity={(theme.dark ? 0.3 : 0.8) + (isTouch ? 0.35 : 0)}
			/>
			<hemisphereLight args={["#fff6e0", "#20160c", theme.dark ? 0.3 : 0.5]} />
			<spotLight
				ref={spot}
				color="#ffe7c2"
				intensity={theme.dark ? 26 : 14}
				angle={isTouch ? 0.9 : 0.6}
				penumbra={1}
				distance={12}
				decay={1.6}
				castShadow={!isTouch}
			/>
			{/* The wall the records hang on — there to catch shadows. */}
			<mesh
				ref={wall}
				geometry={wallGeometry}
				position={[0, 0, WALL_Z]}
				receiveShadow
			>
				<meshStandardMaterial color={theme.background} roughness={1} />
			</mesh>
			{/* Dust in two layers: a fine one just off the wall that drifts slower
			    than the scroll, and a sparse, larger one near the camera that
			    moves faster (and lands in the depth of field's blur). */}
			<Dust
				count={isTouch ? 40 : 90}
				width={viewWidth * 1.2}
				height={viewHeight * 1.6}
				depth={0.5}
				z={0.1}
				parallax={0.75}
				size={1.6}
				opacity={theme.dark ? 0.35 : 0.22}
				color={theme.dark ? "#fff1d0" : "#8a7a5a"}
				getScroll={getTravel}
			/>
			<Dust
				count={isTouch ? 14 : 36}
				width={viewWidth}
				height={viewHeight * 1.6}
				depth={1.5}
				z={2.4}
				parallax={1.45}
				size={2.6}
				opacity={theme.dark ? 0.3 : 0.18}
				color={theme.dark ? "#fff1d0" : "#8a7a5a"}
				getScroll={getTravel}
			/>
			{records.map((record, i) => (
				<Tile
					key={record.id}
					index={i}
					record={record}
					shared={shared}
					placeholder={theme.placeholder}
					register={register}
				/>
			))}
		</>
	);
}

const Tile = memo(function Tile({
	index,
	record,
	shared,
	placeholder,
	register,
}: {
	index: number;
	record: PublicRecord;
	shared: Shared;
	placeholder: string;
	register: (index: number, handle: TileHandle | null) => void;
}) {
	const group = useRef<THREE.Group>(null);
	const sleeve = useRef<THREE.Mesh>(null);
	const disc = useRef<THREE.Mesh>(null);
	const scale = SIZE_SCALE[record.size ?? ""] ?? 1;
	// Created once per record; theme changes are applied by `Wall`.
	// biome-ignore lint/correctness/useExhaustiveDependencies: placeholder is read once at creation
	const cover = useMemo(() => {
		const m = new THREE.MeshStandardMaterial({
			color: placeholder,
			roughness: 0.6,
		});
		m.userData.placeholder = placeholder;
		return m;
	}, [record]);
	const discMaterial = useMemo(() => {
		const m = new THREE.MeshStandardMaterial({
			color: "#181818",
			roughness: 0.3,
			metalness: 0.45,
			bumpMap: shared.grooves,
			bumpScale: 0.6,
			roughnessMap: shared.grooves,
			transparent: !!record.colorTranslucent,
			opacity: record.colorTranslucent ? 0.72 : 1,
		});
		m.userData.placeholder = "#181818";
		return m;
	}, [record, shared]);
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

	// Materials live as long as the record does — disposed on unmount only,
	// not when a re-filter merely moves this record to a new index.
	useEffect(
		() => () => {
			cover.dispose();
			discMaterial.dispose();
		},
		[cover, discMaterial],
	);

	useEffect(() => {
		if (!group.current || !sleeve.current || !disc.current) return;
		// The picker reads the index straight off the hit mesh.
		sleeve.current.userData.index = index;
		register(index, {
			group: group.current,
			sleeve: sleeve.current,
			disc: disc.current,
			cover,
			discMaterial,
			scale,
		});
		return () => register(index, null);
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
			<mesh
				ref={sleeve}
				geometry={shared.sleeveGeometry}
				material={materials}
				castShadow
			/>
		</group>
	);
});
