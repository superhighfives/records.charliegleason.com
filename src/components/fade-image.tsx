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
 * Robust against the two ways `onLoad` can miss: a cached image is often already
 * `complete` before React wires up the handler (checked in an effect), and a
 * broken src would otherwise stay invisible forever (revealed on `error`). With
 * `prefers-reduced-motion` the transition is dropped, so the image just appears.
 *
 * The opacity toggle is applied *before* the caller's `className`, so a caller
 * that also animates another property can override the transition — e.g. the
 * grid tile passes `transition-[opacity,filter]` to fade in *and* keep its
 * grayscale-on-hover.
 */
export function FadeImage({
	alt,
	className,
	onLoad,
	onError,
	...props
}: ComponentPropsWithoutRef<"img">) {
	const ref = useRef<HTMLImageElement>(null);
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		// A cached image can already be complete before this component mounts, in
		// which case `onLoad` never fires — reveal it straight away.
		if (ref.current?.complete) setLoaded(true);
	}, []);

	return (
		<img
			ref={ref}
			alt={alt}
			className={cn(
				"transition-opacity duration-700 ease-out motion-reduce:transition-none",
				loaded ? "opacity-100" : "opacity-0",
				className,
			)}
			onLoad={(e) => {
				setLoaded(true);
				onLoad?.(e);
			}}
			onError={(e) => {
				// Never leave a broken image stuck invisible.
				setLoaded(true);
				onError?.(e);
			}}
			{...props}
		/>
	);
}
