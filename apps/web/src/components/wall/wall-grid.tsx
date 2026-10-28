import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { computeSpanningIds } from "#/components/collection-grid";
import { displayCoverKey, photoUrl } from "#/lib/cover";
import type { PublicRecord } from "#/lib/records";
import { cn } from "#/lib/utils";
import { REVEAL_STYLES } from "./cover-reveal";
import type { RevealConfig, WallTheme } from "./wall-scene";

const WallScene = lazy(() => import("./wall-scene"));

/**
 * Prototype stand-in for `CollectionGrid`: the same records rendered as a lit
 * 3D wall (see `wall-scene.tsx`). This component only reserves the grid's
 * space in the page (`slot`) — the canvas itself is portalled to `<body>`,
 * fixed full-screen *behind* the page, because the grid's wrapper animates
 * opacity, which would trap a fixed child in its own stacking context and
 * paint it over the hero and footer.
 *
 * Also drives the page parallax: any element marked `data-parallax="<f>"`
 * drifts against the scroll by factor `f` — 0 scrolls normally, positive
 * moves slower than the page (lags behind), negative moves faster — so the
 * header and footer move independently of the wall. Add `data-parallax-fade`
 * and it also fades and blurs out as it leaves the top of the screen, and in
 * ("fades up") as it arrives from the bottom. Transform/opacity/filter only —
 * no layout — written once per scrolled frame.
 */
export function WallGrid({
	records,
	onOpen,
	focusedRecordId,
}: {
	records: PublicRecord[];
	onOpen: (record: PublicRecord) => void;
	/** The record the panel has open — see `WallSceneProps`. */
	focusedRecordId: number | null;
}) {
	const [slot, setSlot] = useState<HTMLDivElement | null>(null);
	const [height, setHeight] = useState<number | null>(null);
	const [active, setActive] = useState<number | null>(null);
	const theme = useWallTheme();
	const [env, setEnv] = useState<{
		isTouch: boolean;
		showStats: boolean;
		dof: boolean;
	}>();

	useEffect(() => {
		setEnv({
			isTouch: window.matchMedia("(hover: none) and (pointer: coarse)").matches,
			showStats: new URLSearchParams(window.location.search).has("stats"),
			dof: !new URLSearchParams(window.location.search).has("nodof"),
		});
	}, []);
	useParallax();
	const [reveal, setReveal] = useRevealConfig();
	useCoverPrefetch(records, env?.isTouch ?? false);
	// Lets CSS adjust page chrome for the wall — see `[data-wall]` in
	// styles.css (the record panel's backdrop).
	useEffect(() => {
		document.documentElement.dataset.wall = "";
		return () => {
			delete document.documentElement.dataset.wall;
		};
	}, []);

	const onContentHeight = useCallback((px: number) => setHeight(px), []);
	const record = active == null ? null : records[active];

	return (
		<>
			<div
				ref={setSlot}
				// Until the scene reports its height, hold roughly the DOM grid's.
				style={{ height: height ?? "70vh" }}
				aria-hidden
			/>
			{slot &&
				env &&
				theme &&
				createPortal(
					<div className="fixed inset-0 -z-10">
						<Suspense fallback={null}>
							<WallScene
								records={records}
								slot={slot}
								onActiveChange={setActive}
								onOpen={onOpen}
								focusedRecordId={focusedRecordId}
								onContentHeight={onContentHeight}
								theme={theme}
								reveal={reveal}
								isTouch={env.isTouch}
								showStats={env.showStats}
								dof={env.dof}
							/>
						</Suspense>
					</div>,
					document.body,
				)}
			<RevealPanel config={reveal} onChange={setReveal} />
			<div
				className={cn(
					"pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4 transition-opacity duration-300",
					record ? "opacity-100" : "opacity-0",
				)}
			>
				{record && (
					<div className="flex max-w-[calc(100%-2rem)] flex-col items-center gap-0.5 rounded-md border bg-popover/95 px-4 py-2 text-center text-popover-foreground shadow-lg">
						<p className="text-balance font-serif text-base font-medium leading-tight">
							{record.title}
						</p>
						<p className="font-mono text-muted-foreground text-xs">
							{record.artist}
						</p>
					</div>
				)}
			</div>
		</>
	);
}

