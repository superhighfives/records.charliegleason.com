import { useEffect, useLayoutEffect, useRef } from "react";

const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
const HEIGHT_MS = 380;
const CONTENT_MS = 320;
/** How far (px) the new record's content slides in from. */
const SLIDE_PX = 24;

const findPanel = () =>
	document.querySelector<HTMLElement>('[data-slot="sheet-content"]');

/**
 * Moving from one record to another with the panel open: the panel eases
 * from the old record's height to the new one's, and the new content slides
 * in from the side it's coming from (the next record from the right, the
 * previous from the left). Not on the panel's first open — it slides in
 * whole — and only a fade with reduced motion.
 *
 * The panel (`RecordPanel`) is keyed by record, so a new record is a fresh
 * mount: the swap runs after it's committed but before it paints, so it
 * never shows a frame at the new height. By then the old height is gone
 * from the page, so it's tracked while the panel's open. Paging fast
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

	const open = record != null;
	useEffect(() => {
		if (!open) return;
		let watch: ResizeObserver | null = null;
		// The sheet portals in a render after it opens.
		const raf = requestAnimationFrame(() => {
			const panel = findPanel();
			if (!panel) return;
			height.current = panel.getBoundingClientRect().height;
			watch = new ResizeObserver(() => {
				if (morph.current?.playState !== "running") {
					height.current = panel.getBoundingClientRect().height;
				}
			});
			watch.observe(panel);
		});
		return () => {
			cancelAnimationFrame(raf);
			watch?.disconnect();
			height.current = 0;
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
		const dx = reduced ? 0 : Math.sign(record.index - prev.index) * SLIDE_PX;
		panel.querySelector<HTMLElement>("[data-panel-body]")?.animate(
			[
				{ opacity: 0, transform: `translateX(${dx}px)` },
				{ opacity: 1, transform: "none" },
			],
			{ duration: CONTENT_MS, easing: EASE },
		);
	}, [record?.id]);
}
