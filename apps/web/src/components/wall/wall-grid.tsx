import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import type { PublicRecord } from "#/lib/records";
import { cn } from "#/lib/utils";
import type { WallTheme } from "./wall-scene";

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
	const [env, setEnv] = useState<{ isTouch: boolean; showStats: boolean }>();

	useEffect(() => {
		setEnv({
			isTouch: window.matchMedia("(hover: none) and (pointer: coarse)").matches,
			showStats: new URLSearchParams(window.location.search).has("stats"),
		});
	}, []);
	useParallax();

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
								isTouch={env.isTouch}
								showStats={env.showStats}
							/>
						</Suspense>
					</div>,
					document.body,
				)}
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
				placeholder: dark ? "#262626" : "#e7e5e4",
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
			apply();
		};
		const apply = () => {
			const vh = window.innerHeight;
			const viewCentre = window.scrollY + vh / 2;
			for (const e of entries) {
				const offset = -(e.top + e.height / 2 - viewCentre) * e.factor;
				let visible = 1;
				if (e.fade) {
					// On screen, after the parallax offset.
					const top = e.top + offset - window.scrollY;
					const bottom = top + e.height;
					visible =
						top > vh / 2
							? // Arriving from below: fully in once its top is 35% up.
								Math.min(1, Math.max(0, (vh - top) / (vh * 0.35)))
							: // Leaving the top: gone once its bottom reaches the top edge.
								Math.min(1, Math.max(0, bottom / (vh * 0.5)));
					// Ease, and quantise so a slow scroll doesn't rewrite the
					// filter every frame for invisible changes.
					visible = Math.round(visible * visible * (3 - 2 * visible) * 40) / 40;
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
