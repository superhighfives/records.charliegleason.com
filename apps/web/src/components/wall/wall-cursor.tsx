import { HandGrab } from "lucide-react";
import { useEffect, useRef } from "react";

/**
 * The wall's own pointer (mouse only), in place of the system cursor: a
 * small ring that trails the mouse a touch. It swells to say "View" over a
 * record and "Drag" over the hero's text, and turns into a little grabbing
 * hand while the wall's dragged. Over the page's controls the system cursor
 * comes back. Its state is CSS: `data-wall-cursor` (set by the scene from
 * what's under the pointer) and `data-wall-cursor-hero` (set here).
 */
export function WallCursor() {
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
			raf = requestAnimationFrame(tick);
		};
		let heroEl: Element | null = null;
		const onMove = (e: PointerEvent) => {
			if (e.pointerType !== "mouse") return;
			if (to.x < -50) {
				at.x = e.clientX;
				at.y = e.clientY;
			}
			to.x = e.clientX;
			to.y = e.clientY;
			// Over the hero's words (it takes no pointer events itself, so by
			// where it is): "Drag".
			heroEl ??= document.querySelector("[data-wall-hero]");
			let overHero = false;
			if (heroEl?.isConnected && !("wallHeroGone" in root.dataset)) {
				const range = document.createRange();
				range.selectNodeContents(heroEl);
				const r = range.getBoundingClientRect();
				overHero =
					e.clientX > r.left &&
					e.clientX < r.right &&
					e.clientY > r.top &&
					e.clientY < r.bottom;
			}
			if (overHero !== "wallCursorHero" in root.dataset) {
				if (overHero) root.dataset.wallCursorHero = "";
				else delete root.dataset.wallCursorHero;
			}
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
			delete root.dataset.wallCursorHero;
		};
	}, []);
	return (
		<div ref={ref} aria-hidden className="wall-cursor">
			<span className="wall-cursor-view">View</span>
			<span className="wall-cursor-drag">Drag</span>
			<HandGrab className="wall-cursor-hand" strokeWidth={1.75} />
		</div>
	);
}
