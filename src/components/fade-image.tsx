import {
	type ComponentPropsWithoutRef,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

import { cn } from "#/lib/utils";

/**
 * An `<img>` that fades in once it has decoded, so cover art and mattes settle
 * onto the page instead of popping in as the bytes arrive (which reads as janky,
 * especially for the lazy-loaded grid tiles). Not used in the image editor — the
 * live preview there wants the raw, immediate pixels.
 *
 * Reveal state is tracked by *which* src has loaded, not a bare boolean, so a src
 * swap on a persisting instance (e.g. an admin thumbnail whose record gets a
 * freshly generated cover while the list stays mounted) fades the new image in
 * too, rather than showing it instantly because the old one had already loaded.
 *
 * Robust against the two ways `onLoad` can miss: a cached image is often already
 * `complete` before React wires up the handler (checked in an effect), and a
 * broken src would otherwise stay invisible forever (revealed on `error`). With
 * `prefers-reduced-motion` the transition is dropped, so the image just appears.
 *
 * The opacity toggle is applied *before* the caller's `className`, so a caller
 * that also animates another property can override the transition — e.g. the
 * grid tile passes `transition-[opacity,filter]` to fade in *and* keep its
 * grayscale-on-hover.
 *
 * Srcs that have decoded once are remembered for the session in `decodedSrcs`, so
 * a *remount* of the same image (e.g. the collection grid re-mounting) shows it
 * instantly at full opacity instead of replaying the fade — which otherwise reads
 * as the whole grid flickering. A first-ever load still fades in normally.
 */
const decodedSrcs = new Set<string>();

/**
 * Whether `src` has already decoded once this session — i.e. whether a
 * `FadeImage` mounted with this src would reveal instantly instead of
 * fading in. Lets a caller seed its own reveal state (e.g. the grid tile's
 * peeking vinyl disc) in step with the cover it's paired with, rather than
 * guessing from `!src` and replaying a fade the cover itself skips.
 */
export function isImageDecoded(src: string | undefined) {
	return typeof src === "string" && decodedSrcs.has(src);
}

export function FadeImage({
	alt,
	className,
	onLoad,
	onError,
	onReady,
	src,
	instant = false,
	...props
}: ComponentPropsWithoutRef<"img"> & {
	/**
	 * Fires once each time the image becomes visible — on real load, on error,
	 * and (unlike `onLoad`) for a cached src that was already decoded before the
	 * handler was wired up. Lets a caller reveal something in step with the image,
	 * e.g. the grid tile fading its vinyl disc in only once the cover is up.
	 */
	onReady?: () => void;
	/**
	 * Skip the fade entirely — reveal the instant it loads/decodes, no opacity
	 * transition. For a spot showing an image that's very likely already
	 * sitting in the browser's cache from being shown elsewhere on the page
	 * (e.g. the record panel's thumbnail, already visible in the grid tile
	 * that opened it) — there the fade has nothing real to smooth over, so it
	 * just reads as an unwanted flicker/reload instead of a reveal.
	 */
	instant?: boolean;
}) {
	const ref = useRef<HTMLImageElement>(null);
	// The src we've revealed. Deriving `loaded` from it (rather than storing a
	// boolean) resets the fade in the same render that the src changes — no flash,
	// and no stale `true` carried over from the previous image. Seeded from the
	// session-wide decoded set so an already-seen image mounts revealed (no re-fade).
	const [loadedSrc, setLoadedSrc] = useState<string | undefined>(() =>
		typeof src === "string" && decodedSrcs.has(src) ? src : undefined,
	);
	const loaded = loadedSrc != null && loadedSrc === src;

	// Notify the caller in step with the reveal, covering every path (DOM onLoad,
	// error, and the cached/seeded cases the event misses). Via a ref so an inline
	// `onReady` doesn't re-fire the effect on every parent render — it runs only
	// when `loaded` actually flips.
	const onReadyRef = useRef(onReady);
	onReadyRef.current = onReady;
	useEffect(() => {
		if (loaded) onReadyRef.current?.();
	}, [loaded]);

	// True from mount to unmount — guards the rAF pair below against firing
	// (and warning) after this instance is gone, which matters more than usual
	// here: see the note on `mountedRef.current` inside `reveal`.
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	// Two rAFs (not zero, not one) bracket a real paint of the *pre-reveal*
	// (opacity-0) frame before the class flips — otherwise, on a fast or
	// already-cached load, React can resolve the state update within the same
	// commit/paint as the initial mount, so the browser never actually paints
	// the hidden starting point the CSS transition would animate from. The
	// result is a hard cut instead of a fade, most visible when several images
	// on a page all finish around the same instant (they cut in unison). A
	// single rAF can still land before that first paint; two reliably don't.
	const reveal = useCallback(
		(value: string | undefined) => {
			// `decodedSrcs` is deliberately marked here, not at the top of
			// `reveal`, and only if this instance survived to actually paint the
			// reveal: a caller that unmounts this instance before the rAF pair
			// fires (the collection grid remounts every tile once, right after
			// hydration, when it switches from its plain first-paint markup to
			// the virtualized one) would otherwise mark the src decoded for an
			// animation that never played — the *next* mount then reads it back
			// as "already seen" and skips the fade it's actually showing for the
			// first time, i.e. exactly the interrupted mount's hard-cut bug.
			const commit = () => {
				if (!mountedRef.current) return;
				if (typeof value === "string") decodedSrcs.add(value);
				setLoadedSrc(value);
			};
			// `instant` has no pre-reveal (opacity-0) frame to protect a paint
			// of, so it skips straight to committing — the two-rAF bracket below
			// exists purely to guarantee the browser paints that hidden starting
			// point before the class flips (see the file doc comment).
			if (instant) {
				commit();
				return;
			}
			requestAnimationFrame(() => requestAnimationFrame(commit));
		},
		[instant],
	);

	useEffect(() => {
		// A cached image can already be complete before `onLoad` is wired up (on
		// mount, or right after a src swap), in which case the event never fires —
		// reveal it via the same rAF-bracketed path as everything else.
		if (ref.current?.complete) reveal(src);
	}, [src, reveal]);

	return (
		<img
			ref={ref}
			alt={alt}
			src={src}
			className={cn(
				!instant &&
					"transition-opacity duration-700 ease-out motion-reduce:transition-none",
				!instant && (loaded ? "opacity-100" : "opacity-0"),
				className,
			)}
			onLoad={(e) => {
				reveal(src);
				onLoad?.(e);
			}}
			onError={(e) => {
				// Never leave a broken image stuck invisible.
				reveal(src);
				onError?.(e);
			}}
			{...props}
		/>
	);
}
