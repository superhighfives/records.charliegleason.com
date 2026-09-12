import type { ErrorComponentProps } from "@tanstack/react-router";
import { ErrorScreen } from "#/components/error-screen";
import { ADMIN_SESSION_ERROR_MESSAGE } from "#/lib/auth";

/**
 * The router's `defaultErrorComponent` (see `router.tsx`) — every route falls
 * back to this unless it defines its own, which is why `AdminSessionError`
 * (see `#/lib/auth`) is handled here rather than on `/admin` or any of its
 * children: TanStack Router resolves `errorComponent` from the exact route
 * that threw, never an ancestor, and the reads that throw it (`listRecords`,
 * `getRecord`) live on leaf routes it wouldn't be worth annotating individually.
 *
 * Matched by message, not `instanceof` — a thrown error doesn't keep its
 * subclass across the SSR→client serialization boundary, so by the time this
 * renders it's already been reconstructed as a plain `Error`.
 */
export function ServerError({ error }: Partial<ErrorComponentProps> = {}) {
	if (error?.message === ADMIN_SESSION_ERROR_MESSAGE) {
		return (
			<ErrorScreen
				// 🔄 counterclockwise arrows
				emoji="%F0%9F%94%84"
				code="Session out of sync"
				heading="Your session needs a moment"
				message="You're signed in, but the server couldn't confirm your admin session — this usually clears up with a reload."
				action={
					<button
						type="button"
						onClick={() => window.location.reload()}
						className="mt-8 text-brand-strong underline decoration-brand-strong/60 underline-offset-4 hover:text-foreground"
					>
						Reload
					</button>
				}
			/>
		);
	}
	return (
		<ErrorScreen
			// 🫠 melting face
			emoji="%F0%9F%AB%A0"
			code="Error 500"
			heading="Something's warped"
			message="A server error knocked the needle off the groove. This one's on me — try again in a moment."
		/>
	);
}
