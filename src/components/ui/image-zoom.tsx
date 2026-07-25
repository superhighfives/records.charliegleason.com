import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { type ReactNode, useState } from "react";

import { FadeImage } from "#/components/fade-image";
import { SpinningRecord } from "#/components/spinning-record";
import { cn } from "#/lib/utils.ts";

/**
 * Click-to-zoom image built on Radix Dialog. Renders a thumbnail trigger that
 * opens a centered lightbox of the full-size image, over a dimmed backdrop.
 *
 * The lightbox reserves a square (record covers are square) and spins a loader
 * in it until the image decodes, so a slow load shows the loader rather than a
 * lone close button; the loader also clears on load, covering non-square images.
 *
 * By default the thumbnail is an `<img src>` cropped to the wrapper (`className`
 * sizes/positions it). Pass `children` for a custom trigger (e.g. a matte with a
 * different object-fit), and `overlay` for something floated over the trigger
 * (e.g. a matte tucked into the corner). `onOpenChange` surfaces open state so a
 * caller can gate global keyboard shortcuts while the lightbox is up.
 */
function ImageZoom({
	src,
	alt,
	className,
	children,
	overlay,
	onOpenChange,
}: {
	/** Full-size image shown in the lightbox. */
	src: string;
	alt: string;
	/** Sizes/positions the trigger wrapper; also the positioning context for `overlay`. */
	className?: string;
	/** Custom trigger content. Defaults to an `<img src>` cropped to the wrapper. */
	children?: ReactNode;
	/** Floated over the trigger — e.g. a matte tucked into the corner. */
	overlay?: ReactNode;
	/** Notified when the lightbox opens/closes (e.g. to gate global hotkeys). */
	onOpenChange?: (open: boolean) => void;
}) {
	// Track which src has decoded so the loader clears once the image is up (and
	// resets if the src swaps on a persisting instance). Deriving `loaded` from the
	// src rather than a bare boolean avoids a stale reveal after a swap.
	const [loadedSrc, setLoadedSrc] = useState<string>();
	const loaded = loadedSrc === src;
	return (
		<DialogPrimitive.Root onOpenChange={onOpenChange}>
			<div className={cn("relative", className)}>
				<DialogPrimitive.Trigger asChild>
					<button
						type="button"
						aria-label={`View ${alt}`}
						className="block size-full cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
					>
						{children ?? (
							<img
								src={src}
								alt={alt}
								className="size-full rounded-md border object-cover"
							/>
						)}
					</button>
				</DialogPrimitive.Trigger>
				{overlay}
			</div>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
				<DialogPrimitive.Content className="fixed top-1/2 left-1/2 z-50 flex -translate-x-1/2 -translate-y-1/2 flex-col outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
					<DialogPrimitive.Title className="sr-only">
						{alt}
					</DialogPrimitive.Title>
					{/* Reserve the square up front (90vmin fits both axes) and spin a loader
					    in it — the image fades in on top and clears the loader on decode. */}
					<div className="relative size-[90vmin]">
						{!loaded && (
							<SpinningRecord
								size={48}
								className="-translate-x-1/2 -translate-y-1/2 absolute top-1/2 left-1/2"
							/>
						)}
						<FadeImage
							src={src}
							alt={alt}
							onLoad={() => setLoadedSrc(src)}
							onError={() => setLoadedSrc(src)}
							className="absolute inset-0 size-full rounded-md object-contain shadow-lg"
						/>
					</div>
					<DialogPrimitive.Close
						type="button"
						className="absolute top-2 right-2 rounded-sm bg-background/80 p-1 opacity-80 outline-none ring-offset-background transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
					>
						<XIcon className="size-4" />
						<span className="sr-only">Close</span>
					</DialogPrimitive.Close>
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}

export { ImageZoom };
