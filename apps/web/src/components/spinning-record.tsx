import { emojiSrc } from "#/lib/emoji";
import { cn } from "#/lib/utils";

// 💿 optical disc — the same glyph the error pages use for their hero, so the
// loader and the 404/500 discs read as the same spinning object.
const DISC = "%F0%9F%92%BF";

/**
 * A record turning on its spindle. `slow` swaps the brisk loading turn for the
 * error pages' idle rotation. Purely decorative — the surrounding block owns the
 * accessible loading text (see `RecordLoading`).
 */
export function SpinningRecord({
	size = 40,
	slow = false,
	className,
}: {
	size?: number;
	slow?: boolean;
	className?: string;
}) {
	return (
		<img
			src={emojiSrc(DISC)}
			alt=""
			aria-hidden="true"
			width={size}
			height={size}
			style={{ width: size, height: size }}
			className={cn(
				slow ? "animate-record-spin-slow" : "animate-record-spin",
				className,
			)}
		/>
	);
}

/**
 * A centred loading block — a spinning record over an optional caption. Used
 * wherever an admin view is waiting on its data to resolve (the record detail,
 * the collection list) so a slow/auth-gated fetch shows a spinner rather than a
 * flash of "not found" or an empty collection.
 */
export function RecordLoading({
	label = "Loading…",
	className,
}: {
	label?: string;
	className?: string;
}) {
	return (
		<output
			className={cn(
				"flex flex-1 flex-col items-center justify-center gap-4 py-16 text-center",
				className,
			)}
			aria-live="polite"
		>
			<SpinningRecord size={48} />
			<p className="text-sm text-muted-foreground">{label}</p>
		</output>
	);
}
