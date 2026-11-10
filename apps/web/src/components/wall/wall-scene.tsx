import { Html, Stats } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { EffectComposer, ToneMapping } from "@react-three/postprocessing";
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
	hasNotes,
	TILE_MIN_PX,
} from "#/components/collection-grid";
import { CollectionHero, heroDurationMs } from "#/components/collection-hero";
import { CollectionStatsSentence } from "#/components/collection-stats-sentence";
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
	setCoverDesaturate,
	setCoverFade,
	setCoverSelfLight,
	setCoverTheme,
} from "./cover-material";
import { Dust } from "./dust";
import type { Featured, HeroMode } from "./hero-modes";
import {
	loadNoteFont,
	makeNoteTexture,
	noteExcerpt,
	sharpenNoteMaps,
} from "./note-texture";
import { packDense } from "./pack";
import { cursorTarget } from "./wall-cursor";
import { WhitePointEffect } from "./white-point";

/**
 * The collection as records hung on an endless wall: the collection tiles
 * in every direction (see `buildTile`), and you move around it by dragging
 * (with momentum), with the wheel or trackpad, or by touch — the page itself
 * doesn't scroll. The canvas sits fixed over the page's own content (see
 * `WallGrid`) and never takes a pointer event; the scene listens on
 * `window` and treats anywhere that isn't a control as wall.
 *
 * - The wall curves away above and below the middle of the screen.
 * - The camera drifts with the pointer (parallax against wall and dust), and a
 *   spotlight follows the cursor, throwing each cover's shadow on the wall.
 * - The hovered record lifts off the wall and its vinyl slides out. On touch,
 *   the record nearest the middle of the screen is the "hovered" one.
 * - Clicking a record moves the camera in on it beside the record panel;
 *   dragging, scrolling or clicking it again zooms back out.
 * - Each cover fades up as its image arrives; at load, the page opens like
 *   a page, with the wall below the hero, until it first moves.
 *
 * Hover and clicks raycast against each record's resting cell by hand (once
 * per frame, once per click) rather than through R3F's per-mesh events.
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
/**
 * Where the shadow-catching wall sits: just behind the records, so their
 * shadows fall tight against them, as if they hang flat on it. A record
 * turned toward the screen's edge can tip partly behind it — harmless, as
 * the wall draws first and writes no depth (see its mesh), so it never
 * hides anything.
 */
const WALL_Z = -0.06;
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
/** How much each note slip lights itself, per theme. */
const SLIP_SELF_LIGHT_DARK = 0.2;
const SLIP_SELF_LIGHT_LIGHT = 0.45;
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

/**
 * Dark mode's wall: a dark surface lit by the torch alone. The ambient and
 * hemisphere fill that keep the covers readable are patched out of it, so
 * away from the torch it stays the page's black, and inside its pool the
 * records' shadows show.
 */
function makeTorchWallMaterial(): THREE.MeshStandardMaterial {
	const material = new THREE.MeshStandardMaterial({
		color: "#555555",
		roughness: 1,
		depthWrite: false,
	});
	material.onBeforeCompile = (shader) => {
		shader.fragmentShader = shader.fragmentShader.replace(
			"#include <lights_fragment_begin>",
			THREE.ShaderChunk.lights_fragment_begin
				.replace(
					"getAmbientLightIrradiance( ambientLightColor )",
					"vec3( 0.0 )",
				)
				.replace(
					"irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );",
					"",
				),
		);
	};
	material.customProgramCacheKey = () => "torch-wall";
	return material;
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
/** The page's side padding (`sm:px-6`), for matching the grid's columns. */
const PAGE_PAD_PX = 24;
/**
 * A record with notes has a slip of paper tucked into its sleeve, peeking out
 * of the top — the wall's version of the DOM grid's yellow notes dot.
 */
const SLIP_W = 0.4;
const SLIP_H = 0.3;
/** How far the slip pokes above the sleeve at rest, and extra on hover. */
const SLIP_PEEK = 0.1;
const SLIP_PULL = 0.07;
/** Most the camera closes in on a selected record (a share of its distance). */
const FOCUS_ZOOM = 0.38;
/** The camera's move to (and between, and away from) a selected record. */
const CAMERA_MOVE_S = 0.9;
/** `?hero=facts`: visits are slower, and closer in less, than selecting a record. */
const FACT_MOVE_S = 1.6;
const FACT_ZOOM = 0.25;
/** The record panel's width (`sm:max-w-md`), for framing beside it. */
const PANEL_PX = 448;
/** The records' entrance: how long after the hero's written in it starts… */
const ENTRANCE_AFTER_HERO_S = 0.45;
/** …and how it ripples out from the middle (seconds per world unit, capped). */
const ENTRANCE_S_PER_UNIT = 0.06;
const ENTRANCE_SPREAD_S = 0.8;
/** Re-filtering: how long the wall takes to sink away before the entrance replays. */
const REFILTER_OUT_S = 0.4;
/** How far the floating panel sits in from the window's edge (`.record-sheet`). */
const panelInsetPx = (width: number) =>
	width >= 1024 ? 64 : width >= 640 ? 24 : 0;
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

export type WallSceneProps = {
	records: PublicRecord[];
	/**
	 * Where the hero sits on screen at load (CSS px), if it's showing: it's
	 * part of the wall — records leave it a gap, it moves as the wall does,
	 * and once it's dragged off screen it's gone for good.
	 */
	hero: { left: number; top: number; right: number; bottom: number } | null;
	/** The record under the pointer (or, on touch, at the centre), if any. */
	onActiveChange: (record: PublicRecord | null) => void;
	onOpen: (record: PublicRecord) => void;
	/** Closes the record panel (a click on the empty wall while it's open). */
	onClose: () => void;
	/**
	 * The record the panel has open, if any: the camera moves in on its
	 * nearest copy, which stays lifted and lit.
	 */
	focusedRecordId: number | null;
	theme: WallTheme;
	isTouch: boolean;
	showStats?: boolean;
	/** How the wall opens (`?hero=`, see hero-modes.ts). */
	heroMode: HeroMode;
	/** The records the stats are about (captions for `labels`, stops for `facts`). */
	featured: Featured[];
	/** `?hero=record`: the record the wall opens zoomed in on. */
	introRecordId: number | null;
	/** `?hero=facts`: the wall's been moved, so no fact is being visited. */
	onFactStep: (index: number | null) => void;
	/** `?hero=facts`: the fact being visited, stepped through by the page. */
	factStep: number | null;
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
			/>
			{props.showStats && <Stats />}
			<SceneStatsProbe />
		</Canvas>
	);
});

