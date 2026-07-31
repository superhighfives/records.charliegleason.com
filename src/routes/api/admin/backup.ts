import { createFileRoute } from "@tanstack/react-router";
import { getAdminSession } from "#/lib/auth";
import { createBackupZipStream } from "#/lib/backup";

/**
 * Download a full backup of the collection — D1 tables + every R2 photo — as a
 * single zip. Admin-only: gated the same way the SSR loaders check (see
 * `getAdminSession`), since this is a plain GET triggered from a browser link
 * rather than a `createServerFn` call.
 */
export const Route = createFileRoute("/api/admin/backup")({
	server: {
		handlers: {
			GET: async () => {
				if (!(await getAdminSession())) {
					return new Response("Unauthorized", { status: 401 });
				}

				const date = new Date().toISOString().slice(0, 10);
				return new Response(createBackupZipStream(), {
					headers: {
						"content-type": "application/zip",
						"content-disposition": `attachment; filename="records-backup-${date}.zip"`,
					},
				});
			},
		},
	},
});
