import { useEffect, useState } from "react";

// TEMP DIAGNOSTIC — not for commit. Reads the REAL animation-timeline: view()
// state for a couple of tiles directly via Element.getAnimations(), cross
// referenced with their actual getBoundingClientRect(), to see whether the
// browser's own progress calculation actually peaks at viewport centre the
// way the spec (and my own math) says it should.
export function ScrollPerfHud() {
	const [text, setText] = useState("waiting for tiles...");

	useEffect(() => {
		let raf: number;
		const tick = () => {
			const tiles = Array.from(
				document.querySelectorAll<HTMLElement>("[data-record-id]"),
			).filter((el) => {
				const r = el.getBoundingClientRect();
				return r.bottom > 0 && r.top < window.innerHeight;
			});
			const vpCenter = window.innerHeight / 2;
			const lines = tiles.slice(0, 4).map((tile) => {
				const img = tile.querySelector("img");
				const rect = tile.getBoundingClientRect();
				const tileCenter = rect.top + rect.height / 2;
				const distFromCenter = Math.round(tileCenter - vpCenter);
				const anims = img?.getAnimations() ?? [];
				const anim = anims[0];
				let progress = "no-anim";
				if (anim?.timeline && anim.effect) {
					const ct = anim.currentTime;
					progress =
						typeof ct === "number" ? `${Math.round(ct)}ms` : String(ct);
				}
				const filter = img ? getComputedStyle(img).filter : "no-img";
				const id = tile.dataset.recordId;
				return `id:${id} h:${Math.round(rect.height)} distC:${distFromCenter} prog:${progress} filter:${filter.slice(0, 20)}`;
			});
			setText(lines.join("\n"));
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, []);

	return (
		<div
			style={{
				position: "fixed",
				top: 0,
				left: 0,
				zIndex: 99999,
				background: "black",
				color: "lime",
				font: "9px monospace",
				padding: "4px 8px",
				whiteSpace: "pre",
				pointerEvents: "none",
			}}
		>
			{text}
		</div>
	);
}
