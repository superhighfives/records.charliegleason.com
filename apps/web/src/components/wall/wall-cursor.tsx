import { ArrowRight, HandGrab, X } from "lucide-react";
import { useEffect, useRef } from "react";

import type { PublicRecord } from "#/lib/records";

/** The page's floating panels — the cursor shrinks to a dot near these. */
const PANELS =
	'.floating-controls, [data-wall-filters] > [data-wall-chrome], [data-wall-corner], [data-slot="sheet-content"]';
/** How close (px) to a panel counts as near it. */
const NEAR_PX = 40;
/** Where the cursor becomes a text caret. */
const TEXT =
	'input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="range"]), textarea, [contenteditable="true"]';
/** What the cursor grows a little over: anything clickable. */
const CLICKABLE =
	'a[href], button:not(:disabled), [role="button"], [role="link"], select, summary, label[for]';

type Box = { left: number; right: number; top: number; bottom: number };

/**
 * Where the record under the pointer is centred on screen (CSS px), written
 * by the scene every frame (wall-scene.tsx); the cursor's arrow points at it.
 */
export const cursorTarget = { x: 0, y: 0, set: false };

/**
 * Where the panels are, measured once and re-measured only when they can
 * have moved — not every frame, which forced a layout read per frame while
 * the wall animates. They're all `position: fixed`, so scrolling and the
 * wall's motion never move them: only a resize, a panel mounting or
 * unmounting (the record sheet is portaled in and out), a panel changing
 * size, or an entrance animation or transition finishing (the sheet slides
 * in, which is no resize). A panel that's switched off (`pointer-events:
 * none` — the page's controls, faded out while a record's open) doesn't
 * count, so it leaves no dead space for the cursor where it was; opening
 * or closing a record re-measures.
 */
function watchPanels(): { boxes: () => Box[]; stop: () => void } {
	let panels: Element[] = [];
	let boxes: Box[] = [];
	function measure() {
		boxes = [];
		for (const panel of panels) {
			const r = panel.getBoundingClientRect();
			if (r.width === 0 || getComputedStyle(panel).pointerEvents === "none") {
				continue;
			}
			boxes.push({
				left: r.left - NEAR_PX,
				right: r.right + NEAR_PX,
				top: r.top - NEAR_PX,
				bottom: r.bottom + NEAR_PX,
			});
		}
	}
	const resize = new ResizeObserver(measure);
	// Re-finds the panels only when the DOM's children change: observing
	// reports once per `observe()`, so re-observing on every measure would
	// loop.
	function rescan() {
		const next = [...document.querySelectorAll(PANELS)];
		if (
			next.length !== panels.length ||
			next.some((panel, i) => panel !== panels[i])
		) {
			resize.disconnect();
			panels = next;
			for (const panel of panels) resize.observe(panel);
		}
		measure();
	}
	const mutations = new MutationObserver(rescan);
	mutations.observe(document.body, { childList: true, subtree: true });
	const focus = new MutationObserver(measure);
	focus.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["data-wall-focus"],
	});
	window.addEventListener("resize", measure);
	document.addEventListener("animationend", measure, true);
	document.addEventListener("transitionend", measure, true);
	rescan();
	return {
		boxes: () => boxes,
		stop: () => {
			resize.disconnect();
			mutations.disconnect();
			focus.disconnect();
			window.removeEventListener("resize", measure);
			document.removeEventListener("animationend", measure, true);
			document.removeEventListener("transitionend", measure, true);
		},
	};
}

/** Past this size (px) a control's too big to become: it gets the dot. */
const MORPH_MAX = { w: 320, h: 120 };
/** How far (0–1) the cursor leans off a control's middle toward the mouse. */
const MORPH_LEAN = 0.12;

/** The shape the cursor takes over a control. */
type Morph = { x: number; y: number; w: number; h: number; r: number };

/** How long (ms) after a click the cursor keeps re-measuring its control. */
const SETTLE_MS = 500;

