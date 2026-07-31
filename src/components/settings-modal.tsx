import { Download, Settings } from "lucide-react";

import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "#/components/ui/dialog";

/**
 * Admin settings — currently just the full-collection backup download. A plain
 * `<a download>` rather than a fetch+blob click handler, so the browser streams
 * the zip straight from `/api/admin/backup` (same-origin, session cookie rides
 * along automatically) instead of buffering the whole archive in JS first.
 */
export function SettingsModal() {
	return (
		<Dialog>
			<DialogTrigger asChild>
				<button
					type="button"
					aria-label="Settings"
					title="Settings"
					className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
				>
					<Settings className="size-4" />
				</button>
			</DialogTrigger>
			<DialogContent className="max-w-sm">
				<DialogHeader>
					<DialogTitle>Settings</DialogTitle>
					<DialogDescription>
						Download a full backup of the collection — every record, color, and
						cover photo — as a single zip.
					</DialogDescription>
				</DialogHeader>
				<Button asChild>
					<a href="/api/admin/backup" download>
						<Download />
						Download backup
					</a>
				</Button>
			</DialogContent>
		</Dialog>
	);
}
