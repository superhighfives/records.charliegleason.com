import {
	RedirectToSignIn,
	SignedIn,
	SignedOut,
	UserButton,
	useUser,
} from "@clerk/clerk-react";
import { HotkeysProvider } from "@tanstack/react-hotkeys";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";

import { ThemeToggle } from "#/components/theme-toggle";
import { ADMIN_ROLE } from "#/lib/roles";

/**
 * Authenticated admin shell. Everything under /admin requires a signed-in Clerk
 * session with `publicMetadata.role === "admin"`; signed-out visitors are
 * redirected to Clerk's hosted sign-in. This client gate is UX only — the real
 * boundary is `authMiddleware` on every write server function.
 */
export const Route = createFileRoute("/admin")({ component: AdminLayout });

function AdminLayout() {
	return (
		<>
			<SignedIn>
				<AdminGate />
			</SignedIn>
			<SignedOut>
				<RedirectToSignIn />
			</SignedOut>
		</>
	);
}

function AdminGate() {
	const { isLoaded, user } = useUser();

	// Wait for the user to resolve before deciding — avoids flashing the
	// "not authorized" screen for a legitimate admin on first paint.
	if (!isLoaded) return null;

	if (user?.publicMetadata.role !== ADMIN_ROLE) {
		return (
			<div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
				<h1 className="text-2xl font-semibold">Not authorized</h1>
				<p className="max-w-sm text-muted-foreground">
					You're signed in, but this account doesn't have admin access.
				</p>
				<div className="flex items-center gap-3">
					<Link to="/" className="text-sm underline underline-offset-4">
						Back to the collection
					</Link>
					<UserButton />
				</div>
			</div>
		);
	}

	return (
		<HotkeysProvider>
			<div className="min-h-screen">
				<header className="flex items-center justify-between border-b border-border px-6 py-4">
					<nav className="flex items-center gap-2">
						<span className="size-2 rounded-full bg-brand" />
						<Link to="/" className="font-semibold tracking-tight">
							Records
						</Link>
						<span className="text-muted-foreground">/ admin</span>
					</nav>
					<div className="flex items-center gap-3">
						<ThemeToggle />
						<UserButton />
					</div>
				</header>
				<main className="p-6">
					<Outlet />
				</main>
			</div>
		</HotkeysProvider>
	);
}
