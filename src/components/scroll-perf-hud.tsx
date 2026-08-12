import { useEffect, useState } from "react";

// TEMP DIAGNOSTIC — not for commit. Checks real support for CSS
// scroll-driven animations on the actual device, not documentation.
export function ScrollPerfHud() {
	const [support, setSupport] = useState("checking...");

	useEffect(() => {
		const view = CSS.supports("animation-timeline: view()");
		const scroll = CSS.supports("animation-timeline: scroll()");
		const range = CSS.supports("animation-range: cover 0% cover 100%");
		setSupport(
			`view():${view} scroll():${scroll} range:${range} ua:${navigator.userAgent.slice(0, 60)}`,
		);
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
				font: "11px monospace",
				padding: "4px 8px",
				whiteSpace: "pre-wrap",
				pointerEvents: "none",
			}}
		>
			{support}
		</div>
	);
}
