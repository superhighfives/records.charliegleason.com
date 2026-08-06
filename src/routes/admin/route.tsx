import {
	RedirectToSignIn,
	SignedIn,
	SignedOut,
	UserButton,
	useUser,
} from "@clerk/clerk-react";
import { HotkeysProvider } from "@tanstack/react-hotkeys";
import {
	createFileRoute,
	ErrorComponent,
	Link,
	Outlet,
} from "@tanstack/react-router";

import { QueueMenu } from "#/components/queue-menu";
import { SettingsModal } from "#/components/settings-modal";
import { ThemeToggle } from "#/components/theme-toggle";
import { AdminSessionError } from "#/lib/auth";
import { isAdmin } from "#/lib/roles";

/**
 * Authenticated admin shell. Everything under /admin requires a signed-in Clerk
 * session with `publicMetadata.role === "admin"`; signed-out visitors are
 * redirected to Clerk's hosted sign-in. This client gate is UX only — the real
 * boundary is `authMiddleware` on every write server function.
 */
export const Route = createFileRoute("/admin")({
	component: AdminLayout,
	// Catches `AdminSessionError` thrown by `listRecords`/`getRecord` when the
	// client's Clerk user object (checked by `AdminGate` below) and the server's
	// verified session JWT disagree on admin status — the client SDK can read as
	// admin while a stale/unrefreshed session cookie still doesn't. Without this,
	// that mismatch rendered as an unremarkable empty collection or a "Record not
	// found", with nothing to tell an admin their session — not their data — was
	// the problem.
	errorComponent: (props) => {
		if (!(props.error instanceof AdminSessionError))
			return <ErrorComponent {...props} />;
		const { error, reset } = props;
		return (
			<div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
				<h1 className="text-2xl font-semibold">Session out of sync</h1>
				<p className="max-w-sm text-muted-foreground">
					{error.message} Your account looks right, but the server couldn't
					confirm it.
				</p>
				<button
					type="button"
					onClick={() => {
						reset();
						window.location.reload();
					}}
					className="text-sm underline underline-offset-4"
				>
					Reload
				</button>
			</div>
		);
	},
});

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
				<header className="flex items-center justify-between border-b border-border px-6 py-4">
					<nav className="flex items-center gap-2">
						<span className="size-2 rounded-full bg-brand" />
						<Link to="/" className="font-semibold tracking-tight">
							Records
						</Link>
						<Link to="/admin" className="text-muted-foreground">
							/ admin
						</Link>
					</nav>
					<div className="flex items-center gap-3">
						<QueueMenu />
						<SettingsModal />
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
