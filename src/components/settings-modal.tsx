import { Download, Settings, ShoppingBag } from "lucide-react";
import { useState } from "react";

import { AmazonImportDialog } from "#/components/amazon-import-dialog";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";

/**
 * Admin settings: a full-collection backup download, and the Amazon order-history
 * importer (match unmatched records to Discogs from what you bought). The backup
 * link is a plain `<a download>` so the browser streams the zip straight from
 * `/api/admin/backup` (same-origin, session cookie rides along) rather than
 * buffering the whole archive in JS. Controlled so "Import from Amazon" can hand
 * off from the settings dialog to the importer.
 */
export function SettingsModal() {
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [importOpen, setImportOpen] = useState(false);

	return (
		<>
			<Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
				<button
					type="button"
					aria-label="Settings"
					title="Settings"
					onClick={() => setSettingsOpen(true)}
					className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
				>
					<Settings className="size-4" />
				</button>
				<DialogContent className="max-w-sm">
					<DialogHeader>
						<DialogTitle>Settings</DialogTitle>
						<DialogDescription>
							Manage the collection — back it up, or import from Amazon.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-2">
						<Button
							type="button"
							variant="outline"
							className="w-full"
							onClick={() => {
								setSettingsOpen(false);
								setImportOpen(true);
							}}
						>
							<ShoppingBag />
							Import from Amazon
						</Button>
						<Button asChild className="w-full">
							<a href="/api/admin/backup" download>
								<Download />
								Download backup
							</a>
						</Button>
					</div>
				</DialogContent>
			</Dialog>

			<AmazonImportDialog open={importOpen} onOpenChange={setImportOpen} />
		</>
	);
}
