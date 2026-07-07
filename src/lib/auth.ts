import { env } from "cloudflare:workers";
import { createClerkClient } from "@clerk/backend";
import { createMiddleware } from "@tanstack/react-start";
import { getRequest, setResponseStatus } from "@tanstack/react-start/server";

import { isAdmin } from "#/lib/roles";

/**
 * Server-fn middleware that enforces an admin Clerk session.
 *
 * The client `<SignedIn>` + role gate in /admin is UX only — this is the real
 * security boundary. Attach to any write server function so it can't be called
 * by an unauthenticated (or non-admin) request even if the client guard is bypassed.
 *
 * The role rides in the session token (Clerk includes `public_metadata` by
 * default), so there's no extra API call per request and no session-token
 * customization needed — just set `publicMetadata.role = "admin"` on the user.
 * A custom-mapped `metadata` claim is also honoured as a fallback.
 */
/**
 * Resolve the current request's Clerk session and return the admin's user id, or
 * `null` if the request isn't a signed-in admin. Non-throwing counterpart to
 * {@link authMiddleware}: for a *read* that gets embedded in an SSR loader (like
 * `getRecord`), a thrown 401 would blow up the render instead of letting the
 * client-side signed-out redirect take over — so the caller checks this and
 * degrades softly (e.g. returns `null`). Writes should still use `authMiddleware`,
 * which rejects with 401/403.
 */
export async function getAdminSession(): Promise<{ userId: string } | null> {
	const clerk = createClerkClient({
		secretKey: env.CLERK_SECRET_KEY,
		// Build-time inlined (Vite) — no runtime Wrangler var needed for this one.
		publishableKey: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
	});

	const requestState = await clerk.authenticateRequest(getRequest());
	const auth = requestState.toAuth();
	if (!auth?.userId) return null;

	const role =
		auth.sessionClaims?.public_metadata?.role ??
		auth.sessionClaims?.metadata?.role;
	if (!isAdmin(role)) return null;

	return { userId: auth.userId };
}

export const authMiddleware = createMiddleware({ type: "function" }).server(
	async ({ next }) => {
		const clerk = createClerkClient({
			secretKey: env.CLERK_SECRET_KEY,
			// Build-time inlined (Vite) — no runtime Wrangler var needed for this one.
			publishableKey: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
		});

		const requestState = await clerk.authenticateRequest(getRequest());
		const auth = requestState.toAuth();

		if (!auth?.userId) {
			setResponseStatus(401);
			throw new Error("Unauthorized");
		}

		const role =
			auth.sessionClaims?.public_metadata?.role ??
			auth.sessionClaims?.metadata?.role;
		if (!isAdmin(role)) {
			setResponseStatus(403);
			throw new Error("Forbidden");
		}

		return next({ context: { userId: auth.userId } });
	},
);
