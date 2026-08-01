import {
	type ComponentPropsWithoutRef,
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

export function FadeImage({
	alt,
	className,
	onLoad,
	onError,
	src,
	...props
}: ComponentPropsWithoutRef<"img">) {
	const ref = useRef<HTMLImageElement>(null);
	// The src we've revealed. Deriving `loaded` from it (rather than storing a
	// boolean) resets the fade in the same render that the src changes — no flash,
	// and no stale `true` carried over from the previous image. Seeded from the
	// session-wide decoded set so an already-seen image mounts revealed (no re-fade).
	const [loadedSrc, setLoadedSrc] = useState<string | undefined>(() =>
		typeof src === "string" && decodedSrcs.has(src) ? src : undefined,
	);
	const loaded = loadedSrc != null && loadedSrc === src;

	const reveal = (value: string | undefined) => {
		if (typeof value === "string") decodedSrcs.add(value);
		setLoadedSrc(value);
	};

	useEffect(() => {
		// A cached image can already be complete before `onLoad` is wired up (on
		// mount, or right after a src swap), in which case the event never fires —
		// reveal it straight away. Inlined (not via `reveal`) so the effect needs no
		// unstable-callback dependency.
		if (ref.current?.complete) {
			if (typeof src === "string") decodedSrcs.add(src);
			setLoadedSrc(src);
		}
	}, [src]);

	return (
		<img
			ref={ref}
			alt={alt}
			src={src}
			className={cn(
				"transition-opacity duration-700 ease-out motion-reduce:transition-none",
				loaded ? "opacity-100" : "opacity-0",
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
