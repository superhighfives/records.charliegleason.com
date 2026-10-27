import { useEffect, useRef, useState } from "react";

/**
 * App-wide perf/debug HUD. Off by default; turn it on with `?debug` (or the
 * older `?perf`) in the URL, or Shift+Option+D anywhere. The on/off choice is
 * remembered in localStorage so it survives navigation and reloads on a real
 * device; `?debug=0` turns it back off.
 *
 * Everything per-frame is written straight to the DOM — no React state — so
 * the meter costs a canvas draw and a few text writes per frame and never
 * re-renders anything. It shows:
 *
 * - fps, worst frame gap and count of frames over 34ms (two vsyncs) for the
 *   last second, plus a frame-time sparkline (green ≤ 16.7ms, amber ≤ 34ms,
 *   red beyond)
 * - long animation frames (Chrome's LoAF; `longtask` elsewhere) over the last
 *   10s, with the worst one's top script attribution — that's what names the
 *   function behind a hitch
 * - CLS, DOM node count, mounted `<img>`s, and JS heap where exposed
 *
 * Read numbers off a production build (`vite build` + `vite preview`, or the
 * live site) — dev React's `jsxDEV` and friends inflated render cost several
 * times over in a profiled throttled-mobile scroll, enough to manufacture
 * jank that production didn't have. The HUD flags a dev build as such.
 *
 * One caveat when reading it on iOS: WebKit can suppress rAF entirely during
 * parts of a native momentum scroll, which reports as one huge gap right as
 * scrolling settles — that's the main thread being *idle* while the
 * compositor scrolls, not a hitch; the number that matters is the worst
 * frame while updates are actually flowing.
 *
 * The toggles flip `data-` flags on `<html>` that styles.css keys off, so a
 * suspected-expensive effect can be A/B'd live on a real device. `?noclip` /
 * `?noshadow` still preset them.
 */

const STORAGE_KEY = "debug-overlay";
const SPARK_FRAMES = 120;
const LONG_FRAME_WINDOW_MS = 10_000;

const FLAGS = [
	{ key: "noclip", label: "no clip" },
	{ key: "noshadow", label: "no shadow" },
	{ key: "noanim", label: "no animation" },
	{ key: "nofilter", label: "no filter" },
] as const;
type FlagKey = (typeof FLAGS)[number]["key"];

type LongFrame = {
	at: number;
	duration: number;
	blocking: number;
	culprit: string | null;
};

