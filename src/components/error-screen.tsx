import { Link } from "@tanstack/react-router";
import { emojiSrc } from "#/lib/emoji";

export function ErrorScreen({
	emoji,
	code,
	heading,
	message,
}: {
	/** Percent-encoded emoji glyph, e.g. "%F0%9F%92%BF" for 💿. */
	emoji: string;
	/** Small uppercase eyebrow, e.g. "Error 404". */
	code: string;
	heading: string;
	message: string;
}) {
	return (
		<div className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center px-4 py-10 text-center sm:px-6">
			<img
				src={emojiSrc(emoji)}
				alt=""
				aria-hidden="true"
				width={72}
				height={72}
				className="mb-6 size-18"
			/>
			<p className="kicker mb-2">{code}</p>
			<h1 className="font-serif text-4xl font-semibold tracking-tight sm:text-5xl">
				{heading}
			</h1>
			<p className="mt-3 max-w-md text-muted-foreground">{message}</p>
			<Link
				to="/"
				className="mt-8 text-brand-strong underline decoration-brand-strong/60 underline-offset-4 hover:text-foreground"
			>
				Back to the records
			</Link>
		</div>
	);
}
