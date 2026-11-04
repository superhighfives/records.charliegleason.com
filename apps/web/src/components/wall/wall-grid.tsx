import { ChevronLeft, ChevronRight } from "lucide-react";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { createPortal } from "react-dom";

import type { PublicRecord } from "#/lib/records";
import { cn } from "#/lib/utils";
import { REVEAL_STYLES } from "./cover-reveal";
import {
	featuredRecords,
	type HeroMode,
	newestRecord,
	readHeroMode,
} from "./hero-modes";
import type { RevealConfig, WallSceneProps, WallTheme } from "./wall-scene";

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
	const [tourStep, setTourStep] = useState<number | null>(null);
	// `?hero=facts`: the stepper lives in the filter pill (collection-view.tsx).
	const [factsSlot, setFactsSlot] = useState<Element | null>(null);
	useEffect(() => {
		if (env?.heroMode !== "facts") return;
		setFactsSlot(document.querySelector("[data-wall-facts-slot]"));
	}, [env?.heroMode]);
	const stepFacts = (by: 1 | -1) =>
		setTourStep((step) => {
			const n = featured.length;
			if (step == null) return by > 0 ? 0 : n - 1;
			return (step + by + n) % n;
		});

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
	const [reveal, setReveal] = useRevealConfig();
	// Where the hero sits on screen (if it's showing), once its fonts are in
	// — the wall leaves it a gap that size.
	useEffect(() => {
		let cancelled = false;
		window.scrollTo(0, 0);
		document.fonts.ready.then(() => {
			if (cancelled) return;
			// Opening on a record, the hero is its caption, not a gap in the wall.
			if (readHeroMode() === "record") {
				setHero(null);
				return;
			}
			// The text itself, not its box (wider than its lines), so the
			// records come right up to the words.
			const el = document.querySelector("[data-wall-hero]");
			let r: DOMRect | undefined;
			if (el) {
				const range = document.createRange();
				range.selectNodeContents(el);
				r = range.getBoundingClientRect();
			}
			setHero(
				r
					? { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
					: null,
			);
		});
		return () => {
			cancelled = true;
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
								onTourStep={setTourStep}
								factStep={env.heroMode === "facts" ? tourStep : null}
								onActiveChange={setRecord}
								onOpen={onOpen}
								onClose={onClose}
								focusedRecordId={focusedRecordId}
								theme={theme}
								reveal={reveal}
								isTouch={env.isTouch}
								showStats={env.showStats}
							/>
						</Suspense>
					</div>,
					document.body,
				)}
			<RevealPanel config={reveal} onChange={setReveal} />
			{factsSlot &&
				featured.length > 0 &&
				createPortal(
					// biome-ignore lint/a11y/useSemanticElements: a labelled group of controls, as the filter groups beside it
					<div role="group" aria-label="Facts" className="filter-group">
						<span className="kicker-muted shrink-0" aria-hidden="true">
							Facts
						</span>
						<button
							type="button"
							className="filter-chip"
							aria-label="Previous fact"
							onClick={() => stepFacts(-1)}
						>
							<ChevronLeft className="size-3.5" />
						</button>
						<span className="filter-count tabular-nums">
							{tourStep == null ? "–" : tourStep + 1}/{featured.length}
						</span>
						<button
							type="button"
							className="filter-chip"
							aria-label="Next fact"
							onClick={() => stepFacts(1)}
						>
							<ChevronRight className="size-3.5" />
						</button>
					</div>,
					factsSlot,
				)}
			{(env?.heroMode === "tour" || env?.heroMode === "facts") && (
				<p
					className="wall-tour-caption text-foreground"
					style={{ opacity: tourStep == null ? 0 : 1 }}
				>
					{tourStep != null ? featured[tourStep]?.caption : null}
				</p>
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

// Bumped when the default changes, so an earlier saved pick doesn't hide it.
const REVEAL_KEY = "wall-reveal-v3";

/** The reveal panel's choices, remembered across reloads. */
function useRevealConfig() {
	const [config, setConfig] = useState<RevealConfig>({ style: "fade" });
	useEffect(() => {
		try {
			const saved = JSON.parse(localStorage.getItem(REVEAL_KEY) ?? "null");
			if (saved && REVEAL_STYLES.includes(saved.style)) {
				setConfig({ style: saved.style });
			}
		} catch {
			// No storage (private mode) or a corrupt saved value: keep the
			// default style.
		}
	}, []);
	const update = useCallback((next: RevealConfig) => {
		setConfig(next);
		try {
			localStorage.setItem(REVEAL_KEY, JSON.stringify({ style: next.style }));
		} catch {
			// No storage (private mode, quota): the choice still applies, it
			// just isn't remembered.
		}
	}, []);
	return [config, update] as const;
}

/**
 * Dev switcher for the transition records make as scrolling brings them in.
 * Shown only with the debug HUD on (Shift+D, which sets `data-debug`).
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
		<div className="fixed bottom-4 left-4 z-40 hidden max-w-[17rem] flex-col gap-1.5 rounded-lg border bg-popover/90 p-2 text-popover-foreground shadow-lg backdrop-blur-sm sm:[[data-debug]_&]:flex">
			<p className="font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
				Reveal
			</p>
			<div className="flex flex-wrap gap-1">
				{REVEAL_STYLES.map((style) => (
					<button
						key={style}
						type="button"
						className={chip(config.style === style)}
						onClick={() => onChange({ style })}
					>
						{style}
					</button>
				))}
			</div>
		</div>
	);
}