/** Reads the page theme, and follows the theme toggle (`.dark` on `<html>`). */
function useWallTheme(): WallTheme | null {
	const [theme, setTheme] = useState<WallTheme | null>(null);
	useEffect(() => {
		const read = () => {
			const dark = document.documentElement.classList.contains("dark");
			setTheme({
				dark,
				background: getComputedStyle(document.body).backgroundColor,
				placeholder: dark ? "#262626" : "#e4dfd6",
			});
		};
		read();
		const observer = new MutationObserver(read);
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class"],
		});
		return () => observer.disconnect();
	}, []);
	return theme;
}

/** See `WallGrid`: `data-parallax` elements drift (and fade) with scroll. */
function useParallax() {
	useEffect(() => {
		type Entry = {
			el: HTMLElement;
			factor: number;
			fade: boolean;
			/** Document-space top and height, measured without our transform. */
			top: number;
			height: number;
			/** Last written style, so unchanged frames write nothing. */
			last: string;
		};
		let entries: Entry[] = [];
		let maxScroll = 0;
		const measure = () => {
			entries = [
				...document.querySelectorAll<HTMLElement>("[data-parallax]"),
			].map((el) => {
				el.style.transform = "";
				const r = el.getBoundingClientRect();
				const fade = el.hasAttribute("data-parallax-fade");
				if (fade) el.style.willChange = "transform, opacity, filter";
				return {
					el,
					factor: Number(el.dataset.parallax) || 0,
					fade,
					top: r.top + window.scrollY,
					height: r.height,
					last: "",
				};
			});
			maxScroll = Math.max(
				0,
				document.documentElement.scrollHeight - window.innerHeight,
			);
			apply();
		};
		const apply = () => {
			const vh = window.innerHeight;
			const scrollY = window.scrollY;
			for (const e of entries) {
				// Each element's resting scroll position: where it's centred on
				// screen, clamped to what the page can actually scroll to. At rest
				// it sits exactly where layout put it, fully visible — so the hero
				// is untouched at the top of the page and the footer at the bottom,
				// however far from the screen's centre either one sits there.
				const rest = Math.min(
					maxScroll,
					Math.max(0, e.top + e.height / 2 - vh / 2),
				);
				// > 0 once scrolled past its rest, < 0 while still arriving.
				const past = scrollY - rest;
				const offset = past * e.factor;
				let visible = 1;
				if (e.fade) {
					// Arriving: fades up over the last stretch before its rest.
					// Leaving: only once its bottom edge nears the top of the
					// screen — so an element whose rest sits a little above the
					// page's end (the footer) is still crisp at the very bottom.
					const bottom = e.top + e.height + offset - scrollY;
					const t =
						past < 0
							? Math.min(1, -past / (vh * 0.55))
							: Math.min(1, Math.max(0, 1 - bottom / (vh * 0.35)));
					// Ease, and quantise so a slow scroll doesn't rewrite the
					// filter every frame for invisible changes.
					const v = 1 - t * t * (3 - 2 * t);
					visible = Math.round(v * 40) / 40;
				}
				const blur = (1 - visible) * 10;
				const style = `${offset.toFixed(1)}|${visible}`;
				if (style === e.last) continue;
				e.last = style;
				e.el.style.transform = `translate3d(0, ${offset.toFixed(1)}px, 0)`;
				if (e.fade) {
					e.el.style.opacity = String(visible);
					e.el.style.filter = blur > 0.05 ? `blur(${blur.toFixed(1)}px)` : "";
				}
			}
		};
		let raf = 0;
		const onScroll = () => {
			if (!raf)
				raf = requestAnimationFrame(() => {
					raf = 0;
					apply();
				});
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(document.body);
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			observer.disconnect();
			window.removeEventListener("scroll", onScroll);
			cancelAnimationFrame(raf);
			for (const { el } of entries) {
				el.style.transform = "";
				el.style.opacity = "";
				el.style.filter = "";
				el.style.willChange = "";
			}
		};
	}, []);
}

