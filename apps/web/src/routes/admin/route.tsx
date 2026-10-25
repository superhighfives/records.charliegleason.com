import {
	RedirectToSignIn,
	SignedIn,
	SignedOut,
	UserButton,
	useUser,
} from "@clerk/clerk-react";
import { HotkeysProvider } from "@tanstack/react-hotkeys";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";

import { QueueMenu } from "#/components/queue-menu";
import { ThemeToggle } from "#/components/theme-toggle";
import { isAdmin } from "#/lib/roles";

/**
 * Authenticated admin shell. Everything under /admin requires a signed-in Clerk
 * session with `publicMetadata.role === "admin"`; signed-out visitors are
 * redirected to Clerk's hosted sign-in. This client gate is UX only — the real
 * boundary is `authMiddleware` on every write server function.
 *
 * No `errorComponent` here: TanStack Router resolves it from the route that
 * actually threw (e.g. `/admin/` for `listRecords`), never an ancestor — see
 * `router.tsx`'s `defaultErrorComponent`, which every route falls back to and
 * is where `AdminSessionError` actually gets caught.
 */
export const Route = createFileRoute("/admin")({ component: AdminLayout });

/** The admin's pages, linked from the header. */
const ADMIN_PAGES = [
	{ to: "/admin", label: "List" },
	{ to: "/admin/colors", label: "Colors" },
	{ to: "/admin/filters", label: "Filters" },
	{ to: "/admin/review", label: "Review" },
	{ to: "/admin/settings", label: "Settings" },
] as const;

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

	if (!isAdmin(user?.publicMetadata.role)) {
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
			<div className="flex min-h-dvh flex-col">
				<header className="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
					<nav className="flex items-center gap-2">
						<span className="size-2 rounded-full bg-brand" />
						<Link to="/" className="font-semibold tracking-tight">
							Records
						</Link>
						<Link to="/admin" className="text-muted-foreground">
							/ admin
						</Link>
					</nav>
					<nav
						aria-label="Admin pages"
						className="-my-2 flex min-w-0 items-center gap-1 overflow-x-auto"
					>
						{ADMIN_PAGES.map((page) => (
							<Link
								key={page.to}
								to={page.to}
								// `/admin` is every page's parent, so List only lights up on itself.
								activeOptions={{ exact: page.to === "/admin" }}
								className="rounded-md px-3 py-1.5 text-sm whitespace-nowrap text-muted-foreground hover:bg-accent hover:text-foreground"
								activeProps={{
									className: "bg-accent text-foreground",
									"aria-current": "page",
								}}
							>
								{page.label}
							</Link>
						))}
					</nav>
					<div className="flex items-center gap-3">
						<QueueMenu />
						<ThemeToggle />
						<UserButton />
					</div>
				</header>
				<main className="flex min-h-0 flex-1 flex-col p-6">
					<Outlet />
				</main>
			</div>
		</HotkeysProvider>
	);
}
