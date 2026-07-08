import { Link } from "@tanstack/react-router";

// charliegleason.com's emoji generator, rendering the 💿 (optical disc) glyph.
const NOT_FOUND_EMOJI =
	"https://www.charliegleason.com/api/emoji/%F0%9F%92%BF?detailed=false&animated=false";

export function NotFound() {
	return (
		<div className="mx-auto flex min-h-dvh max-w-5xl flex-col items-center justify-center px-4 py-10 text-center sm:px-6">
			<img
				src={NOT_FOUND_EMOJI}
				alt=""
				aria-hidden="true"
				width={72}
				height={72}
				className="mb-6 size-18"
			/>
			<p className="kicker mb-2">Error 404</p>
			<h1 className="font-serif text-4xl font-semibold tracking-tight sm:text-5xl">
				Off the record
			</h1>
			<p className="mt-3 max-w-md text-muted-foreground">
				This one skipped a groove — the page you're looking for isn't in the
				collection.
			</p>
			<Link
				to="/"
				className="mt-8 text-brand-strong underline decoration-brand-strong/60 underline-offset-4 hover:text-foreground"
			>
				Back to the records
			</Link>
		</div>
	);
}
