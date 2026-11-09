import { ArrowUpRight, HandGrab, X } from "lucide-react";
import { useEffect, useRef } from "react";

import type { PublicRecord } from "#/lib/records";

/** The page's floating panels — the cursor shrinks to a dot near these. */
const PANELS =
	'.floating-controls, [data-wall-filters] > [data-wall-chrome], [data-wall-corner], [data-slot="sheet-content"]';
/** How close (px) to a panel counts as near it. */
const NEAR_PX = 40;

type Box = { left: number; right: number; top: number; bottom: number };

/**
 * Where the panels are, measured once and re-measured only when they can
 * have moved — not every frame, which forced a layout read per frame while
 * the wall animates. They're all `position: fixed`, so scrolling and the
 * wall's motion never move them: only a resize, a panel mounting or
 * unmounting (the record sheet is portaled in and out), a panel changing
 * size, or an entrance animation or transition finishing (the sheet slides
 * in, which is no resize).
 */
function watchPanels(): { boxes: () => Box[]; stop: () => void } {
	let panels: Element[] = [];
	let boxes: Box[] = [];
	function measure() {
		boxes = [];
		for (const panel of panels) {
			const r = panel.getBoundingClientRect();
			if (r.width === 0) continue;
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
	window.addEventListener("resize", measure);
	document.addEventListener("animationend", measure, true);
	document.addEventListener("transitionend", measure, true);
	rescan();
	return {
		boxes: () => boxes,
		stop: () => {
			resize.disconnect();
			mutations.disconnect();
			window.removeEventListener("resize", measure);
			document.removeEventListener("animationend", measure, true);
			document.removeEventListener("transitionend", measure, true);
		},
	};
}

function near(boxes: Box[], x: number, y: number): boolean {
	return boxes.some(
		(b) => x > b.left && x < b.right && y > b.top && y < b.bottom,
	);
}

/**
 * The wall's own pointer (mouse only), in place of the system cursor: a
 * small ring that trails the mouse a touch. Over a record it swells, with
 * the record's title and artist underneath and an arrow (a click opens it) —
 * or, over the record that's open, a cross (a click closes it); while the
 * wall's dragged it's a little grabbing hand. Over the page's controls the system cursor comes
 * back, and near them it shrinks to a dot. Its state is CSS on
 * `data-wall-cursor`, set by the scene from what's under the pointer.
 */
export function WallCursor({ record }: { record: PublicRecord | null }) {
	const ref = useRef<HTMLDivElement>(null);
	const labelRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const layers = [ref.current, labelRef.current].filter(
			(el): el is HTMLDivElement => el != null,
		);
		if (layers.length === 0) return;
		const root = document.documentElement;
		const panels = watchPanels();
		const at = { x: -100, y: -100 };
		const to = { x: -100, y: -100 };
		let raf = 0;
		let last = 0;
		// Eases toward the mouse — close enough to feel attached, loose
		// enough to feel alive.
		const tick = (now: number) => {
			const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
			last = now;
			const k = 1 - Math.exp(-28 * dt);
			at.x += (to.x - at.x) * k;
			at.y += (to.y - at.y) * k;
			// Near the bottom, the label goes above (clear of the filters).
			const low = at.y > window.innerHeight - 160;
			const isNear = near(panels.boxes(), at.x, at.y);
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
		};
		// Leaving the window: hide it rather than leave it at the edge.
		const onLeave = () => {
			delete root.dataset.wallCursor;
		};
		raf = requestAnimationFrame(tick);
		window.addEventListener("pointermove", onMove, { passive: true });
		root.addEventListener("pointerleave", onLeave);
		return () => {
			cancelAnimationFrame(raf);
			panels.stop();
			window.removeEventListener("pointermove", onMove);
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
				<ArrowUpRight
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
