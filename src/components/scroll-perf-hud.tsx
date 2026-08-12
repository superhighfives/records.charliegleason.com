import { useEffect, useRef, useState } from "react";

// TEMP DIAGNOSTIC — not for commit.
export function ScrollPerfHud() {
	const [stats, setStats] = useState({ worst: 0, drops: 0, fps: 0 });
	const lastRef = useRef(performance.now());
	const dropsRef = useRef(0);
	const worstRef = useRef(0);
	const framesRef = useRef(0);
	const windowStartRef = useRef(performance.now());

	useEffect(() => {
		let raf: number;
		const tick = (now: number) => {
			const delta = now - lastRef.current;
			lastRef.current = now;
			framesRef.current++;
			if (delta > 50) dropsRef.current++;
			if (delta > worstRef.current) worstRef.current = delta;
			if (now - windowStartRef.current > 500) {
				setStats({
					worst: Math.round(worstRef.current),
					drops: dropsRef.current,
					fps: Math.round(
						(framesRef.current * 1000) / (now - windowStartRef.current),
					),
				});
				windowStartRef.current = now;
				framesRef.current = 0;
				worstRef.current = 0;
			}
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
				font: "12px monospace",
				padding: "4px 8px",
				pointerEvents: "none",
			}}
		>
			fps:{stats.fps} worst:{stats.worst}ms drops:{stats.drops}
		</div>
	);
}
