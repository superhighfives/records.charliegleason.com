import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { emojiSrc } from "#/lib/emoji";
import { cn } from "#/lib/utils";

export function ErrorScreen({
	emoji,
	code,
	heading,
	message,
	spin = false,
	action,
}: {
	/** Percent-encoded emoji glyph, e.g. "%F0%9F%92%BF" for 💿. */
	emoji: string;
	/** Small uppercase eyebrow, e.g. "Error 404". */
	code: string;
	heading: string;
	message: string;
	/** Rotate the hero glyph slowly — for the record disc on the 404. */
	spin?: boolean;
	/** Replaces the default "Back to the records" link, for a more useful
	 * recovery action (e.g. a reload) — same styling either way. */
	action?: ReactNode;
}) {
	return (
		<div className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center px-4 py-10 text-center sm:px-6">
			<img
				src={emojiSrc(emoji)}
				alt=""
				aria-hidden="true"
				width={72}
				height={72}
				className={cn("mb-6 size-18", spin && "animate-record-spin-slow")}
			/>
			<p className="kicker mb-2">{code}</p>
			<h1 className="font-serif text-4xl font-semibold tracking-tight sm:text-5xl">
				{heading}
			</h1>
			<p className="mt-3 max-w-md text-muted-foreground">{message}</p>
			{action ?? (
				<Link
					to="/"
					className="mt-8 text-brand-strong underline decoration-brand-strong/60 underline-offset-4 hover:text-foreground"
				>
					Back to the records
				</Link>
			)}
		</div>
	);
}