export function DebugOverlay() {
	const [enabled, setEnabled] = useState(false);

	// Read in an effect, not during render, so SSR and the first client render
	// stay identical for hydration.
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const param = params.get("debug") ?? params.get("perf");
		let next = false;
		try {
			if (param === "0") localStorage.removeItem(STORAGE_KEY);
			else if (param != null) localStorage.setItem(STORAGE_KEY, "1");
			next = localStorage.getItem(STORAGE_KEY) === "1";
		} catch {
			next = param != null && param !== "0";
		}
		setEnabled(next);
		for (const { key } of FLAGS) {
			if (params.has(key)) document.documentElement.dataset[key] = "true";
		}

		const onKey = (e: KeyboardEvent) => {
			if (e.code !== "KeyD" || !e.shiftKey || !e.altKey) return;
			e.preventDefault();
			setEnabled((on) => {
				try {
					if (on) localStorage.removeItem(STORAGE_KEY);
					else localStorage.setItem(STORAGE_KEY, "1");
				} catch {}
				return !on;
			});
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	return enabled ? <DebugPanel /> : null;
}

function DebugPanel() {
	const statsRef = useRef<HTMLDivElement>(null);
	const longRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const longFramesRef = useRef<LongFrame[]>([]);
	const [collapsed, setCollapsed] = useState(false);
	const [flags, setFlags] = useState<Record<FlagKey, boolean>>(() => {
		const out = {} as Record<FlagKey, boolean>;
		for (const { key } of FLAGS) {
			out[key] = document.documentElement.dataset[key] === "true";
		}
		return out;
	});

	useEffect(() => {
		for (const { key } of FLAGS) {
			if (flags[key]) document.documentElement.dataset[key] = "true";
			else delete document.documentElement.dataset[key];
		}
	}, [flags]);

	// Long frames + layout shifts. LoAF (Chrome 123+) attributes the frame to
	// the scripts that ran in it; `longtask` is the coarser fallback.
	const clsRef = useRef(0);
	useEffect(() => {
		const observers: PerformanceObserver[] = [];
		const supported = PerformanceObserver.supportedEntryTypes ?? [];
		const push = (frame: LongFrame) => {
			const list = longFramesRef.current;
			list.push(frame);
			const cutoff = performance.now() - LONG_FRAME_WINDOW_MS;
			while (list.length && list[0].at < cutoff) list.shift();
		};
		if (supported.includes("long-animation-frame")) {
			const o = new PerformanceObserver((list) => {
				for (const entry of list.getEntries() as LoAFEntry[]) {
					const top = [...(entry.scripts ?? [])].sort(
						(a, b) => b.duration - a.duration,
					)[0];
					push({
						at: entry.startTime,
						duration: entry.duration,
						blocking: entry.blockingDuration ?? 0,
						culprit: top ? describeScript(top) : null,
					});
				}
			});
			o.observe({ type: "long-animation-frame", buffered: false });
			observers.push(o);
		} else if (supported.includes("longtask")) {
			const o = new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) {
					push({
						at: entry.startTime,
						duration: entry.duration,
						blocking: entry.duration - 50,
						culprit: null,
					});
				}
			});
			o.observe({ type: "longtask", buffered: false });
			observers.push(o);
		}
		if (supported.includes("layout-shift")) {
			const o = new PerformanceObserver((list) => {
				for (const entry of list.getEntries() as LayoutShiftEntry[]) {
					if (!entry.hadRecentInput) clsRef.current += entry.value;
				}
			});
			o.observe({ type: "layout-shift", buffered: true });
			observers.push(o);
		}
		return () => {
			for (const o of observers) o.disconnect();
		};
	}, []);

	// The frame clock. Collapsed still measures (so expanding shows real
	// numbers) but skips the sparkline draw.
	const collapsedRef = useRef(collapsed);
	collapsedRef.current = collapsed;
	useEffect(() => {
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d");
		const dpr = window.devicePixelRatio || 1;
		if (canvas) {
			canvas.width = SPARK_FRAMES * 2 * dpr;
			canvas.height = 40 * dpr;
		}
		const deltas = new Float32Array(SPARK_FRAMES);
		let head = 0;
		let raf = 0;
		let last = performance.now();
		let windowStart = last;
		let worst = 0;
		let slow = 0;
		let frames = 0;

		const draw = () => {
			if (!ctx || !canvas) return;
			const w = canvas.width;
			const h = canvas.height;
			const barW = w / SPARK_FRAMES;
			const scale = h / 50; // 50ms ceiling
			ctx.clearRect(0, 0, w, h);
			ctx.fillStyle = "rgb(255 255 255 / 0.15)";
			ctx.fillRect(0, h - 16.7 * scale, w, dpr);
			ctx.fillRect(0, h - 33.4 * scale, w, dpr);
			for (let i = 0; i < SPARK_FRAMES; i++) {
				const d = deltas[(head + i) % SPARK_FRAMES];
				if (!d) continue;
				ctx.fillStyle = d <= 17.5 ? "#4ade80" : d <= 34 ? "#fbbf24" : "#f87171";
				const bh = Math.min(h, d * scale);
				ctx.fillRect(i * barW, h - bh, Math.max(1, barW - dpr), bh);
			}
		};

		const tick = (now: number) => {
			const delta = now - last;
			last = now;
			deltas[head] = delta;
			head = (head + 1) % SPARK_FRAMES;
			frames++;
			if (delta > worst) worst = delta;
			if (delta > 34) slow++;
			if (!collapsedRef.current) draw();
			const elapsed = now - windowStart;
			if (elapsed > 1000) {
				const fps = Math.round((frames * 1000) / elapsed);
				if (statsRef.current) {
					statsRef.current.textContent = formatStats(
						fps,
						worst,
						slow,
						clsRef.current,
					);
				}
				if (longRef.current) {
					longRef.current.textContent = formatLongFrames(
						longFramesRef.current,
						now,
					);
				}
				windowStart = now;
				worst = 0;
				slow = 0;
				frames = 0;
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, []);

	const dump = () => {
		console.table(
			longFramesRef.current.map((f) => ({
				at: Math.round(f.at),
				duration: Math.round(f.duration),
				blocking: Math.round(f.blocking),
				culprit: f.culprit,
			})),
		);
	};

	return (
		<div
			data-debug-overlay
			className="fixed top-14 left-2 z-[100] w-[272px] select-none rounded-md bg-black/85 p-2 font-mono text-[10px] text-white leading-snug shadow-lg"
		>
			<button
				type="button"
				onClick={() => setCollapsed((c) => !c)}
				className="w-full text-left"
				aria-expanded={!collapsed}
			>
				<div ref={statsRef} className="whitespace-pre">
					measuring…
				</div>
			</button>
			<div className={collapsed ? "hidden" : undefined}>
				{import.meta.env.DEV && (
					<div className="mt-1 text-amber-300">
						dev build — React cost is inflated
					</div>
				)}
				<canvas ref={canvasRef} className="mt-1.5 block h-10 w-full" />
				<div ref={longRef} className="mt-1.5 whitespace-pre-wrap break-all" />
				<div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1">
					{FLAGS.map(({ key, label }) => (
						<label key={key} className="flex items-center gap-1">
							<input
								type="checkbox"
								checked={flags[key]}
								onChange={(e) =>
									setFlags((f) => ({ ...f, [key]: e.target.checked }))
								}
							/>
							{label}
						</label>
					))}
				</div>
				<button
					type="button"
					onClick={dump}
					className="mt-2 rounded bg-white/15 px-1.5 py-0.5 hover:bg-white/25"
				>
					Dump long frames to console
				</button>
			</div>
		</div>
	);
}

function formatStats(fps: number, worst: number, slow: number, cls: number) {
	const nodes = document.getElementsByTagName("*").length;
	const imgs = document.images.length;
	const mem = (performance as PerformanceWithMemory).memory;
	const heap = mem ? ` · heap ${Math.round(mem.usedJSHeapSize / 1e6)}MB` : "";
	return (
		`${fps} fps · worst ${Math.round(worst)}ms · >34ms ×${slow}\n` +
		`dom ${nodes} · img ${imgs} · cls ${cls.toFixed(3)}${heap}`
	);
}

function formatLongFrames(frames: LongFrame[], now: number) {
	const recent = frames.filter((f) => now - f.at < LONG_FRAME_WINDOW_MS);
	if (recent.length === 0) return "long frames (10s): none";
	const worst = recent.reduce((a, b) => (b.duration > a.duration ? b : a));
	const blocking = recent.reduce((sum, f) => sum + f.blocking, 0);
	return (
		`long frames (10s): ${recent.length} · blocking ${Math.round(blocking)}ms\n` +
		`worst ${Math.round(worst.duration)}ms${worst.culprit ? ` ← ${worst.culprit}` : ""}`
	);
}

function describeScript(script: LoAFScript) {
	const fn = script.sourceFunctionName || script.invoker || "anonymous";
	const file = script.sourceURL?.split("/").pop()?.split("?")[0];
	return `${fn}${file ? ` (${file})` : ""} ${Math.round(script.duration)}ms`;
}

// Not yet in TS's DOM lib.
type LoAFScript = {
	duration: number;
	invoker?: string;
	sourceURL?: string;
	sourceFunctionName?: string;
};
type LoAFEntry = PerformanceEntry & {
	blockingDuration?: number;
	scripts?: LoAFScript[];
};
type LayoutShiftEntry = PerformanceEntry & {
	value: number;
	hadRecentInput: boolean;
};
type PerformanceWithMemory = Performance & {
	memory?: { usedJSHeapSize: number };
};