function Effects({ multisample }: { multisample: boolean }) {
	// Neutral (Khronos) tone mapping keeps colours faithful — the ACES default
	// greyed and desaturated covers, and turned the light theme's white wall
	// to mud — and the white point puts its whites back at true white.
	const whitePoint = useMemo(() => new WhitePointEffect(), []);
	useEffect(() => () => whitePoint.dispose(), [whitePoint]);
	const finish = (
		<>
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
type TileAnim = {
	x: number;
	y: number;
	spanScale: number;
	presence: number;
	/**
	 * Re-filtered: it sinks where it is, then moves to its new slot while
	 * it's out of sight, rather than gliding there across the wall.
	 */
	relocate?: boolean;
};

/** A record filtered out, kept around while it sinks back into the wall. */
type Exiting = {
	key: string;
	record: PublicRecord;
	anim: TileAnim;
	z: number;
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

/** One drawn record: the collection repeats to fill the tile when it's small. */
type Instance = {
	record: PublicRecord;
	/** Stable across re-filters: `<record id>:<copy>`. */
	key: string;
	span: number;
};

/**
 * The wall's tile: the records packed edge to edge (dense, like the DOM
 * grid, with notes records 2×2), repeated in every direction. It's kept
 * wider and taller than the view by a margin, so each record is drawn once,
 * at whichever copy is nearest the camera, and the hop between copies always
 * happens off screen. A small collection (a narrow filter) repeats to fill
 * that size, and the last row is topped up so the tile has no holes to
 * repeat.
 */
function buildTile(records: PublicRecord[], minCols: number, minRows: number) {
	if (records.length === 0) {
		return { instances: [] as Instance[], placements: [], cols: 1, rows: 1 };
	}
	const spanning = computeSpanningIds(records);
	const spanOf = (r: PublicRecord) => (spanning.has(r.id) ? 2 : 1);
	const cellsPerCopy = records.reduce((n, r) => n + spanOf(r) ** 2, 0);
	const cols = Math.max(minCols, Math.ceil(Math.sqrt(cellsPerCopy * 1.6)));
	const copies = Math.max(1, Math.ceil((cols * minRows) / cellsPerCopy));
	const instances: Instance[] = [];
	for (let c = 0; c < copies; c++) {
		for (const record of records) {
			instances.push({
				record,
				key: `${record.id}:${c}`,
				span: spanOf(record),
			});
		}
	}
	let packed = packDense(
		instances.map((i) => i.span),
		cols,
	);
	const used = instances.reduce((n, i) => n + i.span ** 2, 0);
	const holes = packed.rows * cols - used;
	if (holes > 0) {
		for (let k = 0; k < holes; k++) {
			const record = records[k % records.length];
			instances.push({ record, key: `${record.id}:fill${k}`, span: 1 });
		}
		packed = packDense(
			instances.map((i) => i.span),
			cols,
		);
	}
	return {
		instances,
		placements: packed.placements,
		cols,
		rows: packed.rows,
	};
}

/** `v` moved by whole tiles of length `size` to its copy nearest `centre`. */
function wrapNear(v: number, centre: number, size: number) {
	return v + size * Math.round((centre - v) / size);
}

/** A stable 0–1 hash of a string (an instance key), for per-copy jitter. */
function hash01(key: string) {
	let h = 2166136261;
	for (let i = 0; i < key.length; i++) {
		h ^= key.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0) / 4294967296;
}

/** Page elements a press on the wall must leave alone. */
const INTERACTIVE =
	'button, a, input, textarea, select, label, [role="button"], [data-slot="sheet-content"], .floating-controls, [data-wall-filters] > [data-wall-chrome], [data-wall-corner], [data-debug-overlay]';

function Wall({
	records,
	hero,
	heroMode,
	featured,
	introRecordId,
	onFactStep,
	factStep,
	onActiveChange,
	onOpen,
	onClose,
	focusedRecordId,
	theme,
	isTouch,
}: WallSceneProps) {
	const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
	const size = useThree((s) => s.size);
	// As many columns across the screen as the DOM grid shows (less the
	// page's side padding).
	const visibleCols = columnsFor(size.width - PAGE_PAD_PX * 2);
	const gridWidth = visibleCols * PITCH - GAP;
	const tanHalf = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
	const aspect = size.width / size.height;
	const viewWidthFit =
		(gridWidth * size.width) / (size.width - PAGE_PAD_PX * 2);
	const distance = viewWidthFit / 2 / (tanHalf * aspect);
	const viewHeight = 2 * distance * tanHalf;
	const viewWidth = viewHeight * aspect;
	const unitsPerPx = viewHeight / size.height;
	const visibleRows = Math.ceil(viewHeight / PITCH);

	const tile = useMemo(
		() => buildTile(records, visibleCols + 4, visibleRows + 4),
		[records, visibleCols, visibleRows],
	);
	const instances = tile.instances;
	const tileW = tile.cols * PITCH;
	const tileH = tile.rows * PITCH;
	/** Instance records, in instance order (what the texture stream loads). */
	const drawn = useMemo(() => instances.map((i) => i.record), [instances]);

	// Each instance's centre in the tile (a 2×2 sits over its four cells),
	// plus a little depth jitter, so the parallax has layers to work with.
	const layout = useMemo(
		() =>
			instances.map((inst, i) => {
				const { col, row, span } = tile.placements[i];
				return {
					x: (col + (span - 1) / 2 - (tile.cols - 1) / 2) * PITCH,
					y: -(row + (span - 1) / 2) * PITCH,
					z: (hash01(inst.key) - 0.5) * 0.06,
					span,
					/** World size relative to a 1×1 — a 2×2 also covers the gap. */
					spanScale: (span * PITCH - GAP) / TILE,
				};
			}),
		[instances, tile],
	);
	const layoutRef = useRef(layout);
	layoutRef.current = layout;
	const tileRef = useRef({ w: tileW, h: tileH });
	tileRef.current = { w: tileW, h: tileH };

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
				// Its own paper as glow (see `SLIP_SELF_LIGHT_*`); swapped for
				// the written-on texture once that's drawn.
				emissive: "#eab308",
				emissiveIntensity: 0,
				roughness: 0.85,
				side: THREE.DoubleSide,
			}),
		};
	}, []);

	const handles = useRef<(TileHandle | null)[]>([]);
	const lift = useRef(new Float32Array(0));
	if (lift.current.length !== instances.length) {
		lift.current = new Float32Array(instances.length);
	}
	const instancesRef = useRef(instances);
	instancesRef.current = instances;

	// Filtering animates like the wall's first entrance: everything sinks back
	// into the wall where it is (filtered-out records kept in `exiting` until
	// they're gone), then the new set rises out of it, rippling from the
	// middle of the screen. Records that stay move to their new slot while
	// they're sunk. Keyed by instance, since a re-filter moves every index.
	const anims = useRef(new Map<string, TileAnim>());
	/** False until the first re-filter — the initial load doesn't animate in. */
	const animateIn = useRef(false);
	/**
	 * At load, the hero and its stats write in first and the records follow
	 * (rippling out from the middle): when, on the frame clock, they start.
	 * Opening straight onto a record, there's no hero to wait for.
	 */
	const entrance = useRef<{ at: number; x: number; y: number } | null>(null);
	const entranceDelayS = useRef(
		hero && focusedRecordId == null
			? heroDurationMs(records.length) / 1000 + ENTRANCE_AFTER_HERO_S
			: 0,
	);
	/** A re-filter happened: the frame loop restarts the entrance. */
	const refilter = useRef(false);
	const [exiting, setExiting] = useState<Exiting[]>([]);
	const exitingRef = useRef(exiting);
	exitingRef.current = exiting;
	const exitHandles = useRef(new Map<string, TileHandle>());
	const prevInstances = useRef(instances);
	const prevLayout = useRef<typeof layout>(layout);
	useEffect(() => {
		const before = prevInstances.current;
		const beforeLayout = prevLayout.current;
		prevInstances.current = instances;
		prevLayout.current = layout;
		if (before === instances) return;
		animateIn.current = true;
		refilter.current = true;
		const kept = new Set(instances.map((i) => i.key));
		// A record filtered back in mid-exit picks up from where it was.
		for (const e of exitingRef.current) {
			if (kept.has(e.key)) anims.current.set(e.key, e.anim);
		}
		for (const key of kept) {
			const anim = anims.current.get(key);
			if (anim) anim.relocate = true;
		}
		const leaving: Exiting[] = [];
		before.forEach((inst, i) => {
			if (kept.has(inst.key)) return;
			const anim = anims.current.get(inst.key);
			anims.current.delete(inst.key);
			const pos = beforeLayout[i];
			if (!anim || !pos) return;
			leaving.push({
				key: inst.key,
				record: inst.record,
				anim,
				z: pos.z,
				span: pos.span,
			});
		});
		setExiting((current) => [
			...current.filter((e) => !kept.has(e.key)),
			...leaving,
		]);
	}, [instances, layout]);
	const reducedMotion = useMemo(
		() => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
		[],
	);

	const hovered = useRef<number | null>(null);
	const active = useRef<number | null>(null);
	const parallax = useRef(new THREE.Vector2());
	const spot = useRef<THREE.SpotLight>(null);
	const ambient = useRef<THREE.AmbientLight>(null);
	const hemi = useRef<THREE.HemisphereLight>(null);
	// A soft, even fill over the whole wall, so covers keep their detail
	// rather than only reading where the torch lands. Touch gets more: its
	// spotlight can't follow a pointer.
	const ambientBase = (theme.dark ? 0.6 : 1) + (isTouch ? 0.35 : 0);
	const hemiBase = theme.dark ? 0.4 : 0.45;
	const sun = useRef<THREE.DirectionalLight>(null);
	/** Velocities for the `smoothDamp` springs. */
	const springs = useRef<Record<string, number>>({});
	/** 0 → 1 as a record is selected: house lights down, spotlight on it. */
	const lightsDown = useRef(0);
	const wall = useRef<THREE.Mesh>(null);
	/** Camera travel across the wall, in world units (drives the dust). */
	const travel = useRef({ x: 0, y: 0 });
	const getTravelY = useCallback(() => travel.current.y, []);
	const getTravelX = useCallback(() => travel.current.x, []);
	/** The camera's x across the wall. */
	const panelShift = useRef(0);
	/** How far the camera has moved in on a selected record (0–1 of its distance). */
	const zoom = useRef(0);
	/**
	 * Where the camera rests when no record is selected: moved by dragging
	 * (with momentum) and by the wheel / trackpad. `vx`/`vy` carry a fling on
	 * after the pointer lets go.
	 */
	const free = useRef({ x: 0, y: Number.NaN, vx: 0, vy: 0 });
	/** Mid-drag (unzoomed), so momentum waits until the pointer lets go. */
	const dragging = useRef(false);
	/**
	 * The camera's place — x, y, zoom — and the one eased move between where
	 * it was and where it's going: resting where the wall was dragged to, or
	 * framing a selected record. One tween for all three keeps the move a
	 * straight, smooth ease.
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
	/**
	 * The hero's gap in the wall, in world units, while the hero is still
	 * around (null once it's gone); and where the camera started, which the
	 * hero's on-screen offset is measured from.
	 */
	const heroHole = useRef<{
		x0: number;
		x1: number;
		y0: number;
		y1: number;
	} | null>(null);
	const heroGone = useRef(hero == null);
	/**
	 * `?hero=record` / `facts`: the camera visiting a record — the newest
	 * (record), or the fact picked (facts) — until the first drag, scroll or
	 * click hands it over.
	 */
	const intro = useRef({
		active: heroMode === "record",
		step: 0,
		/** Clock time the intro began. */
		start: -1,
		/** The copy being visited, picked once per step. */
		index: -1,
		forStep: -2,
	});
	/** `?hero=panel`: where on the wall the hero hangs, while it's there. */
	const [panelAt, setPanelAt] = useState<{ x: number; y: number } | null>(null);
	const panel = useRef<THREE.Group>(null);
	const captionById = useMemo(
		() =>
			heroMode === "labels"
				? new Map(featured.map((f) => [f.recordId, f.caption]))
				: null,
		[heroMode, featured],
	);
	const onFactStepRef = useRef(onFactStep);
	onFactStepRef.current = onFactStep;
	const factStepRef = useRef(factStep);
	factStepRef.current = factStep;
	const featuredRef = useRef(featured);
	featuredRef.current = featured;
	const heroStart = useRef({ x: 0, y: 0 });
	/** The hero measurement `heroHole` was built from. */
	const holeFor = useRef<WallSceneProps["hero"]>(null);
	const heroEl = useRef<HTMLElement | null>(null);
	/** Where textures were last streamed around. */
	const streamedAt = useRef<{ x: number; y: number } | null>(null);

	// The selected record is one of possibly several drawn copies: the one
	// nearest the camera when it was chosen.
	const focusedRecordRef = useRef(focusedRecordId);
	focusedRecordRef.current = focusedRecordId;
	const focusSeen = useRef<number | null>(null);
	const focusIndex = useRef(-1);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new tile means new indices
	useEffect(() => {
		focusSeen.current = null;
		streamedAt.current = null;
		hovered.current = null;
	}, [instances]);

	// The scene's up: the page can show its hero and controls (until now
	// it shows only a spinner — see `[data-wall-page]`).
	useEffect(() => {
		document.documentElement.dataset.wallReady = "";
		return () => {
			delete document.documentElement.dataset.wallReady;
			delete document.documentElement.dataset.wallHeroGone;
		};
	}, []);

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
	const torchWall = useMemo(makeTorchWallMaterial, []);
	useEffect(() => () => torchWall.dispose(), [torchWall]);
	const lookAt = useMemo(() => new THREE.Vector3(), []);
	const cursorWorld = useMemo(() => new THREE.Vector3(), []);
	const raycaster = useMemo(() => new THREE.Raycaster(), []);
	/** Pointer in NDC (-1…1), and whether it's over the wall right now. */
	const pointer = useRef({ ndc: new THREE.Vector2(), overWall: false });
	/** Records drawn last frame — the only ones worth testing. */
	const pickable = useRef<number[]>([]);
	/** The camera height the last frame used, for picking between frames. */
	const pickCamY = useRef(0);
	/** Each instance's drawn (wrapped) position, from the last frame. */
	const drawnAt = useRef(new Map<string, { x: number; y: number }>());

	// Hit-tests each record's *resting* place on the wall — its full grid cell,
	// on the curve, before any hover lift or tilt — rather than its animated
	// mesh, so a hovered record turning toward the cursor can't flicker the
	// hover. Cells also tile the wall with no gaps.
	const pick = useCallback(
		(ndc: THREE.Vector2): number | null => {
			raycaster.setFromCamera(ndc, camera);
			const { origin: o, direction: d } = raycaster.ray;
			const half = viewHeight / 2;
			const insts = instancesRef.current;
			const lay = layoutRef.current;
			for (const i of pickable.current) {
				const pos = lay[i];
				const at = insts[i] && drawnAt.current.get(insts[i].key);
				if (!pos || !at) continue;
				const dy = (at.y - pickCamY.current) / half;
				const z = pos.z - CURVE_DEPTH * dy * dy;
				const t = (z - o.z) / d.z;
				const x = o.x + d.x * t;
				const y = o.y + d.y * t;
				const reach = (pos.span * PITCH) / 2;
				if (Math.abs(x - at.x) <= reach && Math.abs(y - at.y) <= reach) {
					return i;
				}
			}
			return null;
		},
		[raycaster, camera, viewHeight],
	);

	// Pointer, from `window` (the page and, with a record open, the panel's
	// transparent overlay sit over the canvas). Anywhere that isn't a control
	// is wall. A press that moves drags the wall (with momentum when let
	// go); zoomed in on a record, it also zooms back out to the wall. A press that doesn't move is a click: on a record,
	// open it; on the empty wall with a record open, close it.
	useEffect(() => {
		const toNdc = (e: MouseEvent) =>
			pointer.current.ndc.set(
				(e.clientX / window.innerWidth) * 2 - 1,
				-(e.clientY / window.innerHeight) * 2 + 1,
			);
		const onWall = (target: EventTarget | null) =>
			target instanceof Element && target.closest(INTERACTIVE) == null;
		// The first drag, scroll or click ends a record / facts visit: the
		// camera zooms back out where it is, and it's yours.
		const endIntro = () => {
			const it = intro.current;
			if (!it.active) return;
			it.active = false;
			factStepRef.current = null;
			onFactStepRef.current(null);
			if (heroMode === "record") {
				document.documentElement.dataset.wallHeroGone = "";
			}
		};
		// Moves the view by a screen-pixel distance: zoomed in, the pan
		// offset; otherwise where the camera rests.
		const panBy = (dxPx: number, dyPx: number) => {
			// One screen pixel's worth of wall, at the current zoom.
			const k = unitsPerPx * (1 - zoom.current);
			if (focusIndex.current >= 0) {
				pan.current.x += dxPx * k;
				pan.current.y -= dyPx * k;
			} else {
				free.current.x += dxPx * k;
				free.current.y -= dyPx * k;
			}
		};
		// Dragging or scrolling with a record open lets go of it: the camera
		// zooms back out to the wall as you move, and the move carries on there.
		const letGo = () => {
			if (focusIndex.current < 0 && pendingFocus.current == null) return;
			focusIndex.current = -1;
			pendingFocus.current = null;
			onClose();
		};
		let press: {
			x: number;
			y: number;
			moved: boolean;
			/** Recent moves, for the fling's speed. */
			trail: { t: number; x: number; y: number }[];
		} | null = null;
		const onDown = (e: PointerEvent) => {
			if (e.button !== 0 || !onWall(e.target)) return;
			endIntro();
			press = { x: e.clientX, y: e.clientY, moved: false, trail: [] };
			free.current.vx = 0;
			free.current.vy = 0;
			if (e.pointerType === "mouse") e.preventDefault();
		};
		const onMove = (e: PointerEvent) => {
			toNdc(e);
			pointer.current.overWall = onWall(e.target);
			if (!press) return;
			if (
				!press.moved &&
				Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_PX
			) {
				return;
			}
			if (!press.moved) {
				press.moved = true;
				letGo();
				dragging.current = true;
				document.documentElement.dataset.wallDragging = "";
			}
			// Grab the wall: it follows the pointer, so the view goes the other way.
			panBy(-e.movementX, -e.movementY);
			press.trail.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
			while (press.trail.length > 1 && e.timeStamp - press.trail[0].t > 100) {
				press.trail.shift();
			}
		};
		const onUp = (e: PointerEvent) => {
			if (!press) return;
			const { moved: wasDrag, trail } = press;
			press = null;
			dragging.current = false;
			delete document.documentElement.dataset.wallDragging;
			if (wasDrag) {
				// Fling: carry on at the speed of the last tenth of a second.
				const first = trail[0];
				const last = trail[trail.length - 1];
				const ms = last && first ? last.t - first.t : 0;
				if (ms > 8 && e.timeStamp - last.t < 80) {
					const k = unitsPerPx * (1 - zoom.current);
					free.current.vx = (-(last.x - first.x) / ms) * 1000 * k;
					free.current.vy = ((last.y - first.y) / ms) * 1000 * k;
				}
				return;
			}
			if (!onWall(e.target)) return;
			const index = pick(toNdc(e));
			const record = index != null ? instancesRef.current[index]?.record : null;
			// Clicking the record that's open zooms back out.
			if (index != null && index === focusIndex.current) {
				onClose();
				return;
			}
			if (index != null && record) {
				pendingFocus.current = index;
				focusIndex.current = index;
				onOpen(record);
			} else if (focusIndex.current >= 0) onClose();
		};
		// The wheel / trackpad moves around the wall (the page itself no
		// longer scrolls). Zoomed in, it lets go of the record, as a drag does. The panel's own content still scrolls itself.
		const onWheel = (e: WheelEvent) => {
			if (
				e.target instanceof Element &&
				e.target.closest('[data-slot="sheet-content"]')
			) {
				return;
			}
			e.preventDefault();
			endIntro();
			const line = e.deltaMode === 1 ? 16 : 1;
			free.current.vx = 0;
			free.current.vy = 0;
			letGo();
			panBy(e.deltaX * line, e.deltaY * line);
		};
		window.addEventListener("pointerdown", onDown);
		window.addEventListener("pointermove", onMove, { passive: true });
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
		window.addEventListener("wheel", onWheel, { passive: false });
		return () => {
			window.removeEventListener("wheel", onWheel);
			window.removeEventListener("pointerdown", onDown);
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			delete document.documentElement.dataset.wallDragging;
			delete document.documentElement.dataset.wallCursor;
		};
	}, [pick, onOpen, onClose, unitsPerPx, heroMode]);

	const getTarget = useCallback((i: number) => handles.current[i], []);
	const textures = useTextureStream(drawn, getTarget, {
		// The sizes the photo route keeps ready-made copies of (500, 800);
		// any other width is resized on the fly. A 2×2 gets the larger one,
		// except on phones.
		coverPx: (i) => (layoutRef.current[i]?.span > 1 && !isTouch ? 800 : 500),
		discWindow: visibleCols * 2,
		cacheMax: visibleCols * visibleRows * 3,
		lowPx: isTouch ? 64 : 128,
	});

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
		const insts = instancesRef.current;

		// The camera starts at the middle of the tile, the hero (if it's
		// showing) over a gap in the wall at the middle of the screen.
		const f = free.current;
		if (Number.isNaN(f.y)) {
			f.x = 0;
			f.y = -tileH / 2;
			// Opening on a record: start right over it, then zoom in.
			const opening = insts.findIndex((i) => i.record.id === introRecordId);
			if (opening >= 0 && layout[opening]) {
				f.x = layout[opening].x;
				f.y = layout[opening].y;
			}
			heroStart.current = { x: f.x, y: f.y };
		}
		// The hero's gap in the wall: where its text is when the wall is back
		// where it started. Rebuilt whenever the page re-measures it (the
		// window resized and the text reflowed).
		if (hero && !heroGone.current && holeFor.current !== hero) {
			holeFor.current = hero;
			const s0 = heroStart.current;
			const toX = (px: number) => s0.x + (px - size.width / 2) * unitsPerPx;
			const toY = (px: number) => s0.y - (px - size.height / 2) * unitsPerPx;
			heroHole.current = {
				x0: toX(hero.left) - GAP,
				x1: toX(hero.right) + GAP,
				y0: toY(hero.bottom) - GAP,
				y1: toY(hero.top) + GAP,
			};
			if (heroMode === "panel") {
				setPanelAt({
					x: toX((hero.left + hero.right) / 2),
					y: toY((hero.top + hero.bottom) / 2),
				});
			}
		}
		// Momentum: a fling coasts on and slows to a stop.
		if (!dragging.current && (f.vx !== 0 || f.vy !== 0)) {
			f.x += f.vx * dt;
			f.y += f.vy * dt;
			const friction = Math.exp(-4 * dt);
			f.vx *= friction;
			f.vy *= friction;
			if (Math.hypot(f.vx, f.vy) < 0.01) {
				f.vx = 0;
				f.vy = 0;
			}
		}

		// The selected record: the copy picked by a click or a drag, or — for
		// a record chosen another way (the panel's arrows, a link) — the copy
		// nearest the camera.
		if (pendingFocus.current != null) {
			const pending = insts[pendingFocus.current];
			if (pending && pending.record.id === focusedRecordRef.current) {
				focusSeen.current = focusedRecordRef.current;
				focusIndex.current = pendingFocus.current;
				pendingFocus.current = null;
			}
		}
		if (
			pendingFocus.current == null &&
			focusSeen.current !== focusedRecordRef.current
		) {
			focusSeen.current = focusedRecordRef.current;
			focusIndex.current = -1;
			const id = focusedRecordRef.current;
			if (id != null) {
				const c0 = cam.current;
				const cx = Number.isNaN(c0.y) ? f.x : c0.x;
				const cy = Number.isNaN(c0.y) ? f.y : c0.y;
				let best = Number.POSITIVE_INFINITY;
				layout.forEach((l, i) => {
					if (insts[i]?.record.id !== id) return;
					const d = Math.hypot(
						wrapNear(l.x, cx, tileW) - cx,
						wrapNear(l.y, cy, tileH) - cy,
					);
					if (d < best) {
						best = d;
						focusIndex.current = i;
					}
				});
			}
		}
		// The intro (record / facts): which record the camera's visiting now.
		const it = intro.current;
		if (heroMode === "facts") {
			const step = factStepRef.current;
			it.active = step != null;
			it.step = step ?? -1;
			// The first fact takes the camera off the hero: it's gone for good.
			if (it.active && !heroGone.current) {
				heroGone.current = true;
				heroHole.current = null;
				document.documentElement.dataset.wallHeroGone = "";
			}
		}
		let introIdx = -1;
		if (it.active && it.step >= 0) {
			const id =
				heroMode === "facts"
					? featuredRef.current[it.step]?.recordId
					: introRecordId;
			if (it.forStep !== it.step) {
				it.forStep = it.step;
				it.index = -1;
				const cx = Number.isNaN(cam.current.y) ? f.x : cam.current.x;
				const cy = Number.isNaN(cam.current.y) ? f.y : cam.current.y;
				let best = Number.POSITIVE_INFINITY;
				layout.forEach((l, i) => {
					if (insts[i]?.record.id !== id) return;
					const d = Math.hypot(
						wrapNear(l.x, cx, tileW) - cx,
						wrapNear(l.y, cy, tileH) - cy,
					);
					if (d < best) {
						best = d;
						it.index = i;
					}
				});
			}
			introIdx = it.index;
		}
		const chosen = pendingFocus.current ?? focusIndex.current;
		// Visiting a record on the intro looks just like selecting it (lifted,
		// lit, the room dimmed) — but centred, with no panel beside it.
		const visiting = chosen < 0 && introIdx >= 0;
		const focused = chosen >= 0 ? chosen : introIdx;

		// Where the camera is headed: where the wall was dragged to; or, with
		// a record selected, framing it — closer (as far as it still fits on
		// screen with room to spare), centred on it vertically, and across
		// into the middle of what the record panel leaves uncovered (desktop;
		// on phones the panel covers everything anyway).
		const c = cam.current;
		if (Number.isNaN(c.y)) {
			c.x = f.x;
			c.y = f.y;
		}
		let camGoalX = f.x;
		let camGoalY = f.y;
		let camGoalZoom = 0;
		if (focused >= 0 && layout[focused]) {
			const pos = layout[focused];
			// A lifted record also looks bigger (it's closer to the camera).
			const extent = pos.spanScale * TILE * 1.15;
			camGoalZoom = Math.min(
				visiting && heroMode !== "record" ? FACT_ZOOM : FOCUS_ZOOM,
				Math.max(0, 1 - extent / (viewHeight * 0.62)),
			);
			// Halfway between the screen's left edge (-1) and the panel's —
			// from the panel's settled width, not its rect, which slides in.
			const panelLeft =
				size.width - Math.min(PANEL_PX + panelInsetPx(size.width), size.width);
			const centreNdc =
				!visiting && !isTouch && panelLeft > size.width * 0.3
					? panelLeft / size.width - 1
					: 0;
			frameOffset.current = centreNdc * (viewWidth / 2) * (1 - camGoalZoom);
			camGoalX = wrapNear(pos.x, c.x, tileW) - frameOffset.current;
			camGoalY = wrapNear(pos.y, c.y, tileH);
		}
		const tw = camTween.current;
		if (focused !== tw.key) {
			// Letting go of a record: rest where the camera is now (only the
			// zoom eases back out), not where the wall was before it.
			if (focused < 0 && tw.key >= 0) {
				f.x = c.x + pan.current.x + frameOffset.current;
				f.y = c.y + pan.current.y;
				camGoalX = f.x;
				camGoalY = f.y;
				c.x += pan.current.x;
				c.y += pan.current.y;
				pan.current.x = 0;
				pan.current.y = 0;
			}
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
		const moveS =
			visiting && heroMode !== "record" ? FACT_MOVE_S : CAMERA_MOVE_S;
		tw.t = reducedMotion ? 1 : Math.min(1, tw.t + dt / moveS);
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
		// wall's curve follows the camera.
		const camX = panelShift.current;
		const camY = c.y + pan.current.y;
		pickCamY.current = camY;
		travel.current.x = camX;
		travel.current.y = -camY;

		// The hero moves with the wall; once it's wholly off screen it's gone
		// for good, and the records fill its gap (out of sight).
		if (!heroGone.current && hero) {
			heroEl.current ??=
				document.querySelector<HTMLElement>("[data-wall-hero]");
			const el = heroEl.current;
			const scale = unitsPerPx * (1 - c.zoom);
			const dx = -(camX - heroStart.current.x) / scale;
			const dy = (camY - heroStart.current.y) / scale;
			// Gone once it's off screen — or once a record's opened: the wall's
			// yours from then, and records fill the space it held.
			const off =
				focusIndex.current >= 0 ||
				pendingFocus.current != null ||
				!el?.isConnected ||
				hero.right + dx < 0 ||
				hero.left + dx > size.width ||
				hero.bottom + dy < 0 ||
				hero.top + dy > size.height;
			if (off) {
				heroGone.current = true;
				heroHole.current = null;
				document.documentElement.dataset.wallHeroGone = "";
				if (heroMode === "panel") setPanelAt(null);
			} else if (el) {
				el.style.setProperty("--wall-pan-x", `${dx.toFixed(1)}px`);
				el.style.setProperty("--wall-pan-y", `${dy.toFixed(1)}px`);
			}
		}

		// Parallax: the camera drifts toward the pointer (a slow idle sway on
		// touch). While a record is selected the pointer is on the panel, not
		// the wall: it no longer drifts the camera or tilts the record.
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
		camera.position.set(p.x + camX, camY + p.y, distance * (1 - zoom.current));
		lookAt.set(camX, camY, 0);
		camera.lookAt(lookAt);
		camera.updateMatrixWorld();

		// Textures: the records nearest the view, nearest first — re-streamed
		// once the camera has moved a little way.
		const sa = streamedAt.current;
		if (!sa || Math.hypot(camX - sa.x, camY - sa.y) > PITCH * 0.6) {
			streamedAt.current = { x: camX, y: camY };
			const order = layout
				.map((l, i) => ({
					i,
					d: Math.hypot(
						wrapNear(l.x, camX, tileW) - camX,
						wrapNear(l.y, camY, tileH) - camY,
					),
				}))
				.sort((a, b) => a.d - b.d)
				.slice(0, visibleCols * visibleRows * 2)
				.map((e) => e.i);
			textures.update(order);
		}
		textures.flush(isTouch ? 1 : 2);

		// Lights. The spotlight tracks the pointer across the wall (on touch,
		// it rests on the middle; with the panel open, on the selected record).
		let lightX = isTouch ? camX : (ndc.x * viewWidth) / 2 + camX;
		let lightY = isTouch ? camY : camY + (ndc.y * viewHeight) / 2;
		if (focused >= 0 && layout[focused]) {
			// On the selected record — moved along with any drag or wheel pan,
			// so it stays on the middle of the view.
			lightX = wrapNear(layout[focused].x, c.x, tileW) + pan.current.x;
			lightY = wrapNear(layout[focused].y, c.y, tileH) + pan.current.y;
		}
		// While the camera is moving to (or away from) a record, the light
		// moves with it on the same ease.
		const withCamera = focused >= 0 || tw.t < 1;
		if (withCamera) {
			lightX = tw.lightX + (lightX - tw.lightX) * camEase;
			lightY = tw.lightY + (lightY - tw.lightY) * camEase;
		}
		const onWall =
			isTouch || focused >= 0 || pointer.current.overWall ? 1 : 0.35;
		// On the camera's own ease: the room dims (and the spotlight
		// brightens) exactly as the camera moves in.
		lightsDown.current = tw.down + ((focused >= 0 ? 1 : 0) - tw.down) * camEase;
		const down = lightsDown.current;
		const dim = 1 - down * (theme.dark ? 0.55 : 0.4);
		roomDim = dim;
		if (ambient.current) ambient.current.intensity = ambientBase * dim;
		if (hemi.current) hemi.current.intensity = hemiBase * dim;
		const focusSpan = focused >= 0 ? layout[focused].spanScale : 1;
		const focusAngle = Math.atan((0.85 * focusSpan) / 3.4);
		if (spot.current) {
			const s = spot.current;
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
				(theme.dark ? SPOT_DARK : SPOT_LIGHT) * onWall * (1 + 0.15 * down),
				springs.current,
				"intensity",
				0.15,
				dt,
			);
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
		if (wall.current) wall.current.position.set(camX, camY, WALL_Z);
		// The hung hero follows the wall's curve, like a record would.
		if (panel.current && panelAt) {
			const px = wrapNear(panelAt.x, camX, tileW);
			const py = wrapNear(panelAt.y, camY, tileH);
			const dy = (py - camY) / (viewHeight / 2);
			panel.current.position.set(px, py, 0.02 - CURVE_DEPTH * dy * dy);
			panel.current.rotation.x = -Math.atan(
				(2 * CURVE_DEPTH * dy) / (viewHeight / 2),
			);
			panel.current.rotation.y = -(px - camX) * 0.035;
			// drei's transform mode draws 40 CSS px a world unit: this makes the
			// panel the size the hero is on screen.
			panel.current.scale.setScalar(unitsPerPx * 40);
		}
		if (sun.current && !theme.dark) {
			const d = sun.current;
			d.position.set(camX - 2.5, camY + 4, 9);
			d.target.position.set(camX, camY, 0);
			d.target.updateMatrixWorld();
			d.intensity = DAYLIGHT * (1 - down * 0.45);
		}

		const half = viewHeight / 2;
		const halfW = viewWidth / 2;
		const tilt = focused >= 0 ? ZERO2 : ndc;
		// Places one record at (x, y): the curve (rows recede and tip back the
		// further they are from the middle of the screen), the hover lift, and
		// presence (0 = sunk into the wall).
		const place = (
			h: TileHandle,
			x: number,
			y: number,
			spanScale: number,
			z: number,
			l: number,
			presence: number,
		) => {
			const dy = (y - camY) / half;
			const grow = presence * presence * (3 - 2 * presence);
			const rotY = -(x - camX) * 0.035 + l * tilt.x * 0.25;
			const tipX = l * -tilt.y * 0.18;
			h.group.position.set(
				x,
				y,
				z - CURVE_DEPTH * dy * dy + l * LIFT_Z - (1 - grow) * 0.5,
			);
			h.group.rotation.x = -Math.atan((2 * CURVE_DEPTH * dy) / half) + tipX;
			h.group.rotation.y = rotY;
			h.group.scale.setScalar(
				Math.max(0.001, h.scale * spanScale * (1 + l * 0.05) * grow),
			);
			// While the cover fades up the sleeve has no thickness, and casts no
			// shadow until the image is whole.
			const poured = h.cover.map ? (h.cover.userData.fade ?? 1) : 1;
			h.group.scale.z *= Math.max(
				0.001,
				THREE.MathUtils.smoothstep(poured, 0.55, 1),
			);
			h.sleeve.castShadow = poured > 0.75;
			// The slip sits inside the sleeve: shown before the sleeve has its
			// depth back, it would share the flattened cover's plane and z-fight.
			if (h.slip) h.slip.visible = poured > 0.9 && down < 0.99;
			// The vinyl waits for the cover to be whole before sliding out.
			const discOut = l * THREE.MathUtils.smoothstep(poured, 0.85, 1);
			h.disc.visible = discOut > 0.01;
			h.disc.castShadow = h.disc.visible && poured > 0.9;
			h.disc.position.x = (discOut * DISC_SLIDE) / h.scale;
			if (h.disc.visible) h.disc.rotation.z -= dt * 1.2 * l;
			if (h.slip) {
				// Roughly the same size on a 2×2 as on a 1×1 — it's a note, not
				// part of the sleeve.
				const k = 1 / Math.sqrt(spanScale);
				h.slip.scale.setScalar(k);
				// It slides up out of the sleeve as the cover finishes fading up,
				// and back in while a record's open — on the camera's own ease —
				// since the panel shows the notes itself.
				const tuck = THREE.MathUtils.smoothstep(poured, 0.9, 1) * (1 - down);
				h.slip.position.y =
					TILE / 2 + ((SLIP_PEEK + l * SLIP_PULL) * tuck - SLIP_H / 2) * k;
			}
		};

		// Hover: whatever's under the pointer (desktop); on touch, the record
		// nearest the middle of the screen.
		let nearestMiddle = -1;
		let nearestMiddleD = Number.POSITIVE_INFINITY;

		pickable.current.length = 0;
		const ease = reducedMotion ? 1 : 1 - Math.exp(-6 * dt);
		// A re-filter replays the entrance, once the wall has sunk away.
		if (refilter.current) {
			refilter.current = false;
			entrance.current = {
				at: t + (reducedMotion ? 0 : REFILTER_OUT_S),
				x: camX,
				y: camY,
			};
		}
		entrance.current ??= {
			at: t + (reducedMotion ? 0 : entranceDelayS.current),
			x: camX,
			y: camY,
		};
		const enter = entrance.current;
		for (let i = 0; i < insts.length; i++) {
			const h = handles.current[i];
			if (!h) continue;
			const pos = layout[i];
			const key = insts[i].key;
			// Kept out of the hero's gap while the hero's there.
			const hole = heroHole.current;
			let above = false;
			if (hole) {
				const r = (pos.spanScale * TILE) / 2;
				const hx = wrapNear(pos.x, (hole.x0 + hole.x1) / 2, tileW);
				const hy = wrapNear(pos.y, (hole.y0 + hole.y1) / 2, tileH);
				above =
					hx + r > hole.x0 &&
					hx - r < hole.x1 &&
					hy + r > hole.y0 &&
					hy - r < hole.y1;
			}
			// Still waiting for its turn in the entrance (nearer the middle,
			// sooner).
			const held =
				t <
				enter.at +
					Math.min(
						ENTRANCE_SPREAD_S,
						Math.hypot(
							wrapNear(pos.x, enter.x, tileW) - enter.x,
							wrapNear(pos.y, enter.y, tileH) - enter.y,
						) * ENTRANCE_S_PER_UNIT,
					);
			if (held) above = true;
			let anim = anims.current.get(key);
			if (!anim) {
				anim = {
					x: pos.x,
					y: pos.y,
					spanScale: pos.spanScale,
					presence: (animateIn.current && !reducedMotion) || above ? 0 : 1,
				};
				anims.current.set(key, anim);
			}
			if (anim.relocate) {
				// Moves once it's out of sight — or when its turn to rise
				// comes, sunk or not.
				if (anim.presence < 0.05 || !above) {
					anim.x = pos.x;
					anim.y = pos.y;
					anim.spanScale = pos.spanScale;
					anim.relocate = false;
				}
			} else {
				anim.x += (pos.x - anim.x) * ease;
				anim.y += (pos.y - anim.y) * ease;
				anim.spanScale += (pos.spanScale - anim.spanScale) * ease;
			}
			anim.presence += ((above ? 0 : 1) - anim.presence) * ease;

			// Drawn at its copy nearest the camera.
			const x = wrapNear(anim.x, camX, tileW);
			const y = wrapNear(anim.y, camY, tileH);
			drawnAt.current.set(key, { x, y });
			const reach = (pos.spanScale * TILE) / 2 + 0.3;
			const inView =
				Math.abs(x - camX) < halfW + reach && Math.abs(y - camY) < half + reach;
			// A record stays off the wall until its cover image is ready, then
			// fades up (see cover-material.ts). Records with no photo at all show
			// their plain sleeve straight away.
			const ready = !!h.cover.map || !!h.cover.userData.noCover;
			const visible = ready && inView && anim.presence > 0.01;
			h.group.visible = visible;
			if (!visible) {
				lift.current[i] = 0;
				continue;
			}
			pickable.current.push(i);
			const dMiddle = Math.hypot(x - camX, y - camY);
			if (dMiddle < nearestMiddleD) {
				nearestMiddleD = dMiddle;
				nearestMiddle = i;
			}
			const cover = h.cover;
			// Self-light keeps covers true to their photos; while a record is
			// selected, the others dim with the room and it keeps its own —
			// eased, so moving between records cross-fades.
			const glowGoal = focused === i ? 1 : roomDim;
			const glow = smoothDamp(
				cover.userData.glow ?? glowGoal,
				glowGoal,
				springs.current,
				`glow${key}`,
				0.3,
				dt,
			);
			cover.userData.glow = glow;
			setCoverSelfLight(
				cover,
				(theme.dark ? SELF_LIGHT_DARK : SELF_LIGHT_LIGHT) * glow,
			);
			// The note slip glows a share of its own paper too, eased with the
			// cover's: lit only by the room it came out a dull mustard on the
			// light wall, dimmer than the brand yellow it's printed in.
			if (h.slip) {
				const slipMat = h.slip.material as THREE.MeshStandardMaterial;
				slipMat.emissiveIntensity =
					(theme.dark ? SLIP_SELF_LIGHT_DARK : SLIP_SELF_LIGHT_LIGHT) * glow;
			}
			// The rest of the wall drains to black and white as the lights go
			// down, leaving the selected record the only one in colour — on
			// the same spring, so moving between records cross-fades too.
			const greyGoal = focused === i ? 0 : down;
			const grey = smoothDamp(
				cover.userData.grey ?? greyGoal,
				greyGoal,
				springs.current,
				`grey${key}`,
				0.3,
				dt,
			);
			cover.userData.grey = grey;
			setCoverDesaturate(cover, grey);
			// A cover fades up quickly as its image arrives — no transition.
			const fade = cover.map
				? Math.min(1, (cover.userData.fade ?? 0) + dt / FADE_S)
				: 0;
			if (fade !== cover.userData.fade) {
				cover.userData.fade = fade;
				setCoverFade(cover, reducedMotion && cover.map ? 1 : fade);
			}
		}

		// The record under the mouse, if any.
		const under =
			!isTouch && pointer.current.overWall && !dragging.current
				? pick(ndc)
				: null;
		if (focused >= 0) {
			hovered.current = focused;
		} else if (!isTouch) {
			hovered.current = under;
		} else {
			hovered.current = nearestMiddle >= 0 ? nearestMiddle : null;
		}
		if (!isTouch) {
			// The wall's own cursor (wall-cursor.tsx): over the wall, a
			// record (a click opens it), the open record (a click closes it —
			// not one visited on the intro, which a click opens), or off over
			// the page's controls.
			const cursor = !pointer.current.overWall
				? "off"
				: under == null
					? "wall"
					: chosen >= 0 && under === chosen
						? "close"
						: "record";
			if (document.documentElement.dataset.wallCursor !== cursor) {
				document.documentElement.dataset.wallCursor = cursor;
			}
			// Where that record's middle is on screen, for the cursor's arrow
			// (as drawn last frame — close enough, and it's already placed).
			const target = under != null ? handles.current[under] : null;
			if (target) {
				target.sleeve.getWorldPosition(cursorWorld).project(camera);
				cursorTarget.x = ((cursorWorld.x + 1) / 2) * size.width;
				cursorTarget.y = ((1 - cursorWorld.y) / 2) * size.height;
				cursorTarget.set = true;
			} else {
				cursorTarget.set = false;
			}
		}
		if (hovered.current !== active.current) {
			active.current = hovered.current;
			onActiveChange(
				active.current == null ? null : (insts[active.current]?.record ?? null),
			);
		}
		// Lift (after hover, which needs this frame's positions): a hover
		// answers quickly; the selected record (and the one being let go of)
		// eases forward and back with the camera's move.
		for (const i of pickable.current) {
			const h = handles.current[i];
			if (!h) continue;
			const key = insts[i].key;
			const goal = hovered.current === i ? 1 : 0;
			if (focused === i) h.cover.userData.liftEasing = true;
			const easing = h.cover.userData.liftEasing === true;
			const l = easing
				? smoothDamp(
						lift.current[i],
						goal,
						springs.current,
						`lift${key}`,
						0.32,
						dt,
					)
				: THREE.MathUtils.damp(lift.current[i], goal, 9, dt);
			if (easing && focused !== i && Math.abs(l - goal) < 0.001) {
				h.cover.userData.liftEasing = false;
				springs.current[`lift${key}`] = 0;
			}
			lift.current[i] = l;
			const at = drawnAt.current.get(key);
			const anim = anims.current.get(key);
			if (at && anim) {
				place(h, at.x, at.y, anim.spanScale, layout[i].z, l, anim.presence);
			}
		}

		// Filtered-out records sink back into the wall, then unmount.
		let stillLeaving = false;
		for (const e of exiting) {
			e.anim.presence += (0 - e.anim.presence) * ease;
			const h = exitHandles.current.get(e.key);
			if (!h) continue;
			if (e.anim.presence > 0.01) stillLeaving = true;
			const x = wrapNear(e.anim.x, camX, tileW);
			const y = wrapNear(e.anim.y, camY, tileH);
			h.group.visible =
				e.anim.presence > 0.01 &&
				Math.abs(x - camX) < halfW + 1 &&
				Math.abs(y - camY) < half + 1;
			if (h.group.visible) {
				place(h, x, y, e.anim.spanScale, e.z, 0, e.anim.presence);
			}
		}
		if (exiting.length > 0 && !stillLeaving) setExiting([]);
	});

	const liveKeys = useMemo(
		() => new Set(instances.map((i) => i.key)),
		[instances],
	);
	const register = useCallback(
		(i: number, _key: string, h: TileHandle | null) => {
			handles.current[i] = h;
		},
		[],
	);
	const registerExit = useCallback(
		(_i: number, key: string, h: TileHandle | null) => {
			if (h) exitHandles.current.set(key, h);
			else exitHandles.current.delete(key);
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
				// Dark only: in light mode the daylight casts the shadows, and a
				// second set from the faint cursor highlight doubled them up,
				// offset in another direction.
				castShadow={theme.dark && !isTouch}
			/>
			{/* The wall the records hang on — there to catch shadows. */}
			<mesh
				ref={wall}
				geometry={wallGeometry}
				position={[0, 0, WALL_Z]}
				receiveShadow
				// Drawn first and writing no depth, so it sits behind everything
				// whatever its z — a record tipped partly behind it still shows.
				renderOrder={-1}
			>
				{/* Light: shadows only, over the plain background — lit as a
				    surface, the wall came out grey instead of the page's pure
				    white. Faint: just enough to sit the records on the wall.
				    Dark: a shadow can't darken pure black, so the wall is a
				    near-black surface the torch lights a soft pool on, and the
				    records' shadows show inside that pool. */}
				{theme.dark ? (
					<primitive object={torchWall} attach="material" />
				) : (
					<shadowMaterial opacity={0.12} depthWrite={false} />
				)}
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
				getScroll={getTravelY}
				getScrollX={getTravelX}
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
				getScroll={getTravelY}
				getScrollX={getTravelX}
			/>
			{panelAt && (
				<group ref={panel}>
					<Html transform center pointerEvents="none">
						<div data-wall-hero-panel>
							<CollectionHero count={records.length} />
							<CollectionStatsSentence records={records} intro />
						</div>
					</Html>
				</group>
			)}
			{/* One keyed list for live and leaving records, so a record that gets
			    filtered out keeps its component (and loaded cover) as it sinks
			    away, rather than remounting blank. */}
			{[
				...instances.map((inst, i) => (
					<Tile
						key={inst.key}
						index={i}
						instanceKey={inst.key}
						caption={captionById?.get(inst.record.id)}
						record={inst.record}
						shared={shared}
						placeholder={theme.placeholder}
						register={register}
					/>
				)),
				...exiting
					.filter((e) => !liveKeys.has(e.key))
					.map((e) => (
						<Tile
							key={e.key}
							index={-1}
							instanceKey={e.key}
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
	instanceKey,
	caption,
	record,
	shared,
	placeholder,
	register,
}: {
	index: number;
	instanceKey: string;
	/** `?hero=labels`: a fact about this record, pinned under it. */
	caption?: string;
	record: PublicRecord;
	shared: Shared;
	placeholder: string;
	register: (index: number, key: string, handle: TileHandle | null) => void;
}) {
	const group = useRef<THREE.Group>(null);
	const sleeve = useRef<THREE.Mesh>(null);
	const disc = useRef<THREE.Mesh>(null);
	const slip = useRef<THREE.Mesh>(null);
	const withNotes = hasNotes(record);
	// Each note slip carries its own handwriting: plain paper until the hand
	// font arrives, then the opening words of the record's notes.
	const slipMaterial = useMemo(() => {
		if (!withNotes) return null;
		const material = shared.slip.clone();
		sharpenNoteMaps(material);
		return material;
	}, [withNotes, shared]);
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
			slipMaterial.emissiveMap = texture;
			slipMaterial.emissive.set("#ffffff");
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
		// The lean stays small: its high corner shows more of the slip, and
		// past ±0.03 rad that was enough to show the top of a third line.
		return [(u - 0.5) * 0.52, (v - 0.5) * 0.06];
	}, [record.id]);
	// Created once per record; theme changes are applied by `Wall`.
	// biome-ignore lint/correctness/useExhaustiveDependencies: placeholder is read once at creation
	const cover = useMemo(() => {
		const m = makeCoverMaterial(placeholder);
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
		register(index, instanceKey, {
			id: record.id,
			group: group.current,
			sleeve: sleeve.current,
			disc: disc.current,
			slip: slip.current,
			cover,
			discMaterial,
			scale,
		});
		return () => register(index, instanceKey, null);
	}, [index, instanceKey, record.id, register, cover, discMaterial, scale]);

	return (
		<group ref={group}>
			{caption && <TileCaption text={caption} group={group} />}
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

/** `?hero=labels`: a caption under a record, hidden while it isn't drawn. */
function TileCaption({
	text,
	group,
}: {
	text: string;
	group: React.RefObject<THREE.Group | null>;
}) {
	const el = useRef<HTMLDivElement>(null);
	useFrame(() => {
		if (el.current) {
			el.current.style.opacity = group.current?.visible ? "1" : "0";
		}
	});
	return (
		<Html position={[0, -TILE / 2 - 0.12, 0]} center pointerEvents="none">
			<div ref={el} className="wall-caption">
				{text}
			</div>
		</Html>
	);
}
