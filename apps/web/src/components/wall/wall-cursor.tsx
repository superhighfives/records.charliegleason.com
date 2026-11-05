import { HandGrab } from "lucide-react";
import { useEffect, useRef } from "react";

import type { PublicRecord } from "#/lib/records";

/**
 * The wall's own pointer (mouse only), in place of the system cursor: a
 * small ring that trails the mouse a touch. Over a record it swells, with
 * the record's title and artist underneath; while the wall's dragged it's a
 * little grabbing hand. Over the page's controls the system cursor comes
 * back. Its state is CSS on `data-wall-cursor`, set by the scene from
 * what's under the pointer.
 */
export function WallCursor({ record }: { record: PublicRecord | null }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const root = document.documentElement;
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
			el.style.transform = `translate(${at.x}px, ${at.y}px)`;
			// Near the bottom, the label goes above (clear of the filters).
			el.classList.toggle("is-low", at.y > window.innerHeight - 160);
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
		<div ref={ref} aria-hidden className="wall-cursor">
			<HandGrab className="wall-cursor-hand" strokeWidth={1.75} />
			{label && (
				<div className="wall-cursor-label">
					<p className="font-serif text-base font-medium leading-tight">
						{label.title}
					</p>
					<p className="font-mono text-xs opacity-70">{label.artist}</p>
				</div>
			)}
		</div>
	);
}
