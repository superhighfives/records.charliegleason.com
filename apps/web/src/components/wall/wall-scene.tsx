import { Stats } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
	EffectComposer,
	ToneMapping,
	Vignette,
} from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import {
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import * as THREE from "three";
import {
	computeSpanningIds,
	GRID_SCROLL_DURATION_MS,
	hasNotes,
	smoothScrollTo,
	TILE_MIN_PX,
} from "#/components/collection-grid";
import { SceneStatsProbe } from "#/components/three/scene-stats-probe";
import {
	makeGrooveTexture,
	makeVinylTexture,
	type StreamTarget,
	useTextureStream,
} from "#/components/three/texture-stream";
import { displayCoverKey } from "#/lib/cover";
import type { PublicRecord } from "#/lib/records";
import {
	makeCoverMaterial,
	type RevealStyle,
	setCoverDirection,
	setCoverFade,
	setCoverReveal,
	setCoverSelfLight,
	setCoverSpan,
	setCoverStyle,
	setCoverTheme,
} from "./cover-reveal";
import { Dust } from "./dust";
import { loadNoteFont, makeNoteTexture, noteExcerpt } from "./note-texture";
import { packDense } from "./pack";
import { WhitePointEffect } from "./white-point";

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
/**
 * Spotlight peak. Kept modest: a lifted record sits closer to the light, so
 * it's hit harder than the wall around it, and a hotter spot washed covers
 * out — and with the torch following the pointer, each record it crossed
 * flared from dim to bright.
 */
const SPOT_DARK = 7;
/**
 * The torch's cone. Its soft edge (penumbra 1) fades across the whole cone,
 * so a wider one spreads the fade: records brighten gradually as the torch
 * nears rather than snapping lit as it crosses them.
 */
const SPOT_ANGLE = 0.85;
const SPOT_ANGLE_TOUCH = 0.95;
const ZERO2 = new THREE.Vector2();
/** How much each cover lights itself, per theme — see `uSelfLight`. */
const SELF_LIGHT_DARK = 0.55;
const SELF_LIGHT_LIGHT = 0.3;
/** How long a record takes to emerge once its cover image arrives. */
/** The plain fade as a cover's image arrives. */
const FADE_S = 0.3;

/**
 * A critically damped spring toward `target` (Unity's SmoothDamp): unlike
 * plain exponential easing it accelerates in as well as settling out, so a
 * jump in target reads as a glide rather than a lurch. `velocities[key]`
 * carries the spring's speed between frames.
 */
function smoothDamp(
	current: number,
	target: number,
	velocities: Record<string, number>,
	key: string,
	smoothTime: number,
	dt: number,
): number {
	const omega = 2 / smoothTime;
	const x = omega * dt;
	const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
	const change = current - target;
	const velocity = velocities[key] ?? 0;
	const temp = (velocity + omega * change) * dt;
	velocities[key] = (velocity - omega * temp) * decay;
	return target + (change + temp) * decay;
}

/** Gentler than the grid's expo curve — paging the wall glides, not snaps. */
function easeInOutCubic(t: number): number {
	return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}
const SPOT_LIGHT = 3;
/**
 * Light mode is a daylit gallery rather than a dark room: a white wall, soft
 * daylight from the upper left so every record casts a gentle shadow, and
 * only a faint highlight following the cursor (a torch makes no sense in a
 * lit room).
 */
const DAYLIGHT = 1.2;
/** Space above the first row / below the last, in world units. */
const TOP_PAD = 0.1;
const BOTTOM_PAD = 0.45;
/**
 * A record with notes has a slip of paper tucked into its sleeve, peeking out
 * of the top — the wall's version of the DOM grid's yellow notes dot.
 */
const SLIP_W = 0.4;
const SLIP_H = 0.3;
/** How far the slip pokes above the sleeve at rest, and extra on hover. */
const SLIP_PEEK = 0.115;
const SLIP_PULL = 0.07;
/** Clearance kept between the selected record and the record panel's edge. */
/** Most the camera closes in on a selected record (a share of its distance). */
const FOCUS_ZOOM = 0.38;
/** The camera's move to (and between, and away from) a selected record. */
const CAMERA_MOVE_S = 0.9;
/** The record panel's width (`sm:max-w-md`), for framing beside it. */
const PANEL_PX = 448;
/** How far the pointer moves before a press on the wall is a drag. */
const DRAG_PX = 5;

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

/** Prototype controls for how records appear (see the reveal panel). */
export type RevealConfig = {
	style: RevealStyle;
};

export type WallSceneProps = {
	records: PublicRecord[];
	/** The in-page element that reserves the wall's space. */
	slot: HTMLElement;
	onActiveChange: (index: number | null) => void;
	onOpen: (record: PublicRecord) => void;
	/** Closes the record panel (a click on the empty wall while it's open). */
	onClose: () => void;
	/**
	 * The record the panel has open, if any: it stays lifted and lit, the page
	 * scrolls to keep it in view as the panel pages, and the camera pans right
	 * just enough to keep it clear of the panel.
	 */
	focusedRecordId: number | null;
	/** The slot height the wall needs, in CSS px. */
	onContentHeight: (px: number) => void;
	theme: WallTheme;
	reveal: RevealConfig;
	isTouch: boolean;
	showStats?: boolean;
};

/**
 * Memoised: `WallGrid` re-renders whenever the active record changes (its
 * now-showing bar), and that must not re-render 300 tiles with it.
 */
export default memo(function WallScene(props: WallSceneProps) {
	const dpr = useBudgetDpr();
	return (
		<Canvas
			dpr={dpr}
			shadows={props.isTouch ? false : "percentage"}
			camera={{ fov: FOV, near: 0.1, far: 60, position: [0, 0, 10] }}
			// Transparent: the wall draws above the page (see `WallGrid`), so
			// the page's own black / white is its background.
			gl={{ antialias: false, alpha: true }}
			// R3F's wrapper sets its own pointer-events inline; the wall never
			// takes a click itself (see `WallGrid`).
			style={{ pointerEvents: "none" }}
			// Tone mapping happens once, at the end of the effect chain (see
			// `Effects`), not in the renderer.
			flat
		>
			<Wall {...props} />
			<Effects
				// Past ~1.5x the pixels are fine enough that multisampling
				// (four samples a pixel, on the biggest buffer in the frame)
				// costs far more than it shows.
				multisample={!props.isTouch && dpr < 1.5}
				dark={props.theme.dark}
			/>
			{props.showStats && <Stats />}
			<SceneStatsProbe />
		</Canvas>
	);
});

function Effects({
	multisample,
	dark,
}: {
	multisample: boolean;
	dark: boolean;
}) {
	// Neutral (Khronos) tone mapping keeps colours faithful — the ACES default
	// greyed and desaturated covers, and turned the light theme's white wall
	// to mud — and the white point puts its whites back at true white.
	const whitePoint = useMemo(() => new WhitePointEffect(), []);
	useEffect(() => () => whitePoint.dispose(), [whitePoint]);
	const finish = (
		<>
			{/* Only in the dark: on white it greyed the corners. */}
			<Vignette offset={0.25} darkness={dark ? 0.75 : 0} />
			<ToneMapping mode={ToneMappingMode.NEUTRAL} />
			<primitive object={whitePoint} />
		</>
	);
	// No focus blur. Depth of field (and then a cheaper tilt-shift) softened
	// the rows curving away, but blurring bright covers on the dark wall bled
	// them into glowing halos and hazed a large selected record — and it was
	// the single biggest cost on the wall.
	return (
		<EffectComposer multisampling={multisample ? 4 : 0}>
			{finish}
		</EffectComposer>
	);
}

/**
 * Most device pixels the canvas draws. Every full-screen pass (vignette,
 * tone mapping) pays per pixel, and a large retina display
 * at 2x is 12M+ of them: a 2305×1363 window measured 25fps at 2x, GPU-bound.
 * Capping the total instead of the ratio keeps small screens at full
 * sharpness and scales big ones back.
 */
const PIXEL_BUDGET = 4.2e6;

function useBudgetDpr() {
	const [dpr, setDpr] = useState(1);
	useEffect(() => {
		const update = () => {
			const area = window.innerWidth * window.innerHeight;
			const fit = Math.sqrt(PIXEL_BUDGET / Math.max(1, area));
			const next = Math.min(window.devicePixelRatio || 1, 2, fit);
			setDpr(Math.max(0.75, Math.round(next * 20) / 20));
		};
		update();
		window.addEventListener("resize", update);
		return () => window.removeEventListener("resize", update);
	}, []);
	return dpr;
}

/** The DOM grid's 1.25rem gap, for matching its column count. */
const DOM_GAP_PX = 20;

/**
 * Same column count the DOM grid's `repeat(auto-fill, minmax(180px, 1fr))`
 * gives for this width — never fewer than three, so a phone still reads as a
 * wall rather than a list.
 */
function columnsFor(slotWidth: number) {
	return Math.max(
		3,
		Math.floor((slotWidth + DOM_GAP_PX) / (TILE_MIN_PX + DOM_GAP_PX)),
	);
}

type TileHandle = StreamTarget & {
	group: THREE.Group;
	sleeve: THREE.Mesh;
	disc: THREE.Mesh;
	/** The tucked-in note slip, for records with notes. */
	slip: THREE.Mesh | null;
	scale: number;
};

/** Where a record is drawn right now, easing toward its packed slot. */
type TileAnim = { x: number; y: number; spanScale: number; presence: number };

/** A record filtered out, kept around while it sinks back into the wall. */
type Exiting = {
	record: PublicRecord;
	anim: TileAnim;
	z: number;
	row: number;
	span: number;
};

type Shared = {
	sleeveGeometry: THREE.BoxGeometry;
	discGeometry: THREE.CylinderGeometry;
	edge: THREE.MeshStandardMaterial;
	grooves: THREE.Texture;
	vinyl: THREE.Texture;
	slipGeometry: THREE.PlaneGeometry;
	slip: THREE.MeshStandardMaterial;
};

function Wall({
	records,
	slot,
	onActiveChange,
	onOpen,
	onClose,
	focusedRecordId,
	onContentHeight,
	theme,
	reveal,
	isTouch,
}: WallSceneProps) {
	const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
	const size = useThree((s) => s.size);
	// The wall spans the slot's full width (the page's content column, same
	// as the filter strip above it). `size` changing re-renders this, which
	// re-reads the slot after any resize.
	const slotWidth = slot.clientWidth || size.width;
	const cols = columnsFor(slotWidth);

	// Dense-packed exactly like the DOM grid: the same records (some of those
	// with notes) take a 2×2 slot, and later 1×1s backfill around them.
	const packed = useMemo(() => {
		const spanning = computeSpanningIds(records);
		return packDense(
			records.map((r) => (spanning.has(r.id) ? 2 : 1)),
			cols,
		);
	}, [records, cols]);
	const rows = packed.rows;

	const gridWidth = cols * PITCH - GAP;
	const tanHalf = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
	const aspect = size.width / size.height;
	const viewWidthFit = (gridWidth * size.width) / slotWidth;
	const distance = viewWidthFit / 2 / (tanHalf * aspect);
	const viewHeight = 2 * distance * tanHalf;
	const viewWidth = viewHeight * aspect;
	const unitsPerPx = viewHeight / size.height;
	const wallHeight = TOP_PAD + rows * PITCH - GAP + BOTTOM_PAD;

	useEffect(() => {
		onContentHeight(wallHeight / unitsPerPx);
	}, [wallHeight, unitsPerPx, onContentHeight]);

	// Each record's centre (a 2×2 sits over its four cells) plus a little
	// depth jitter, so the parallax has layers to work with.
	const layout = useMemo(
		() =>
			records.map((record, i) => {
				const { col, row, span } = packed.placements[i];
				const jitter = Math.sin(record.id * 12.9898) * 43758.5453;
				return {
					x: (col + (span - 1) / 2 - (cols - 1) / 2) * PITCH,
					y: -(row + (span - 1) / 2) * PITCH,
					z: (jitter - Math.floor(jitter) - 0.5) * 0.14,
					row,
					span,
					/** World size relative to a 1×1 — a 2×2 also covers the gap. */
					spanScale: (span * PITCH - GAP) / TILE,
				};
			}),
		[records, cols, packed],
	);
	const layoutRef = useRef(layout);
	layoutRef.current = layout;
	/** The record covering a cell, or the nearest one along its row. */
	const recordAt = useCallback(
		(row: number, col: number) => {
			const r = Math.min(rows - 1, Math.max(0, row));
			for (let d = 0; d < cols; d++) {
				for (const c of [col - d, col + d]) {
					if (c < 0 || c >= cols) continue;
					const i = packed.cells[r * cols + c];
					if (i >= 0) return i;
				}
			}
			return 0;
		},
		[packed, rows, cols],
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
			vinyl: makeVinylTexture(),
			slipGeometry: new THREE.PlaneGeometry(SLIP_W, SLIP_H),
			// The brand yellow the DOM grid's notes dot used, as paper.
			slip: new THREE.MeshStandardMaterial({
				color: "#eab308",
				roughness: 0.85,
				side: THREE.DoubleSide,
			}),
		};
	}, []);

	const handles = useRef<(TileHandle | null)[]>([]);
	const lift = useRef(new Float32Array(0));
	if (lift.current.length !== records.length) {
		lift.current = new Float32Array(records.length);
	}
	const recordsRef = useRef(records);
	recordsRef.current = records;

	// Filtering animates: records that stay glide to their new slot, new ones
	// rise out of the wall and grow in, and filtered-out ones sink back into
	// it (kept in `exiting` until they're gone). Keyed by record id, since a
	// re-filter moves every index.
	const anims = useRef(new Map<number, TileAnim>());
	/** False until the first re-filter — the initial load doesn't animate in. */
	const animateIn = useRef(false);
	const [exiting, setExiting] = useState<Exiting[]>([]);
	const exitingRef = useRef(exiting);
	exitingRef.current = exiting;
	const exitHandles = useRef(new Map<number, TileHandle>());
	const prevRecords = useRef(records);
	const prevLayout = useRef<typeof layout>(layout);
	useEffect(() => {
		const before = prevRecords.current;
		const beforeLayout = prevLayout.current;
		prevRecords.current = records;
		prevLayout.current = layout;
		if (before === records) return;
		animateIn.current = true;
		const kept = new Set(records.map((r) => r.id));
		// A record filtered back in mid-exit picks up from where it was.
		for (const e of exitingRef.current) {
			if (kept.has(e.record.id)) anims.current.set(e.record.id, e.anim);
		}
		const leaving: Exiting[] = [];
		before.forEach((record, i) => {
			if (kept.has(record.id)) return;
			const anim = anims.current.get(record.id);
			anims.current.delete(record.id);
			const pos = beforeLayout[i];
			if (!anim || !pos) return;
			leaving.push({ record, anim, z: pos.z, row: pos.row, span: pos.span });
		});
		setExiting((current) => [
			...current.filter((e) => !kept.has(e.record.id)),
			...leaving,
		]);
	}, [records, layout]);
	const reducedMotion = useMemo(
		() => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
		[],
	);

	const hovered = useRef<number | null>(null);
	const active = useRef<number | null>(null);
	const lastCenter = useRef(-1);
	const parallax = useRef(new THREE.Vector2());
	const spot = useRef<THREE.SpotLight>(null);
	const ambient = useRef<THREE.AmbientLight>(null);
	const hemi = useRef<THREE.HemisphereLight>(null);
	// Touch gets more fill light: its spotlight can't follow a pointer, so it
	// can't sweep light over the rows above and below the middle.
	// A soft, even fill over the whole wall, so covers keep their detail
	// rather than only reading where the torch lands.
	const ambientBase = (theme.dark ? 0.6 : 1) + (isTouch ? 0.35 : 0);
	const hemiBase = theme.dark ? 0.4 : 0.45;
	const sun = useRef<THREE.DirectionalLight>(null);
	/** Velocities for the `smoothDamp` springs (spotlight, panel pan). */
	const springs = useRef<Record<string, number>>({});
	/** 0 → 1 as a record is selected: house lights down, spotlight on it. */
	const lightsDown = useRef(0);
	const wall = useRef<THREE.Mesh>(null);
	/** Camera travel down the wall, in world units (drives the dust). */
	const travel = useRef(0);
	const getTravel = useCallback(() => travel.current, []);
	/** The camera's x across the wall (centred on a selected record). */
	const panelShift = useRef(0);
	/** How far the camera has moved in on a selected record (0–1 of its distance). */
	const zoom = useRef(0);
	/**
	 * The camera's place — x, y down the wall, zoom — and the one eased move
	 * between where it was and where it's going: following the scroll, or
	 * framing a selected record. One tween for all three keeps the move a
	 * straight, smooth ease; separate springs (and the page scrolling under
	 * them) drew it as an S.
	 */
	const cam = useRef({ x: 0, y: Number.NaN, zoom: 0 });
	const camTween = useRef({
		x: 0,
		y: 0,
		zoom: 0,
		t: 1,
		key: -1,
		/** Where the spotlight was when the move began: it travels with it. */
		lightX: 0,
		lightY: 0,
		/** How far the lights were down when the move began. */
		down: 0,
	});
	/** Dragged offset while zoomed in on a record, in world units. */
	const pan = useRef({ x: 0, y: 0 });
	/** A record picked by letting go of a drag, until the route catches up. */
	const pendingFocus = useRef<number | null>(null);
	/** Where on the wall a selected record is framed (for picking the nearest). */
	const frameOffset = useRef(0);

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
		const { row, span } = layout[focusedIndex];
		const targetY = () => {
			const slotDocTop = slot.getBoundingClientRect().top + window.scrollY;
			const fromSlotTop =
				(TOP_PAD + row * PITCH + (span * PITCH - GAP) / 2) / unitsPerPx;
			return slotDocTop + fromSlotTop - window.innerHeight / 2;
		};
		const reduced = window.matchMedia(
			"(prefers-reduced-motion: reduce)",
		).matches;
		if (!firstFocus.current && !reduced) {
			smoothScrollTo(targetY(), GRID_SCROLL_DURATION_MS, easeInOutCubic);
			return;
		}
		firstFocus.current = false;
		// A direct link lands before the slot has grown to the wall's height —
		// scrolling then gets clamped to the still-short page (it ended up at
		// the footer). Wait, a few frames at most, for the full height.
		const fullHeight = wallHeight / unitsPerPx;
		let raf = 0;
		let tries = 0;
		const jump = () => {
			if (slot.offsetHeight + 1 < fullHeight && tries++ < 60) {
				raf = requestAnimationFrame(jump);
				return;
			}
			window.scrollTo(0, targetY());
		};
		jump();
		return () => cancelAnimationFrame(raf);
	}, [focusedIndex, layout, unitsPerPx, slot, wallHeight]);

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
	/** Records drawn last frame — the only ones worth testing. */
	const pickable = useRef<number[]>([]);
	/** The camera height the last frame used, for picking between frames. */
	const pickCamY = useRef(0);

	// Hit-tests each record's *resting* place on the wall — its full grid cell,
	// on the curve, before any hover lift or tilt — rather than its animated
	// mesh. A hovered record lifts and turns toward the cursor, which moved its
	// edge out from under the cursor, un-hovered it, dropped it back, and
	// hovered it again: a flicker loop. Cells also tile the wall with no gaps,
	// so crossing between two records doesn't drop the hover for a frame.
	const pick = useCallback(
		(ndc: THREE.Vector2): number | null => {
			raycaster.setFromCamera(ndc, camera);
			const { origin: o, direction: d } = raycaster.ray;
			const half = viewHeight / 2;
			const recs = recordsRef.current;
			const lay = layoutRef.current;
			for (const i of pickable.current) {
				const pos = lay[i];
				if (!pos) continue;
				const rec = recs[i];
				const anim = (rec && anims.current.get(rec.id)) || pos;
				const dy = (anim.y - pickCamY.current) / half;
				const z = pos.z - CURVE_DEPTH * dy * dy;
				const t = (z - o.z) / d.z;
				const x = o.x + d.x * t;
				const y = o.y + d.y * t;
				const reach = (pos.span * PITCH) / 2;
				if (Math.abs(x - anim.x) <= reach && Math.abs(y - anim.y) <= reach) {
					return i;
				}
			}
			return null;
		},
		[raycaster, camera, viewHeight],
	);

	// Pointer, from `window` (the page covers the canvas; with a record open,
	// the panel's transparent overlay does). A press that doesn't move is a
	// click: on a record, open it; on the empty wall with a record open,
	// close it. Zoomed in on a record, a press that moves drags the camera
	// around, and letting go selects the record nearest the middle.
	useEffect(() => {
		if (isTouch) return;
		const toNdc = (e: MouseEvent) =>
			pointer.current.ndc.set(
				(e.clientX / window.innerWidth) * 2 - 1,
				-(e.clientY / window.innerHeight) * 2 + 1,
			);
		const onWall = (target: EventTarget | null) =>
			target === slot ||
			(target instanceof Element &&
				target.closest('[data-slot="sheet-overlay"]') != null);
		// Moves the zoomed-in view by a screen-pixel distance, kept over the wall.
		const panBy = (dxPx: number, dyPx: number) => {
			// One screen pixel's worth of wall, at the current zoom.
			const k = unitsPerPx * (1 - zoom.current);
			const lay = layoutRef.current;
			const p = pan.current;
			const c = cam.current;
			p.x += dxPx * k;
			p.y -= dyPx * k;
			const minY = Math.min(0, ...lay.map((l) => l.y));
			p.x = THREE.MathUtils.clamp(
				p.x,
				-viewWidth / 2 - c.x,
				viewWidth / 2 - c.x,
			);
			p.y = THREE.MathUtils.clamp(p.y, minY - c.y, -c.y);
		};
		// After a drag or a wheel pan: fold it into the camera, then frame the
		// record nearest the middle of the view from there.
		const settle = () => {
			const c = cam.current;
			const p = pan.current;
			c.x += p.x;
			c.y += p.y;
			p.x = 0;
			p.y = 0;
			const cx = c.x + frameOffset.current;
			let nearest = -1;
			let best = Number.POSITIVE_INFINITY;
			layoutRef.current.forEach((l, i) => {
				const d = Math.hypot(l.x - cx, l.y - c.y);
				if (d < best) {
					best = d;
					nearest = i;
				}
			});
			if (nearest < 0) return;
			camTween.current.key = -2; // restart the move, even to the same record
			pendingFocus.current = nearest;
			if (nearest !== focusedRef.current) {
				onOpen(recordsRef.current[nearest]);
			}
		};
		let press: { x: number; y: number; moved: boolean } | null = null;
		const onDown = (e: PointerEvent) => {
			if (e.button !== 0 || !onWall(e.target)) return;
			press = { x: e.clientX, y: e.clientY, moved: false };
		};
		const onMove = (e: PointerEvent) => {
			toNdc(e);
			pointer.current.overSlot = e.target === slot;
			if (!press || focusedRef.current < 0) return;
			if (
				!press.moved &&
				Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_PX
			) {
				return;
			}
			press.moved = true;
			document.documentElement.dataset.wallDragging = "";
			// Grab the wall: it follows the pointer, so the view goes the other way.
			panBy(-e.movementX, -e.movementY);
		};
		const onUp = (e: PointerEvent) => {
			if (!press) return;
			const { moved } = press;
			press = null;
			delete document.documentElement.dataset.wallDragging;
			if (moved) {
				settle();
				return;
			}
			if (!onWall(e.target)) return;
			const index = pick(toNdc(e));
			if (index != null) onOpen(recordsRef.current[index]);
			else if (focusedRef.current >= 0) onClose();
		};
		// With a record open, scrolling beside the panel moves around the
		// zoomed-in wall instead of the page underneath it, then settles on
		// the nearest record. (The panel's own content still scrolls itself.)
		let wheelSettle = 0;
		const onWheel = (e: WheelEvent) => {
			if (focusedRef.current < 0) return;
			if (
				e.target instanceof Element &&
				e.target.closest('[data-slot="sheet-content"]')
			) {
				return;
			}
			e.preventDefault();
			const line = e.deltaMode === 1 ? 16 : 1;
			panBy(e.deltaX * line, e.deltaY * line);
			window.clearTimeout(wheelSettle);
			wheelSettle = window.setTimeout(settle, 250);
		};
		window.addEventListener("pointerdown", onDown);
		window.addEventListener("pointermove", onMove, { passive: true });
		window.addEventListener("pointerup", onUp);
		window.addEventListener("wheel", onWheel, { passive: false });
		return () => {
			window.clearTimeout(wheelSettle);
			window.removeEventListener("wheel", onWheel);
			window.removeEventListener("pointerdown", onDown);
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			delete document.documentElement.dataset.wallDragging;
			document.body.style.cursor = "";
		};
	}, [isTouch, slot, pick, onOpen, onClose, unitsPerPx, viewWidth]);

	const getTarget = useCallback((i: number) => handles.current[i], []);
	const textures = useTextureStream(records, getTarget, {
		// The sizes the photo route keeps ready-made copies of (500, 800);
		// any other width is resized on the fly, and was most of a slow
		// first load. A 2×2 gets the larger one, except on phones.
		coverPx: (i) => (layoutRef.current[i]?.span > 1 && !isTouch ? 800 : 500),
		window: cols * 5,
		discWindow: cols,
		cacheMax: cols * 14,
		lowPx: isTouch ? 64 : 128,
	});

	// A re-filter changes what's at the centre — force a texture pass.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above
	useEffect(() => {
		lastCenter.current = -1;
		hovered.current = null;
	}, [records]);

	// Theme: sleeve edges and not-yet-loaded covers follow light/dark.
	useEffect(() => {
		shared.edge.color.set(theme.dark ? "#2e2b28" : "#e4dfd6");
		for (const h of handles.current) {
			if (!h) continue;
			setCoverTheme(h.cover, theme.placeholder);
		}
	}, [theme, shared]);

	useEffect(() => {
		if (spot.current) {
			spot.current.shadow.mapSize.set(1024, 1024);
			spot.current.shadow.bias = -0.0004;
		}
	}, []);
	// The daylight's shadow camera covers the view (plus margin for the
	// curve and the panel pan), re-fitted when the view size changes.
	useEffect(() => {
		const d = sun.current;
		if (!d) return;
		const cam = d.shadow.camera;
		cam.left = -viewWidth * 0.75;
		cam.right = viewWidth * 0.75;
		cam.top = viewHeight * 0.75;
		cam.bottom = -viewHeight * 0.75;
		cam.near = 1;
		cam.far = 30;
		cam.updateProjectionMatrix();
		d.shadow.mapSize.set(2048, 2048);
		d.shadow.bias = -0.0006;
		d.shadow.radius = 4;
	}, [viewWidth, viewHeight]);

	useFrame((state, delta) => {
		// How dim the room is (1 = normal): set by the lights-down step below,
		// read by the covers' self-light.
		let roomDim = 1;
		const dt = Math.min(delta, 0.05);
		const t = state.clock.elapsedTime;
		const ndc = pointer.current.ndc;

		// Where the slot's top edge is on screen → where row 0 sits in the
		// view. Row 0's top edge (y = TILE / 2) lines up with the slot's top.
		const slotTop = slot.getBoundingClientRect().top;
		const scrollY =
			TILE / 2 + TOP_PAD - (size.height / 2 - slotTop) * unitsPerPx;
		if (pendingFocus.current === focusedRef.current) {
			pendingFocus.current = null;
		}
		const focused = pendingFocus.current ?? focusedRef.current;
		travel.current = -scrollY;

		// Where the camera is headed. Following the scroll; or, with a record
		// selected, framing it: closer (as far as it still fits on screen with
		// room to spare), centred on it vertically, and across into the middle
		// of what the record panel leaves uncovered (desktop; on phones the
		// panel covers everything anyway).
		let camGoalX = 0;
		let camGoalY = scrollY;
		let camGoalZoom = 0;
		if (focused >= 0 && layout[focused]) {
			const pos = layout[focused];
			// A lifted record also looks bigger (it's closer to the camera).
			const extent = pos.spanScale * TILE * 1.15;
			camGoalZoom = Math.min(
				FOCUS_ZOOM,
				Math.max(0, 1 - extent / (viewHeight * 0.62)),
			);
			// Halfway between the screen's left edge (-1) and the panel's —
			// from the panel's settled width, not its rect, which slides in.
			const panelLeft = size.width - Math.min(PANEL_PX, size.width);
			const centreNdc =
				!isTouch && panelLeft > size.width * 0.3
					? panelLeft / size.width - 1
					: 0;
			frameOffset.current = centreNdc * (viewWidth / 2) * (1 - camGoalZoom);
			camGoalX = pos.x - frameOffset.current;
			camGoalY = pos.y;
		}
		const c = cam.current;
		if (Number.isNaN(c.y)) c.y = scrollY;
		const tw = camTween.current;
		if (focused !== tw.key) {
			// Set off from wherever the camera is now, mid-move or not.
			tw.x = c.x;
			tw.y = c.y;
			tw.zoom = c.zoom;
			tw.t = 0;
			tw.key = focused;
			if (spot.current) {
				tw.lightX = spot.current.position.x;
				tw.lightY = spot.current.position.y - 0.6;
			}
			tw.down = lightsDown.current;
		}
		tw.t = reducedMotion ? 1 : Math.min(1, tw.t + dt / CAMERA_MOVE_S);
		const camEase = easeInOutCubic(tw.t);
		c.x = tw.x + (camGoalX - tw.x) * camEase;
		c.y = tw.y + (camGoalY - tw.y) * camEase;
		c.zoom = tw.zoom + (camGoalZoom - tw.zoom) * camEase;
		if (focused < 0) {
			pan.current.x = 0;
			pan.current.y = 0;
		}
		panelShift.current = c.x + pan.current.x;
		zoom.current = c.zoom;
		// Everything below works from where the camera is looking, so the
		// wall's curve follows the camera to the selected record.
		const camY = c.y + pan.current.y;
		pickCamY.current = camY;

		// Parallax: the camera drifts toward the pointer (a slow idle sway on
		// touch, where there's no pointer to follow).
		// While a record is selected the pointer is on the panel, not the wall:
		// it no longer drifts the camera or tilts the record.
		const pointerGain = focused >= 0 ? 0 : 1;
		const goalX = isTouch
			? Math.sin(t * 0.3) * 0.12
			: ndc.x * 0.18 * pointerGain;
		const goalY = isTouch
			? Math.cos(t * 0.23) * 0.08
			: ndc.y * 0.14 * pointerGain;
		const p = parallax.current;
		p.x = THREE.MathUtils.damp(p.x, goalX, 3, dt);
		p.y = THREE.MathUtils.damp(p.y, goalY, 3, dt);
		camera.position.set(
			p.x + panelShift.current,
			camY + p.y,
			distance * (1 - zoom.current),
		);
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
				? recordAt(centerRow, Math.floor(cols / 2))
				: null;
		}
		if (hovered.current !== active.current) {
			active.current = hovered.current;
			onActiveChange(active.current);
		}

		const centerIndex = recordAt(centerRow, Math.floor(cols / 2));
		if (centerIndex !== lastCenter.current) {
			lastCenter.current = centerIndex;
			textures.update(centerIndex);
		}
		textures.flush(isTouch ? 1 : 2);

		// The spotlight tracks the pointer across the wall (on touch, it rests
		// on the centred record; with the panel open, on the selected one).
		let lightX = isTouch ? 0 : (ndc.x * viewWidth) / 2 + panelShift.current;
		let lightY = isTouch ? camY : camY + (ndc.y * viewHeight) / 2;
		if (focused >= 0 && layout[focused]) {
			// On the selected record — moved along with any drag or wheel pan,
			// so it stays on the middle of the view.
			lightX = layout[focused].x + pan.current.x;
			lightY = layout[focused].y + pan.current.y;
		}
		// While the camera is moving to (or away from) a record, the light
		// moves with it on the same ease, rather than chasing on its own
		// spring and arriving out of step.
		const withCamera = focused >= 0 || tw.t < 1;
		if (withCamera) {
			lightX = tw.lightX + (lightX - tw.lightX) * camEase;
			lightY = tw.lightY + (lightY - tw.lightY) * camEase;
		}
		// Keep the torch on the wall: never above the first row's centre or
		// below the last's, so it doesn't light up empty wall behind the
		// header or footer. Off the wall entirely it also dims.
		lightY = Math.min(0, Math.max(-(rows - 1) * PITCH, lightY));
		const onWall =
			isTouch || focused >= 0 || pointer.current.overSlot ? 1 : 0.35;
		// On the camera's own ease: the room dims (and the spotlight
		// brightens) exactly as the camera moves in, finishing as it arrives,
		// rather than snapping bright ahead of it.
		lightsDown.current = tw.down + ((focused >= 0 ? 1 : 0) - tw.down) * camEase;
		const down = lightsDown.current;
		// Lights down: the room dims (less so in light mode, where a near-black
		// wall would read as broken), and the spotlight tightens to the
		// selected record's size and brightens.
		const dim = 1 - down * (theme.dark ? 0.55 : 0.4);
		roomDim = dim;
		if (ambient.current) ambient.current.intensity = ambientBase * dim;
		if (hemi.current) hemi.current.intensity = hemiBase * dim;
		const focusSpan = focused >= 0 ? layout[focused].spanScale : 1;
		const focusAngle = Math.atan((0.85 * focusSpan) / 3.4);
		if (spot.current) {
			const s = spot.current;
			// Springs, not plain exponential easing: they ease *in* as well as
			// out, so the light glides between records instead of lurching
			// off toward each new one.
			if (withCamera) {
				s.position.x = lightX;
				s.position.y = lightY + 0.6;
				springs.current.lightX = 0;
				springs.current.lightY = 0;
			} else {
				s.position.x = smoothDamp(
					s.position.x,
					lightX,
					springs.current,
					"lightX",
					0.28,
					dt,
				);
				s.position.y = smoothDamp(
					s.position.y,
					lightY + 0.6,
					springs.current,
					"lightY",
					0.28,
					dt,
				);
			}
			s.position.z = 3.4;
			s.target.position.set(s.position.x, s.position.y - 0.6, 0);
			s.target.updateMatrixWorld();
			s.intensity = smoothDamp(
				s.intensity,
				// A modest lift on the selected record — a big one read as it
				// flaring up the moment it was clicked.
				(theme.dark ? SPOT_DARK : SPOT_LIGHT) * onWall * (1 + 0.15 * down),
				springs.current,
				"intensity",
				0.15,
				dt,
			);
			// Sprung, so moving between a 1×1 and a 2×2 widens the beam smoothly
			// instead of snapping it to the new size.
			s.angle = smoothDamp(
				s.angle,
				THREE.MathUtils.lerp(
					isTouch ? SPOT_ANGLE_TOUCH : SPOT_ANGLE,
					focusAngle,
					down,
				),
				springs.current,
				"angle",
				0.35,
				dt,
			);
		}
		if (wall.current) wall.current.position.y = camY;
		if (sun.current && !theme.dark) {
			const d = sun.current;
			d.position.set(panelShift.current - 2.5, camY + 4, 9);
			d.target.position.set(panelShift.current, camY, 0);
			d.target.updateMatrixWorld();
			d.intensity = DAYLIGHT * (1 - down * 0.45);
		}

		// Only rows near the viewport are animated (and drawn, and pickable).
		const halfRows = Math.ceil(viewHeight / 2 / PITCH) + 2;
		const half = viewHeight / 2;
		const inView = (row: number, span: number) =>
			row <= centerRow + halfRows && row + span - 1 >= centerRow - halfRows;

		const tilt = focused >= 0 ? ZERO2 : ndc;
		// Places one record: the curve (rows recede and tip back the further
		// they are from the middle of the screen, which the depth of field then
		// blurs), the hover lift, and presence (0 = sunk into the wall).
		const place = (
			h: TileHandle,
			anim: TileAnim,
			z: number,
			l: number,
			presence: number,
		) => {
			const dy = (anim.y - camY) / half;
			const grow = presence * presence * (3 - 2 * presence);
			// A record emerges flat against the wall — its shadow hidden right
			// beneath it — and only lifts off to its resting depth once the
			// image is whole, so the shadow grows out from under it rather than
			// competing with the reveal.
			const revealed = h.cover.map ? (h.cover.userData.shown ?? 1) : 1;
			const settled = THREE.MathUtils.smoothstep(revealed, 0.7, 1);
			const rotY = -anim.x * 0.035 + l * tilt.x * 0.25;
			const tipX = l * -tilt.y * 0.18;
			// Turned, a record's edges swing back toward the wall; keep them
			// clear of it, or the wall shows through a half-revealed cover.
			const halfW = (TILE / 2) * h.scale * anim.spanScale;
			const gap = 0.03 + (Math.abs(rotY) + Math.abs(tipX)) * halfW;
			const flush = Math.max(0, (1 - settled) * (z - WALL_Z - gap));
			h.group.position.set(
				anim.x,
				anim.y,
				z - CURVE_DEPTH * dy * dy + l * LIFT_Z - (1 - grow) * 0.5 - flush,
			);
			h.group.rotation.x = -Math.atan((2 * CURVE_DEPTH * dy) / half) + tipX;
			h.group.rotation.y = rotY;
			h.group.scale.setScalar(
				Math.max(0.001, h.scale * anim.spanScale * (1 + l * 0.05) * grow),
			);
			// While the cover emerges (or fades up) the sleeve has no thickness
			// (so its edges don't outline the square before the image gets
			// there), and casts no shadow until the image is whole (a shadow is
			// the full square).
			const poured = h.cover.map
				? Math.min(revealed, h.cover.userData.fade ?? 1)
				: 1;
			h.group.scale.z *= Math.max(
				0.001,
				THREE.MathUtils.smoothstep(poured, 0.55, 1),
			);
			h.sleeve.castShadow = poured > 0.75;
			// The slip sits inside the sleeve: shown before the sleeve has its
			// depth back, it shared the flattened cover's plane and z-fought
			// (flickering as scrolling moved the camera).
			if (h.slip) h.slip.visible = poured > 0.9;
			// The vinyl waits for the cover: it only slides out once the record
			// has fully emerged (it isn't part of the reveal, so it would
			// otherwise sit whole behind a half-drawn cover).
			const discOut = l * THREE.MathUtils.smoothstep(poured, 0.85, 1);
			h.disc.visible = discOut > 0.01;
			// A hidden vinyl is parked fully home and casts no shadow, so a
			// half-revealed (see-through) cover never shows a stray disc.
			h.disc.castShadow = h.disc.visible && poured > 0.9;
			h.disc.position.x = (discOut * DISC_SLIDE) / h.scale;
			if (h.disc.visible) h.disc.rotation.z -= dt * 1.2 * l;
			if (h.slip) {
				// Roughly the same size on a 2×2 as on a 1×1 — it's a note, not
				// part of the sleeve, so it shouldn't scale up with it.
				const k = 1 / Math.sqrt(anim.spanScale);
				h.slip.scale.setScalar(k);
				// It slides up out of the sleeve as the reveal finishes.
				const tuck = THREE.MathUtils.smoothstep(poured, 0.9, 1);
				h.slip.position.y =
					TILE / 2 + ((SLIP_PEEK + l * SLIP_PULL) * tuck - SLIP_H / 2) * k;
			}
		};

		pickable.current.length = 0;
		const ease = reducedMotion ? 1 : 1 - Math.exp(-6 * dt);
		for (let i = 0; i < records.length; i++) {
			const h = handles.current[i];
			if (!h) continue;
			const pos = layout[i];
			const id = records[i].id;
			let anim = anims.current.get(id);
			if (!anim) {
				anim = {
					x: pos.x,
					y: pos.y,
					spanScale: pos.spanScale,
					presence: animateIn.current && !reducedMotion ? 0 : 1,
				};
				anims.current.set(id, anim);
			}
			anim.x += (pos.x - anim.x) * ease;
			anim.y += (pos.y - anim.y) * ease;
			anim.spanScale += (pos.spanScale - anim.spanScale) * ease;
			anim.presence += (1 - anim.presence) * ease;

			// Drawn while its slot — or where it's still gliding from — is near
			// the view.
			const travelRow = Math.round(-anim.y / PITCH);
			// A record stays off the wall until its cover image is ready, then
			// pours on (see cover-reveal.ts). Records with no photo at all show
			// their plain sleeve straight away.
			const ready = !!h.cover.map || !!h.cover.userData.noCover;
			const visible =
				ready && (inView(pos.row, pos.span) || inView(travelRow, pos.span));
			h.group.visible = visible;
			if (!visible) {
				lift.current[i] = 0;
				continue;
			}
			pickable.current.push(i);
			const cover = h.cover;
			// Self-light keeps covers true to their photos; while a record is
			// selected, the others dim with the room and it keeps its own.
			// Eased per record: moving the selection from one record to the
			// next switched them instantly, so one flashed bright as the other
			// dropped dark — now they cross-fade over the camera's move.
			const glowGoal = focused === i ? 1 : roomDim;
			const glow = smoothDamp(
				cover.userData.glow ?? glowGoal,
				glowGoal,
				springs.current,
				`glow${i}`,
				0.3,
				dt,
			);
			cover.userData.glow = glow;
			setCoverSelfLight(
				cover,
				(theme.dark ? SELF_LIGHT_DARK : SELF_LIGHT_LIGHT) * glow,
			);
			setCoverStyle(cover, reveal.style);
			setCoverSpan(cover, anim.spanScale);
			// Where the record sits on screen: -1 at the bottom edge, 1 at the
			// top; `reach` is its half-height on the same scale.
			const dyView = (anim.y - camY) / (viewHeight / 2);
			const reach = (pos.spanScale * TILE) / viewHeight;
			// A cover fades up quickly as its image arrives — no transition.
			const fade = cover.map
				? Math.min(1, (cover.userData.fade ?? 0) + dt / FADE_S)
				: 0;
			if (fade !== cover.userData.fade) {
				cover.userData.fade = fade;
				setCoverFade(cover, reducedMotion && cover.map ? 1 : fade);
			}
			// Scroll is the timeline. Records on screen when the page loads
			// just appear; once a record has been off screen, it reveals as
			// scrolling brings it in — from the bottom edge as the page scrolls
			// down, the top as it scrolls up — and un-reveals as it leaves,
			// reversibly.
			if (dyView + reach < -1 || dyView - reach > 1) {
				cover.userData.scrollDriven = true;
			}
			let shown = 1;
			if (cover.userData.scrollDriven && !reducedMotion) {
				shown =
					THREE.MathUtils.smoothstep(dyView, -1 - reach, -0.55) *
					(1 - THREE.MathUtils.smoothstep(dyView, 0.55, 1 + reach));
				// From below it reveals top edge first; from above, bottom edge
				// first. (Mid-screen it's fully shown, so the switch is never
				// seen.)
				setCoverDirection(cover, dyView < 0 ? 1 : -1);
			}
			// The selected record is always fully shown — eased the rest of
			// the way if it was mid-reveal, not snapped there.
			if (focused === i && cover.map) {
				cover.userData.focusShow = smoothDamp(
					cover.userData.focusShow ?? shown,
					1,
					springs.current,
					`show${i}`,
					0.3,
					dt,
				);
				shown = Math.max(shown, cover.userData.focusShow);
			} else {
				cover.userData.focusShow = undefined;
				springs.current[`show${i}`] = 0;
			}
			if (shown !== cover.userData.shown) {
				cover.userData.shown = shown;
				setCoverReveal(cover, shown);
			}
			const goal = hovered.current === i ? 1 : 0;
			// A hover answers quickly; the selected record (and the one being
			// let go of) eases forward and back with the camera's move rather
			// than jumping at the viewer ahead of it.
			if (focused === i) cover.userData.liftEasing = true;
			const easing = cover.userData.liftEasing === true;
			const l = easing
				? smoothDamp(
						lift.current[i],
						goal,
						springs.current,
						`lift${i}`,
						0.32,
						dt,
					)
				: THREE.MathUtils.damp(lift.current[i], goal, 9, dt);
			if (easing && focused !== i && Math.abs(l - goal) < 0.001) {
				cover.userData.liftEasing = false;
				springs.current[`lift${i}`] = 0;
			}
			lift.current[i] = l;
			place(h, anim, pos.z, l, anim.presence);
		}

		// Filtered-out records sink back into the wall, then unmount.
		let stillLeaving = false;
		for (const e of exiting) {
			e.anim.presence += (0 - e.anim.presence) * ease;
			const h = exitHandles.current.get(e.record.id);
			if (!h) continue;
			if (e.anim.presence > 0.01) stillLeaving = true;
			h.group.visible =
				e.anim.presence > 0.01 && inView(Math.round(-e.anim.y / PITCH), e.span);
			if (h.group.visible) place(h, e.anim, e.z, 0, e.anim.presence);
		}
		if (exiting.length > 0 && !stillLeaving) setExiting([]);
	});

	const liveIds = useMemo(() => new Set(records.map((r) => r.id)), [records]);
	const register = useCallback(
		(i: number, _id: number, h: TileHandle | null) => {
			handles.current[i] = h;
		},
		[],
	);
	const registerExit = useCallback(
		(_i: number, id: number, h: TileHandle | null) => {
			if (h) exitHandles.current.set(id, h);
			else exitHandles.current.delete(id);
		},
		[],
	);

	return (
		<>
			{/* Daylight (light mode only): from the upper left, so records cast
			    soft shadows down and to the right onto the wall. It follows the
			    camera; see the frame loop. */}
			<directionalLight
				ref={sun}
				color="#fffdf9"
				intensity={theme.dark ? 0 : DAYLIGHT}
				castShadow={!theme.dark && !isTouch}
			/>
			{/* Touch gets more fill light: its spotlight can't follow a pointer, so it
			    can't sweep light over the rows above and below the middle. */}
			<ambientLight ref={ambient} intensity={ambientBase} />
			<hemisphereLight
				ref={hemi}
				args={
					theme.dark
						? ["#f4f3f1", "#141414", hemiBase]
						: ["#fbfaf7", "#d9d5cd", hemiBase]
				}
			/>
			<spotLight
				ref={spot}
				// Nearly neutral: a warmer beam tinted every cover amber.
				color={theme.dark ? "#fff7ee" : "#ffffff"}
				intensity={theme.dark ? SPOT_DARK : SPOT_LIGHT}
				angle={isTouch ? SPOT_ANGLE_TOUCH : SPOT_ANGLE}
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
				{/* Shadows only, over the plain background: lit as a surface, the
				    wall came out grey (light) or lifted (dark) instead of the
				    page's pure white / black. */}
				<shadowMaterial opacity={theme.dark ? 0.6 : 0.16} />
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
				opacity={theme.dark ? 0.35 : 0.5}
				// On a pale wall, pale dust vanishes: light mode gets darker
				// specks instead, like dust caught in daylight against paper.
				color={theme.dark ? "#fff1d0" : "#5c4a2a"}
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
				opacity={theme.dark ? 0.3 : 0.35}
				color={theme.dark ? "#fff1d0" : "#5c4a2a"}
				getScroll={getTravel}
			/>
			{/* One keyed list for live and leaving records, so a record that gets
			    filtered out keeps its component (and loaded cover) as it sinks
			    away, rather than remounting blank. */}
			{[
				...records.map((record, i) => (
					<Tile
						key={record.id}
						index={i}
						record={record}
						shared={shared}
						placeholder={theme.placeholder}
						register={register}
					/>
				)),
				...exiting
					.filter((e) => !liveIds.has(e.record.id))
					.map((e) => (
						<Tile
							key={e.record.id}
							index={-1}
							record={e.record}
							shared={shared}
							placeholder={theme.placeholder}
							register={registerExit}
						/>
					)),
			]}
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
	register: (index: number, id: number, handle: TileHandle | null) => void;
}) {
	const group = useRef<THREE.Group>(null);
	const sleeve = useRef<THREE.Mesh>(null);
	const disc = useRef<THREE.Mesh>(null);
	const slip = useRef<THREE.Mesh>(null);
	const withNotes = hasNotes(record);
	// Each note slip carries its own handwriting: plain paper until the hand
	// font arrives, then the opening words of the record's notes.
	const slipMaterial = useMemo(
		() => (withNotes ? shared.slip.clone() : null),
		[withNotes, shared],
	);
	useEffect(() => {
		if (!slipMaterial || !record.notes) return;
		let texture: THREE.Texture | null = null;
		let cancelled = false;
		loadNoteFont().then(() => {
			if (cancelled || !record.notes) return;
			texture = makeNoteTexture(
				noteExcerpt(record.notes, 30),
				record.id,
				(SLIP_PEEK + SLIP_PULL) / SLIP_H,
			);
			slipMaterial.map = texture;
			slipMaterial.color.set("#ffffff");
			slipMaterial.needsUpdate = true;
		});
		return () => {
			cancelled = true;
			texture?.dispose();
			slipMaterial.dispose();
		};
	}, [slipMaterial, record.notes, record.id]);
	const scale = SIZE_SCALE[record.size ?? ""] ?? 1;
	// Each slip is tucked in somewhere of its own along the sleeve's top
	// edge, at a slight lean of its own — seeded by the record, so it's the
	// same every visit — rather than every note in the same spot.
	const [slipX, slipTilt] = useMemo(() => {
		const a = Math.sin(record.id * 12.9898) * 43758.5453;
		const b = Math.sin(record.id * 78.233) * 12345.678;
		const u = a - Math.floor(a);
		const v = b - Math.floor(b);
		return [(u - 0.5) * 0.52, (v - 0.5) * 0.16];
	}, [record.id]);
	// Created once per record; theme changes are applied by `Wall`.
	// biome-ignore lint/correctness/useExhaustiveDependencies: placeholder is read once at creation
	const cover = useMemo(() => {
		const m = makeCoverMaterial(placeholder, record.id);
		m.userData.noCover = !displayCoverKey(record);
		return m;
	}, [record]);
	const discMaterial = useMemo(() => {
		// The painted vinyl face (grooves, sheen, label) until — and unless —
		// a photo of the record's coloured vinyl arrives; with a little glow of
		// its own so it reads in a dim room, not as a black hole.
		const m = new THREE.MeshStandardMaterial({
			map: shared.vinyl,
			roughness: 0.35,
			metalness: 0.2,
			bumpMap: shared.grooves,
			bumpScale: 0.6,
			roughnessMap: shared.grooves,
			emissive: "#ffffff",
			emissiveMap: shared.vinyl,
			emissiveIntensity: 0.8,
			transparent: !!record.colorTranslucent,
			opacity: record.colorTranslucent ? 0.72 : 1,
		});
		m.userData.placeholder = "#181818";
		m.userData.lowMap = shared.vinyl;
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

	// A layout effect, so handles match the new indices before the next frame
	// draws (a passive effect can land a frame late after a re-filter).
	useLayoutEffect(() => {
		if (!group.current || !sleeve.current || !disc.current) return;
		// The picker reads the index straight off the hit mesh.
		sleeve.current.userData.index = index;
		register(index, record.id, {
			id: record.id,
			group: group.current,
			sleeve: sleeve.current,
			disc: disc.current,
			slip: slip.current,
			cover,
			discMaterial,
			scale,
		});
		return () => register(index, record.id, null);
	}, [index, record.id, register, cover, discMaterial, scale]);

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
			{withNotes && (
				// Tucked into the sleeve's open top (centred in its thickness, so
				// the front and back hide what's inside) and a little askew.
				<mesh
					ref={slip}
					geometry={shared.slipGeometry}
					material={slipMaterial ?? shared.slip}
					position={[slipX, TILE / 2 + SLIP_PEEK - SLIP_H / 2, 0]}
					rotation={[0, 0, slipTilt]}
					castShadow
				/>
			)}
		</group>
	);
});
