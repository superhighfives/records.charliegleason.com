import { useLayoutEffect, useRef } from "react";
import { numberToWords } from "#/lib/number-to-words";

/** Per-word stagger for the statement's write-in — see `.hero-word`. */
const HERO_WORD_STAGGER_MS = 55;
/** When the first word starts. */
const HERO_START_MS = 80;

/**
 * The words of the statement, each tagged with whether it's set in the
 * brand's yellow italic (the framing) or plain (the number).
 */
function heroWords(count: number): { text: string; accent: boolean }[] {
	const accent = (s: string) =>
		s.split(" ").map((text) => ({ text, accent: true }));
	return [
		...accent("All"),
		...numberToWords(count)
			.split(" ")
			.map((text) => ({ text, accent: false })),
		...accent("of my records, photographed, documented, and displayed."),
	];
}

/**
 * When the write-in is (nearly) done, so the rest of the page can follow
 * it in. Slightly before the last word lands, so the hand-off overlaps
 * rather than pausing.
 */
export function heroDurationMs(count: number): number {
	return HERO_START_MS + (heroWords(count).length - 2) * HERO_WORD_STAGGER_MS;
}

/**
 * The collection page's opening statement — big type, top left — which is
 * also the page's loading moment: it writes itself in word by word as soon
 * as the fonts are ready, and the controls, filters and grid fade up once
 * it's done (see `heroDurationMs`). Room on the right is left clear for the
 * floating controls. Each word is its own inline-block so it can rise in
 * on its own; the spaces stay plain text between them so wrapping and
 * `text-pretty` behave exactly as for a normal sentence.
 */
export function CollectionHero({ count }: { count: number }) {
	const words = heroWords(count);
	const ref = useRef<HTMLParagraphElement>(null);
	// Lines each accent word's gradient copy up with the statement as a whole
	// (see `.hero-accent`). Re-measured whenever the statement resizes, which
	// covers rewrapping and the web font swapping in. `offsetTop` ignores the
	// write-in's transforms, so mid-animation measurements are still right.
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const measure = () => {
			el.style.setProperty("--hero-h", `${el.offsetHeight}px`);
			for (const word of el.querySelectorAll<HTMLElement>(".hero-accent")) {
				word.style.setProperty("--hero-y", `${-word.offsetTop}px`);
			}
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	return (
		<p
			ref={ref}
			className="relative mt-16 mb-24 max-w-6xl font-serif text-5xl font-medium tracking-tight text-pretty sm:mt-20 sm:mb-32 sm:text-6xl lg:text-8xl"
		>
			{words.map((word, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: fixed word order
				<span key={i}>
					{i > 0 && " "}
					<span
						className={
							word.accent
								? "hero-word hero-accent italic"
								: "hero-word text-foreground"
						}
						style={{
							animationDelay: `${HERO_START_MS + i * HERO_WORD_STAGGER_MS}ms`,
						}}
					>
						{word.text}
					</span>
				</span>
			))}
		</p>
	);
}
