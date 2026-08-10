import { XIcon } from "lucide-react";
import { Dialog as SheetPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "#/lib/utils.ts";

/**
 * Sliding drawer built on Radix Dialog — a lightweight local take on shadcn's
 * Sheet. Defaults to the right edge; other sides are supported for completeness.
 */

function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
	return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({
	...props
}: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
	return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({
	...props
}: React.ComponentProps<typeof SheetPrimitive.Close>) {
	return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetOverlay({
	className,
	enterAnimation = true,
	...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay> & {
	enterAnimation?: boolean;
}) {
	return (
		<SheetPrimitive.Overlay
			data-slot="sheet-overlay"
			className={cn(
				"fixed inset-0 z-50 bg-white/50 dark:bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-500",
				enterAnimation &&
					"data-[state=open]:animate-in data-[state=open]:fade-in-0",
				className,
			)}
			{...props}
		/>
	);
}

// Per-side enter (slide-in) animation, applied only when `enterAnimation` is on.
const SIDE_ENTER = {
	right: "data-[state=open]:slide-in-from-right",
	left: "data-[state=open]:slide-in-from-left",
	top: "data-[state=open]:slide-in-from-top",
	bottom: "data-[state=open]:slide-in-from-bottom",
} as const;

function SheetContent({
	className,
	children,
	side = "right",
	enterAnimation = true,
	...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
	side?: "top" | "right" | "bottom" | "left";
	/**
	 * Slide the panel in when it opens (default). Set false to have it appear in
	 * place with no enter animation — e.g. a record opened by direct navigation,
	 * where a slide-in would look like a spurious transition on page load. The
	 * exit animation is unaffected.
	 */
	enterAnimation?: boolean;
}) {
	return (
		<SheetPrimitive.Portal data-slot="sheet-portal">
			<SheetOverlay enterAnimation={enterAnimation} />
			<SheetPrimitive.Content
				data-slot="sheet-content"
				className={cn(
					"fixed z-50 flex flex-col bg-background shadow-lg transition ease-in-out outline-none data-[state=closed]:animate-out data-[state=closed]:duration-300",
					enterAnimation &&
						"data-[state=open]:animate-in data-[state=open]:duration-500",
					side === "right" &&
						"inset-y-0 right-0 h-full w-full border-l data-[state=closed]:slide-out-to-right sm:max-w-md",
					side === "left" &&
						"inset-y-0 left-0 h-full w-full border-r data-[state=closed]:slide-out-to-left sm:max-w-md",
					side === "top" &&
						"inset-x-0 top-0 h-auto border-b data-[state=closed]:slide-out-to-top",
					side === "bottom" &&
						"inset-x-0 bottom-0 h-auto border-t data-[state=closed]:slide-out-to-bottom",
					enterAnimation && SIDE_ENTER[side],
					className,
				)}
				{...props}
			>
				{children}
				<SheetPrimitive.Close
					type="button"
					className="absolute top-4 right-4 rounded-sm opacity-70 outline-none ring-offset-background transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none z-10"
				>
					<XIcon className="size-4" />
					<span className="sr-only">Close</span>
				</SheetPrimitive.Close>
			</SheetPrimitive.Content>
		</SheetPrimitive.Portal>
	);
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="sheet-header"
			className={cn("flex flex-col gap-1.5 p-6", className)}
			{...props}
		/>
	);
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="sheet-footer"
			className={cn("mt-auto flex items-center gap-2 p-6", className)}
			{...props}
		/>
	);
}

function SheetTitle({
	className,
	...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
	return (
		<SheetPrimitive.Title
			data-slot="sheet-title"
			className={cn("font-semibold text-foreground", className)}
			{...props}
		/>
	);
}

function SheetDescription({
	className,
	...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
	return (
		<SheetPrimitive.Description
			data-slot="sheet-description"
			className={cn("text-sm text-muted-foreground", className)}
			{...props}
		/>
	);
}

export {
	Sheet,
	SheetTrigger,
	SheetClose,
	SheetContent,
	SheetHeader,
	SheetFooter,
	SheetTitle,
	SheetDescription,
};
