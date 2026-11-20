import { useEffect, useLayoutEffect, useRef } from "react";

const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
const HEIGHT_MS = 380;
const CONTENT_MS = 320;
/** How far (px) the new record's content slides in from. */
const SLIDE_PX = 24;
/** How long the header's colours take to blend into the next record's. */
const MESH_MS = 500;
/** Keyframes in the blend between two records' colours (see `meshArrived`). */
const MESH_STEPS = 8;
/** How long to wait for the next record's colours before fading to none. */
const MESH_WAIT_MS = 1000;

const findPanel = () =>
	document.querySelector<HTMLElement>('[data-slot="sheet-content"]');

/**
 * Moving from one record to another with the panel open: the panel eases
 * from the old record's height to the new one's; its text and cover fade
 * and slide in from the side they're coming from (the next record from the
 * right, the previous from the left); and the header's colours blend from
 * the old record's into the new one's. The backgrounds don't slide, so no
 * edge of the panel shows bare behind them. Not on the panel's first open
 * — it slides in whole — and only fades with reduced motion.
 *
 * The panel (`RecordPanel`) is keyed by record, so a new record is a fresh
 * mount: the swap runs after it's committed but before it paints, so it
 * never shows a frame at the new height. By then the old height is gone
 * from the page, so it's tracked while the panel's open — as are the
 * header's colours, which load a moment after the record. Paging fast
 * interrupts cleanly — the next swap starts from wherever the last one had
 * got to.
 */
