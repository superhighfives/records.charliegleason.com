import { createFileRoute } from "@tanstack/react-router";
import {
	getResponseHeaders,
	getResponseStatus,
} from "@tanstack/react-start/server";
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
					// A stale session token (crossing to a fresh preview subdomain, or
					// enough time since the last visit) makes `getAdminSession` stage a
					// 307 + Location/Set-Cookie via `forwardHandshake` rather than
					// resolving a clean signed-out verdict. This route (unlike the
					// SSR loaders `getAdminSession` is otherwise used from) returns its
					// own `Response`, so that staged handshake redirect has to be
					// carried across explicitly — otherwise it's silently dropped in
					// favour of a hard 401 the browser can never recover from.
					if (getResponseStatus() === 307) {
						return new Response(null, {
							status: 307,
							headers: getResponseHeaders() as HeadersInit,
						});
					}
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
