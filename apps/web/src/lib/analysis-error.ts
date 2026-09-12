/**
 * Turn a raw stored analysis error into something an admin can act on.
 *
 * The Cloudflare AI Gateway reports an exhausted-credits / billing problem on a
 * Unified-Billing partner model as the misleading `2021: Invalid User
 * Credentials` — it isn't a bad token, it's the account running out of AI
 * allowance mid-run. Detect that case and attach a nudge to check credits so we
 * don't send anyone chasing a token that's actually fine.
 */
export function describeAnalysisError(error: string | null | undefined): {
	message: string;
	hint: string | null;
} {
	const message = error?.trim() || "Unknown error.";
	// AI Gateway credits/allowance exhausted surfaces as this auth-shaped error.
	const isCredits = /invalid user credentials|\b2021\b/i.test(message);
	return {
		message,
		hint: isCredits
			? "This usually means the Cloudflare AI credits/allowance ran out rather than a bad token — check your account credits and try again."
			: null,
	};
}