const REVEAL_KEY = "wall-reveal";

/** The reveal panel's choices, remembered across reloads. */
function useRevealConfig() {
	const [config, setConfig] = useState<RevealConfig>({
		style: "wax",
		trigger: "enter",
		replay: 0,
	});
	useEffect(() => {
		try {
			const saved = JSON.parse(localStorage.getItem(REVEAL_KEY) ?? "null");
			if (saved && REVEAL_STYLES.includes(saved.style)) {
				setConfig((c) => ({
					...c,
					style: saved.style,
					trigger: saved.trigger === "scroll" ? "scroll" : "enter",
				}));
			}
		} catch {}
	}, []);
	const update = useCallback((next: RevealConfig) => {
		setConfig(next);
		try {
			localStorage.setItem(
				REVEAL_KEY,
				JSON.stringify({ style: next.style, trigger: next.trigger }),
			);
		} catch {}
	}, []);
	return [config, update] as const;
}

/**
 * Prototype switcher for how records appear: the transition style, whether
 * it plays on entering view or follows the scroll, and a replay.
 */
function RevealPanel({
	config,
	onChange,
}: {
	config: RevealConfig;
	onChange: (next: RevealConfig) => void;
}) {
	const chip = (active: boolean) =>
		cn(
			"rounded-full border px-2 py-0.5 font-mono text-[11px] transition-colors",
			active
				? "border-foreground bg-foreground text-background"
				: "border-border text-muted-foreground hover:text-foreground",
		);
	return (
		<div className="fixed bottom-4 left-4 z-40 hidden max-w-[17rem] flex-col gap-1.5 rounded-lg border bg-popover/90 p-2 text-popover-foreground shadow-lg backdrop-blur-sm sm:flex">
			<p className="font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
				Reveal
			</p>
			<div className="flex flex-wrap gap-1">
				{REVEAL_STYLES.map((style) => (
					<button
						key={style}
						type="button"
						className={chip(config.style === style)}
						onClick={() =>
							onChange({ ...config, style, replay: config.replay + 1 })
						}
					>
						{style}
					</button>
				))}
			</div>
			<div className="flex flex-wrap items-center gap-1">
				{(["enter", "scroll"] as const).map((trigger) => (
					<button
						key={trigger}
						type="button"
						className={chip(config.trigger === trigger)}
						onClick={() =>
							onChange({ ...config, trigger, replay: config.replay + 1 })
						}
					>
						{trigger === "enter" ? "on enter" : "scroll"}
					</button>
				))}
				<button
					type="button"
					className={cn(chip(false), "ml-auto")}
					onClick={() => onChange({ ...config, replay: config.replay + 1 })}
				>
					replay ↻
				</button>
			</div>
		</div>
	);
}

/**
 * Warms the browser's HTTP cache with every cover the wall will want, top of
 * the collection first, a few at a time, once the page has settled — so by
 * the time a record scrolls into view its image is usually already local and
 * its reveal can start straight away. The texture stream still decides what
 * goes to the GPU; this only saves the network wait. Same sizes the wall
 * requests (a 2×2 gets the larger cover).
 */
function useCoverPrefetch(records: PublicRecord[], isTouch: boolean) {
	useEffect(() => {
		const spanning = computeSpanningIds(records);
		const urls: string[] = [];
		for (const record of records) {
			const key = displayCoverKey(record);
			if (!key) continue;
			const big = spanning.has(record.id);
			urls.push(
				photoUrl(key, big ? (isTouch ? 512 : 900) : isTouch ? 256 : 512),
			);
		}
		let cancelled = false;
		let next = 0;
		const worker = async () => {
			while (!cancelled && next < urls.length) {
				const url = urls[next++];
				try {
					await fetch(url, { priority: "low" } as RequestInit);
				} catch {}
			}
		};
		// Let the first screenful (requested by the scene itself) go first.
		const start = window.setTimeout(() => {
			for (let i = 0; i < 4; i++) void worker();
		}, 1500);
		return () => {
			cancelled = true;
			window.clearTimeout(start);
		};
	}, [records, isTouch]);
}