/**
 * The cursor as part of a control: the control's own shape, just inside its
 * outline if it has one (a filter chip's pill), or just around it if not
 * (the logo, a text link) — round, unless it has corners of its own. Round
 * stays the dot's own (huge) radius, so morphing to it never passes
 * through a corner.
 */
function morphFor(el: Element): Morph | null {
	const r = el.getBoundingClientRect();
	if (r.width === 0 || r.width > MORPH_MAX.w || r.height > MORPH_MAX.h) {
		return null;
	}
	const cs = getComputedStyle(el);
	const framed =
		Number.parseFloat(cs.borderTopWidth) > 0 ||
		!/^(transparent|rgba\(0, 0, 0, 0\))$/.test(cs.backgroundColor);
	const pad = framed ? -3 : 3;
	const w = r.width + pad * 2;
	const h = r.height + pad * 2;
	const own = Number.parseFloat(cs.borderTopLeftRadius) || 0;
	const round = own === 0 || own >= Math.min(r.width, r.height) / 2;
	return {
		x: r.left + r.width / 2,
		y: r.top + r.height / 2,
		w,
		h,
		r: round ? 9999 : Math.max(2, own + pad),
	};
}

function near(boxes: Box[], x: number, y: number): boolean {
	return boxes.some(
		(b) => x > b.left && x < b.right && y > b.top && y < b.bottom,
	);
}

/**
 * The wall's own pointer (mouse only), in place of the system cursor
 * everywhere on the page: a small ring that trails the mouse a touch. Over
 * a record it swells, with the record's title and artist underneath and an
 * arrow pointing at its middle (a click opens it) — or, over the record
 * that's open, a cross (a click closes it); while the wall's dragged it's a
 * little grabbing hand. Over and near the page's controls it shrinks to a
 * dot; over something to click it becomes part of it, taking its shape;
 * and over a text field it's a caret. Its state is CSS on `data-wall-cursor`, set by the scene from what's
 * under the pointer.
 */
