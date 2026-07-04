import { useEffect, useState } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * App toaster. The theme is class-based on <html> (see `theme-toggle.tsx`) with
 * no React context, so we mirror the `.dark` class into sonner's `theme` prop
 * and keep it in sync when the toggle flips it.
 */
export function Toaster(props: ToasterProps) {
	const [theme, setTheme] = useState<"light" | "dark">("light");

	useEffect(() => {
		const root = document.documentElement;
		const sync = () =>
			setTheme(root.classList.contains("dark") ? "dark" : "light");
		sync();
		const observer = new MutationObserver(sync);
		observer.observe(root, { attributes: true, attributeFilter: ["class"] });
		return () => observer.disconnect();
	}, []);

	return <Sonner theme={theme} richColors position="top-center" {...props} />;
}
