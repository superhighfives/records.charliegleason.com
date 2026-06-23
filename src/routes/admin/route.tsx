import {
	RedirectToSignIn,
	SignedIn,
	SignedOut,
	UserButton,
} from "@clerk/clerk-react";
import { HotkeysProvider } from "@tanstack/react-hotkeys";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";

/**
 * Authenticated admin shell. Everything under /admin requires a signed-in Clerk
 * session; signed-out visitors are redirected to Clerk's hosted sign-in.
 */
export const Route = createFileRoute("/admin")({ component: AdminLayout });

function AdminLayout() {
	return (
		<>
			<SignedIn>
				<HotkeysProvider>
					<div className="min-h-screen">
						<header className="flex items-center justify-between border-b px-6 py-4">
							<nav className="flex items-center gap-4">
								<Link to="/admin" className="font-semibold">
									Records admin
								</Link>
							</nav>
							<UserButton />
						</header>
						<main className="p-6">
							<Outlet />
						</main>
					</div>
				</HotkeysProvider>
			</SignedIn>
			<SignedOut>
				<RedirectToSignIn />
			</SignedOut>
		</>
	);
}
