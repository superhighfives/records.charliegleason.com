import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { cn } from "#/lib/utils.ts";

/**
 * Click-to-zoom image built on Radix Dialog. Renders a thumbnail that opens a
 * centered modal with the full-size image. Pass the same `src`/`alt` you'd give
 * a plain <img>; `className` styles the thumbnail.
 */
function ImageZoom({
	src,
	alt,
	className,
}: {
	src: string;
	alt: string;
	className?: string;
}) {
	return (
		<DialogPrimitive.Root>
			<DialogPrimitive.Trigger asChild>
				<button
					type="button"
					className={cn(
						"cursor-zoom-in rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
						className,
					)}
				>
					<img
						src={src}
						alt={alt}
						className="size-full rounded-md border object-cover"
					/>
				</button>
			</DialogPrimitive.Trigger>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
				<DialogPrimitive.Content className="fixed top-1/2 left-1/2 z-50 flex max-h-[90vh] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 flex-col outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
					<DialogPrimitive.Title className="sr-only">
						{alt}
					</DialogPrimitive.Title>
					<img
						src={src}
						alt={alt}
						className="max-h-[90vh] max-w-[90vw] rounded-md object-contain shadow-lg"
					/>
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