export function useRecordPanelSwap(
	record: { id: number; index: number } | null,
) {
	const last = useRef<{ id: number; index: number } | null>(null);
	/** The panel's settled height, kept current while it's open. */
	const height = useRef(0);
	const morph = useRef<Animation | null>(null);
	/** The header's colour layer, and a copy of the last one fading under it. */
	const mesh = useRef<{
		el: Element | null;
		/** What the last record's layer looked like, to copy at the swap. */
		snapshot: { className: string; style: string } | null;
		/** That copy, until the new layer has blended in over it. */
		under: HTMLElement | null;
		wait: number;
	}>({ el: null, snapshot: null, under: null, wait: 0 });

	const open = record != null;
	useEffect(() => {
		if (!open) return;
		let watch: ResizeObserver | null = null;
		let colours: MutationObserver | null = null;
		// The sheet portals in a render after it opens — or, opening on a
		// record's own page, only once the page's fonts are in (see
		// `useFontsReady`): look each frame until it's there.
		let raf = 0;
		const start = () => {
			const panel = findPanel();
			if (!panel) {
				raf = requestAnimationFrame(start);
				return;
			}
			height.current = panel.getBoundingClientRect().height;
			watch = new ResizeObserver(() => {
				if (morph.current?.playState !== "running") {
					height.current = panel.getBoundingClientRect().height;
				}
			});
			watch.observe(panel);
			// A record's colours arrive after it does (they're read off its
			// cover): catch its colour layer as it appears.
			colours = new MutationObserver(() => meshArrived(panel, mesh.current));
			colours.observe(panel, { childList: true, subtree: true });
			meshArrived(panel, mesh.current);
		};
		raf = requestAnimationFrame(start);
		return () => {
			cancelAnimationFrame(raf);
			watch?.disconnect();
			colours?.disconnect();
			height.current = 0;
			const m = mesh.current;
			window.clearTimeout(m.wait);
			m.under?.remove();
			mesh.current = { el: null, snapshot: null, under: null, wait: 0 };
		};
	}, [open]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: runs per record
	useLayoutEffect(() => {
		const prev = last.current;
		last.current = record;
		const panel = findPanel();
		if (!panel || !record || !prev || prev.id === record.id) return;

		// Mid-swap, the panel's box is the animated height: start from there.
		const running = morph.current?.playState === "running";
		const from = running
			? panel.getBoundingClientRect().height
			: height.current;
		morph.current?.cancel();
		morph.current = null;
		const to = panel.getBoundingClientRect().height;
		height.current = to;

		const reduced = window.matchMedia(
			"(prefers-reduced-motion: reduce)",
		).matches;
		if (!reduced && from > 0 && Math.abs(from - to) > 1) {
			morph.current = panel.animate(
				[{ height: `${from}px` }, { height: `${to}px` }],
				{ duration: HEIGHT_MS, easing: EASE },
			);
		}
		// The old record's colours, copied in under where the new one's go.
		const m = mesh.current;
		window.clearTimeout(m.wait);
		m.under?.remove();
		m.under = null;
		m.el = null;
		const header = panel.querySelector<HTMLElement>("[data-panel-header]");
		if (m.snapshot && header) {
			const under = document.createElement("div");
			under.setAttribute("aria-hidden", "");
			under.className = m.snapshot.className;
			under.setAttribute("style", m.snapshot.style);
			header.insertBefore(under, header.firstChild);
			m.under = under;
			// A record with no colours: the old ones fade to none.
			m.wait = window.setTimeout(() => {
				if (m.under !== under) return;
				under
					.animate([{ opacity: 0 }], { duration: MESH_MS, easing: EASE })
					.finished.then(
						() => under.remove(),
						() => {},
					);
				m.under = null;
				m.snapshot = null;
			}, MESH_WAIT_MS);
		}
		meshArrived(panel, m);

		const dx = reduced ? 0 : Math.sign(record.index - prev.index) * SLIDE_PX;
		for (const el of panel.querySelectorAll<HTMLElement>(
			"[data-panel-slide], [data-panel-slide-items] > *",
		)) {
			el.animate(
				// From partly there, not from nothing: paging quickly, a fade
				// from 0 blanked the panel for a frame every record.
				[
					{ opacity: 0.35, transform: `translateX(${dx}px)` },
					{ opacity: 1, transform: "none" },
				],
				{ duration: CONTENT_MS, easing: EASE },
			);
		}
	}, [record?.id]);
}

/**
 * When a record's colour layer appears: remember how it looks (for the next
 * swap), and blend it in over the last record's copy, if one's waiting.
 */
function meshArrived(
	panel: HTMLElement,
	m: {
		el: Element | null;
		snapshot: { className: string; style: string } | null;
		under: HTMLElement | null;
		wait: number;
	},
) {
	const el = panel.querySelector<HTMLElement>("[data-panel-mesh]");
	if (!el || el === m.el) return;
	m.el = el;
	m.snapshot = {
		className: el.className,
		style: el.getAttribute("style") ?? "",
	};
	const under = m.under;
	if (!under) return;
	window.clearTimeout(m.wait);
	m.under = null;
	// The new layer fades in over the old one's copy as the copy fades out,
	// keeping how much the two cover together on a straight line from the
	// old layer's alone to the new one's alone. Fading only the new one in
	// over the copy, the two together covered more than the new one alone,
	// so removing the copy at the end dropped the colour back with a jump.
	const to = Number(getComputedStyle(el).opacity);
	const from = Number(getComputedStyle(under).opacity);
	const fadeIn: Keyframe[] = [];
	const fadeOut: Keyframe[] = [];
	for (let i = 0; i <= MESH_STEPS; i++) {
		const t = i / MESH_STEPS;
		const inOpacity = to * t;
		// What's left showing through both, eased from (1 - from) to (1 - to).
		const through = 1 - from + (from - to) * t;
		fadeIn.push({ opacity: inOpacity });
		fadeOut.push({ opacity: Math.max(0, 1 - through / (1 - inOpacity)) });
	}
	const timing = { duration: MESH_MS, easing: EASE };
	under.animate(fadeOut, { ...timing, fill: "forwards" });
	el.animate(fadeIn, timing).finished.then(
		() => under.remove(),
		() => under.remove(),
	);
}
