import { env } from "cloudflare:workers";
import { createClerkClient } from "@clerk/backend";
import { createMiddleware } from "@tanstack/react-start";
import { getRequest, setResponseStatus } from "@tanstack/react-start/server";

/**
 * Server-fn middleware that enforces a signed-in Clerk session.
 *
 * The client `<SignedIn>` gate in /admin is UX only — this is the real security
 * boundary. Attach to any write server function so it can't be called by an
 * unauthenticated request even if the client guard is bypassed.
 */
export const authMiddleware = createMiddleware({ type: "function" }).server(
	async ({ next }) => {
		const clerk = createClerkClient({
			secretKey: env.CLERK_SECRET_KEY,
			publishableKey: env.VITE_CLERK_PUBLISHABLE_KEY,
		});

		const requestState = await clerk.authenticateRequest(getRequest());
		const auth = requestState.toAuth();

		if (!auth?.userId) {
			setResponseStatus(401);
			throw new Error("Unauthorized");
		}

		return next({ context: { userId: auth.userId } });
	},
);
