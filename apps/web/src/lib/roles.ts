// Pure, dependency-free role helpers shared by the client gate and the server
// middleware. Kept separate from `auth.ts` (which imports server-only Clerk +
// Cloudflare modules) so the client bundle can use it without pulling those in.

/** The single admin gate: a Clerk user with `publicMetadata.role === "admin"`. */
export const ADMIN_ROLE = "admin";

export const isAdmin = (role: string | undefined): boolean =>
	role === ADMIN_ROLE;
