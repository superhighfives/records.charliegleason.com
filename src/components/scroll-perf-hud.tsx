import { useEffect, useState } from "react";

// TEMP DIAGNOSTIC — not for commit.
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
			const lines = tiles.slice(0, 5).map((tile) => {
				const img = tile.querySelector("img");
				const disc = tile.querySelector<SVGSVGElement>(".vinyl-disc");
				const rect = tile.getBoundingClientRect();
				const tileCenter = rect.top + rect.height / 2;
				const distFromCenter = Math.round(tileCenter - vpCenter);
				const filter = img ? getComputedStyle(img).filter : "no-img";
				const imgInlineStyle = img?.getAttribute("style") ?? "no-style-attr";
				const discTransform = disc
					? getComputedStyle(disc).transform
					: "no-disc";
				const id = tile.dataset.recordId;
				const active = tile.dataset.active ?? "false";
				return `id:${id} distC:${distFromCenter} active:${active}\n  filter:${filter.slice(0, 25)}\n  discT:${discTransform.slice(0, 30)}\n  imgStyle:${imgInlineStyle.slice(0, 40)}`;
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
				font: "8px monospace",
				padding: "4px 8px",
				whiteSpace: "pre",
				pointerEvents: "none",
				maxWidth: "100vw",
				overflow: "hidden",
			}}
		>
			{text}
		</div>
	);
}
