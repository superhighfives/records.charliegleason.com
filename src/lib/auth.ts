import { env } from "cloudflare:workers";
import { createClerkClient } from "@clerk/backend";
import { createMiddleware, createServerOnlyFn } from "@tanstack/react-start";
import {
	getRequest,
	type ResponseHeaderName,
	setResponseHeader,
	setResponseStatus,
} from "@tanstack/react-start/server";

import { isAdmin } from "#/lib/roles";

/**
 * `clerk.authenticateRequest` can come back `"handshake"` rather than a clean
 * signed-in/signed-out verdict: the session token is stale (crossing to a
 * fresh preview subdomain, or enough time has passed since the last visit)
 * but the client may still be validly authenticated. Clerk's contract is that
 * the caller forwards a 307 + its `headers` (a `Location` back to Clerk's
 * handshake endpoint, plus the `Set-Cookie`s that refresh the session) so the
 * browser can round-trip and come back with a verifiable session. Skipping
 * this — as `toAuth()` alone does, since it just returns null for a handshake
 * state — means every request forever reads as "no session": nothing about
 * that changes on a reload, because the same incomplete round-trip repeats
 * each time.
 */
export function forwardHandshake(headers: Headers): void {
	setResponseStatus(307);
	const setCookies =
		typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
	for (const [key, value] of headers.entries()) {
		if (key.toLowerCase() === "set-cookie") continue;
		setResponseHeader(key as ResponseHeaderName, value);
	}
	if (setCookies.length > 0) {
		setResponseHeader("Set-Cookie" as ResponseHeaderName, setCookies);
	}
}

/**
 * `AdminSessionError`'s message — exported so a client-side error boundary can
 * recognise one by content. A thrown `Error` doesn't survive the SSR→client
 * serialization boundary as its subclass: TanStack Start's server-fn/loader
 * error channel reconstructs it as a plain `Error`, so `instanceof
 * AdminSessionError` is always false by the time a route's `errorComponent`
 * sees it. The message is the only thing that reliably makes the trip.
 */
export const ADMIN_SESSION_ERROR_MESSAGE =
	"Admin session couldn't be verified — try reloading.";

/**
 * Thrown by a read (`listRecords`, `getRecord`) when `getAdminSession` comes back
 * null — the client-side `<SignedIn>` role gate in `/admin/route.tsx` says this
 * request should be an admin, but the server-side Clerk session it's actually
 * carrying doesn't agree (typically a stale/unrefreshed session token — the
 * client SDK's live user object and the server's verified session JWT can
 * genuinely disagree for a beat). Distinct from "the record doesn't exist" or
 * "the collection is empty" so a caller can render an explicit retry prompt
 * instead of a misleadingly-empty list. See `ADMIN_SESSION_ERROR_MESSAGE` for
 * why detecting one back on the client goes by message, not `instanceof`.
 */
export class AdminSessionError extends Error {
	constructor() {
		super(ADMIN_SESSION_ERROR_MESSAGE);
		this.name = "AdminSessionError";
	}
}

/**
 * Resolve the current request's Clerk session and return the admin's user id, or
 * `null` if the request isn't a signed-in admin. Non-throwing counterpart to
 * {@link authMiddleware}: for a *read* that gets embedded in an SSR loader (like
 * `getRecord`), a thrown 401 would blow up the render instead of letting the
 * client-side signed-out redirect take over — so the caller checks this and
 * degrades softly (e.g. returns `null`). Writes should still use `authMiddleware`,
 * which rejects with 401/403.
 *
 * Wrapped in `createServerOnlyFn` because this file is transitively imported by
 * client routes (via `#/lib/records`): the wrapper keeps the server-only
 * `getRequest()` call out of the client bundle (mirrors how `authMiddleware`'s
 * `.server()` body is excluded) and throws if it's ever called from the client.
 */
export const getAdminSession = createServerOnlyFn(
	async (): Promise<{ userId: string } | null> => {
		const clerk = createClerkClient({
			secretKey: env.CLERK_SECRET_KEY,
			// Build-time inlined (Vite) — no runtime Wrangler var needed for this one.
			publishableKey: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
		});

		const requestState = await clerk.authenticateRequest(getRequest());
		if (requestState.status === "handshake") {
			forwardHandshake(requestState.headers);
			return null;
		}
		const auth = requestState.toAuth();
		if (!auth?.userId) return null;

		const role =
			auth.sessionClaims?.public_metadata?.role ??
			auth.sessionClaims?.metadata?.role;
		if (!isAdmin(role)) return null;

		return { userId: auth.userId };
	},
);

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
export const authMiddleware = createMiddleware({ type: "function" }).server(
	async ({ next }) => {
		const clerk = createClerkClient({
			secretKey: env.CLERK_SECRET_KEY,
			// Build-time inlined (Vite) — no runtime Wrangler var needed for this one.
			publishableKey: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
		});

		const requestState = await clerk.authenticateRequest(getRequest());
		if (requestState.status === "handshake") {
			forwardHandshake(requestState.headers);
			throw new Error("Unauthorized");
		}
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
