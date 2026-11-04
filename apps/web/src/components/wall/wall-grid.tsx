import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import type { PublicRecord } from "#/lib/records";
import { cn } from "#/lib/utils";
import {
	featuredRecords,
	type HeroMode,
	newestRecord,
	readHeroMode,
} from "./hero-modes";
import { WallFacts } from "./wall-facts";
import type { WallSceneProps, WallTheme } from "./wall-scene";

const WallScene = lazy(() => import("./wall-scene"));

/**
 * The collection as an endless 3D wall (see `wall-scene.tsx`), in place of
 * `CollectionGrid`. The canvas is portalled to `<body>`, fixed full-screen
 * over the page's own content (the grid's wrapper animates opacity, which
 * would trap a fixed child in its own stacking context). The page itself
 * doesn't scroll (see `[data-wall]` in styles.css); the hero sits in the
 * middle of the screen as part of the wall, measured here once its fonts
 * are in.
 */
export function WallGrid({
	records,
	onOpen,
	onClose,
	focusedRecordId,
}: {
	records: PublicRecord[];
	onOpen: (record: PublicRecord) => void;
	/** Closes the record panel — see `WallSceneProps`. */
	onClose: () => void;
	/** The record the panel has open — see `WallSceneProps`. */
	focusedRecordId: number | null;
}) {
	const [hero, setHero] = useState<WallSceneProps["hero"] | undefined>();
	const [record, setRecord] = useState<PublicRecord | null>(null);
	const theme = useWallTheme();
	const [env, setEnv] = useState<{
		isTouch: boolean;
		showStats: boolean;
		heroMode: HeroMode;
	}>();
	const [factStep, setFactStep] = useState<number | null>(null);

	useEffect(() => {
		const heroMode = readHeroMode();
		// Before the hero's measured: each mode's CSS shapes it.
		document.documentElement.dataset.heroMode = heroMode;
		setEnv({
			isTouch: window.matchMedia("(hover: none) and (pointer: coarse)").matches,
			showStats: new URLSearchParams(window.location.search).has("stats"),
			heroMode,
		});
		return () => {
			delete document.documentElement.dataset.heroMode;
		};
	}, []);
	const featured = useMemo(() => featuredRecords(records), [records]);
	const newest = useMemo(() => newestRecord(records), [records]);
	// Where the hero sits on screen (if it's showing), once its fonts are in
	// — the wall leaves it a gap that size.
	useEffect(() => {
		let cancelled = false;
		window.scrollTo(0, 0);
		// The text itself, not its box (wider than its lines), so the records
		// come right up to the words; and where it sits with the wall back
		// where it started (less how far it's been panned).
		const measure = () => {
			const el = document.querySelector<HTMLElement>("[data-wall-hero]");
			if (!el) return null;
			const range = document.createRange();
			range.selectNodeContents(el);
			const r = range.getBoundingClientRect();
			const dx =
				Number.parseFloat(el.style.getPropertyValue("--wall-pan-x")) || 0;
			const dy =
				Number.parseFloat(el.style.getPropertyValue("--wall-pan-y")) || 0;
			return {
				left: r.left - dx,
				top: r.top - dy,
				right: r.right - dx,
				bottom: r.bottom - dy,
			};
		};
		document.fonts.ready.then(() => {
			if (cancelled) return;
			// Opening on a record, the hero is its caption, not a gap in the wall.
			setHero(readHeroMode() === "record" ? null : measure());
		});
		// Resizing reflows the text: its gap follows, while it's still there.
		let timer = 0;
		const onResize = () => {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				if (readHeroMode() === "record") return;
				if ("wallHeroGone" in document.documentElement.dataset) return;
				const next = measure();
				if (next) setHero(next);
			}, 150);
		};
		window.addEventListener("resize", onResize);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
			window.removeEventListener("resize", onResize);
		};
	}, []);
	// Lets CSS adjust page chrome for the wall — see `[data-wall]` in
	// styles.css (the record panel's backdrop).
	useEffect(() => {
		document.documentElement.dataset.wall = "";
		return () => {
			delete document.documentElement.dataset.wall;
		};
	}, []);

	return (
		<>
			{hero !== undefined &&
				env &&
				theme &&
				createPortal(
					// Above the page's own content (so records and their note
					// slips sit over the hero and filter strip), below its
					// floating controls and the record panel; it never takes a
					// click — the page underneath handles those.
					<div className="pointer-events-none fixed inset-0 z-10">
						<Suspense fallback={null}>
							<WallScene
								records={records}
								hero={hero}
								heroMode={env.heroMode}
								featured={featured}
								introRecordId={
									env.heroMode === "record" ? (newest?.id ?? null) : null
								}
								onFactStep={setFactStep}
								factStep={env.heroMode === "facts" ? factStep : null}
								onActiveChange={setRecord}
								onOpen={onOpen}
								onClose={onClose}
								focusedRecordId={focusedRecordId}
								theme={theme}
								isTouch={env.isTouch}
								showStats={env.showStats}
							/>
						</Suspense>
					</div>,
					document.body,
				)}
			{env?.heroMode === "facts" && (
				<WallFacts
					featured={featured}
					step={factStep}
					onStep={setFactStep}
					hidden={focusedRecordId != null}
				/>
			)}
			<div
				className={cn(
					// Top centre on desktop (the filters and links take the bottom
					// corners); on phones, just above the filters.
					"pointer-events-none fixed inset-x-0 bottom-20 z-40 flex justify-center px-4 transition-opacity duration-300 sm:top-6 sm:bottom-auto",
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