export function WallCursor({ record }: { record: PublicRecord | null }) {
	const ref = useRef<HTMLDivElement>(null);
	const labelRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const layers = [ref.current, labelRef.current].filter(
			(el): el is HTMLDivElement => el != null,
		);
		if (layers.length === 0) return;
		const arrow = ref.current?.querySelector<SVGElement>(".wall-cursor-open");
		const root = document.documentElement;
		const panels = watchPanels();
		const at = { x: -100, y: -100 };
		const to = { x: -100, y: -100 };
		/** The arrow's heading (radians), easing toward the record's middle. */
		let angle = -Math.PI / 4;
		/** The control under the mouse, and the shape the cursor takes on it. */
		let control: Element | null = null;
		let morph: Morph | null = null;
		const reshape = () => {
			const el = ref.current;
			morph = control ? morphFor(control) : null;
			if (!el) return;
			el.classList.toggle("is-clickable", morph != null);
			if (morph) {
				el.style.setProperty("--morph-w", `${morph.w}px`);
				el.style.setProperty("--morph-h", `${morph.h}px`);
				el.style.setProperty("--morph-r", `${morph.r}px`);
			}
		};
		let raf = 0;
		let last = 0;
		// Eases toward the mouse — close enough to feel attached, loose
		// enough to feel alive.
		/** Until when (clock ms) to re-measure the control every frame. */
		let settleUntil = 0;
		const tick = (now: number) => {
			const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
			last = now;
			if (control && now < settleUntil) reshape();
			const k = 1 - Math.exp(-28 * dt);
			// On a control it settles on the control, leaning a little
			// toward the mouse.
			const gx = morph ? morph.x + (to.x - morph.x) * MORPH_LEAN : to.x;
			const gy = morph ? morph.y + (to.y - morph.y) * MORPH_LEAN : to.y;
			at.x += (gx - at.x) * k;
			at.y += (gy - at.y) * k;
			// Near the bottom, the label goes above (clear of the filters).
			const low = at.y > window.innerHeight - 160;
			const isNear = near(panels.boxes(), at.x, at.y);
			// The arrow turns to the record's middle — unless it's right on
			// it, where the heading's meaningless, so it holds.
			if (arrow && cursorTarget.set) {
				const dx = cursorTarget.x - at.x;
				const dy = cursorTarget.y - at.y;
				if (Math.hypot(dx, dy) > 8) {
					const goal = Math.atan2(dy, dx);
					// The short way round.
					const turn =
						((((goal - angle + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) %
							(2 * Math.PI)) -
						Math.PI;
					angle += turn * (1 - Math.exp(-18 * dt));
					arrow.style.rotate = `${angle}rad`;
				}
			}
			for (const el of layers) {
				el.style.transform = `translate(${at.x}px, ${at.y}px)`;
				el.classList.toggle("is-low", low);
				el.classList.toggle("is-near", isNear);
			}
			raf = requestAnimationFrame(tick);
		};
		const onMove = (e: PointerEvent) => {
			if (e.pointerType !== "mouse") return;
			if (to.x < -50) {
				at.x = e.clientX;
				at.y = e.clientY;
			}
			to.x = e.clientX;
			to.y = e.clientY;
			// What it's over: a caret on text fields; on things to click, it
			// becomes part of them (measured once on the way in).
			const target = e.target instanceof Element ? e.target : null;
			const text = target?.closest(TEXT) != null;
			ref.current?.classList.toggle("is-text", text);
			const next = text ? null : (target?.closest(CLICKABLE) ?? null);
			if (next !== control) {
				control = next;
				reshape();
			}
		};
		// A control can move under a still mouse when what it's in scrolls
		// (the record panel), or when something around it finishes moving.
		const remeasure = () => {
			if (control) reshape();
		};
		// So can a click: a filter chip turning on brings in "Clear", which
		// shifts the chips along. Follow it until it settles, and again
		// whenever something finishes animating.
		const onClick = () => {
			settleUntil = performance.now() + SETTLE_MS;
		};
		// Leaving the window: hide it rather than leave it at the edge.
		const onLeave = () => {
			delete root.dataset.wallCursor;
		};
		raf = requestAnimationFrame(tick);
		window.addEventListener("pointermove", onMove, { passive: true });
		window.addEventListener("scroll", remeasure, {
			capture: true,
			passive: true,
		});
		window.addEventListener("click", onClick, { capture: true });
		document.addEventListener("transitionend", remeasure, true);
		document.addEventListener("animationend", remeasure, true);
		root.addEventListener("pointerleave", onLeave);
		return () => {
			cancelAnimationFrame(raf);
			panels.stop();
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("scroll", remeasure, { capture: true });
			window.removeEventListener("click", onClick, { capture: true });
			document.removeEventListener("transitionend", remeasure, true);
			document.removeEventListener("animationend", remeasure, true);
			root.removeEventListener("pointerleave", onLeave);
		};
	}, []);
	// The label keeps the last record's words while it fades, rather than
	// emptying as it goes.
	const shown = useRef<PublicRecord | null>(null);
	if (record) shown.current = record;
	const label = shown.current;
	return (
		<>
			<div ref={ref} aria-hidden className="wall-cursor">
				<HandGrab
					className="wall-cursor-icon wall-cursor-hand"
					strokeWidth={1.75}
				/>
				<ArrowRight
					className="wall-cursor-icon wall-cursor-open"
					strokeWidth={1.75}
				/>
				<X className="wall-cursor-icon wall-cursor-close" strokeWidth={1.75} />
			</div>
			<div
				ref={labelRef}
				aria-hidden
				className="wall-cursor wall-cursor--label"
			>
				{label && (
					<div className="wall-cursor-label">
						<p className="font-serif text-base font-medium leading-tight">
							{label.title}
						</p>
						<p className="font-mono text-xs opacity-80">{label.artist}</p>
					</div>
				)}
			</div>
		</>
	);
}
