import { Moon, Sun } from "lucide-react";

/**
 * Light/dark toggle. Flips the `.dark` class on <html> and persists the choice
 * to localStorage; the no-flash bootstrap in `__root.tsx` reads it back on load.
 * The icon swap is pure CSS (`dark:` variants) so it's correct on first paint.
 */
export function ThemeToggle({ className }: { className?: string }) {
	const toggle = () => {
		const next = !document.documentElement.classList.contains("dark");
		document.documentElement.classList.toggle("dark", next);
		try {
			localStorage.setItem("theme", next ? "dark" : "light");
		} catch {
			// ignore — private mode / storage disabled
		}
	};

	return (
		<button
			type="button"
			onClick={toggle}
			aria-label="Toggle dark mode"
			title="Toggle dark mode"
			className={`inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-accent hover:text-foreground ${
				className ?? ""
			}`}
		>
			<Sun className="size-4 dark:hidden" />
			<Moon className="hidden size-4 dark:block" />
		</button>
	);
}
