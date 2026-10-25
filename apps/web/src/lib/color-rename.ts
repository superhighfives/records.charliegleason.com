import { DEFAULT_COLOR_NAME } from "#/lib/default-color";

/**
 * Why a colour rename should be refused, or `null` if it's fine (including a
 * no-op rename to the same name). Pure, so `renameColor` (colors.ts) and its
 * tests share one rule set. {@link DEFAULT_COLOR_NAME} can't be renamed:
 * record creation and every reassignment look it up by name.
 */
export function renameColorRefusal(
	current: { name: string } | undefined,
	next: string,
	nameTaken: boolean,
): string | null {
	if (!current) return "That color no longer exists.";
	if (current.name === next) return null;
	if (current.name === DEFAULT_COLOR_NAME) {
		return `"${DEFAULT_COLOR_NAME}" can't be renamed — it's the default records fall back to.`;
	}
	if (nameTaken) return `There's already a color called "${next}".`;
	return null;
}
