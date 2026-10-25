import { createFileRoute } from "@tanstack/react-router";
import { Download, ShoppingBag } from "lucide-react";
import { useState } from "react";

import { AmazonImportDialog } from "#/components/amazon-import-dialog";
import { Button } from "#/components/ui/button";

export const Route = createFileRoute("/admin/settings")({
	component: SettingsPage,
});

/**
 * Collection-wide tools: the Amazon order-history importer (match unmatched
 * records to Discogs from what you bought) and a full-collection backup. The
 * backup link is a plain `<a download>` so the browser streams the zip straight
 * from `/api/admin/backup` (same-origin, session cookie rides along) rather
 * than buffering the whole archive in JS.
 */
function SettingsPage() {
	const [importOpen, setImportOpen] = useState(false);

	return (
		<div className="mx-auto w-full max-w-2xl space-y-4">
			<header className="space-y-1">
				<h1 className="text-lg font-semibold">Settings</h1>
				<p className="text-sm text-muted-foreground">
					Import from Amazon, or back up the whole collection.
				</p>
			</header>

			<section className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-border p-4">
				<div className="min-w-0 space-y-1">
					<h2 className="font-medium">Import from Amazon</h2>
					<p className="text-sm text-muted-foreground">
						Match unmatched records to Discogs using your Amazon order history.
					</p>
				</div>
				<Button
					type="button"
					variant="outline"
					onClick={() => setImportOpen(true)}
				>
					<ShoppingBag />
					Import from Amazon
				</Button>
			</section>

			<section className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-border p-4">
				<div className="min-w-0 space-y-1">
					<h2 className="font-medium">Backup</h2>
					<p className="text-sm text-muted-foreground">
						Download every record and photo as a zip.
					</p>
				</div>
				<Button asChild>
					<a href="/api/admin/backup" download>
						<Download />
						Download backup
					</a>
				</Button>
			</section>

			<AmazonImportDialog open={importOpen} onOpenChange={setImportOpen} />
		</div>
	);
}
