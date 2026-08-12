import { useEffect, useState } from "react";

// TEMP DIAGNOSTIC — not for commit.
export function ScrollPerfHud() {
	const [text, setText] = useState("waiting for tiles...");

	useEffect(() => {
		let raf: number;
		const tick = () => {
			const dbg =
				(
					window as unknown as {
						__ambientDebug?: Record<string, number>;
					}
				).__ambientDebug ?? {};
			const dbgLine = `effectRuns:${dbg.effectRuns ?? "?"} scrollCalls:${dbg.scrollCalls ?? "?"} obsFires:${dbg.ambientObserverFires ?? "?"} updateCalls:${dbg.ambientUpdateCalls ?? "?"} idsSize:${dbg.lastAmbientIdsSize ?? "?"}\nfalloffPx:${dbg.falloffPx ?? "?"} innerHAtMount:${dbg.innerHeightAtMount ?? "?"} lastInnerH:${dbg.lastInnerHeight ?? "?"} lastDist:${dbg.lastDist ?? "?"}`;
			const tiles = Array.from(
				document.querySelectorAll<HTMLElement>("[data-record-id]"),
			).filter((el) => {
				const r = el.getBoundingClientRect();
				return r.bottom > 0 && r.top < window.innerHeight;
			});
			const vpCenter = window.innerHeight / 2;
			const lines = tiles.slice(0, 3).map((tile) => {
				const img = tile.querySelector("img");
				const rect = tile.getBoundingClientRect();
				const distFromCenter = Math.round(
					rect.top + rect.height / 2 - vpCenter,
				);
				const filter = img ? getComputedStyle(img).filter : "no-img";
				const id = tile.dataset.recordId;
				return `id:${id} distC:${distFromCenter} filter:${filter.slice(0, 20)}`;
			});
			setText([dbgLine, ...lines].join("\n"));
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
				maxWidth: "100vw",
				overflow: "hidden",
			}}
		>
			{text}
		</div>
	);
}
