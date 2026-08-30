import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";

import { listPublicRecords } from "#/lib/records";

/**
 * A minimal, low-bandwidth cut of the public collection for the `rec` ESP32
 * board: just id/artist/title/coverKey, instead of every Discogs/pipeline
 * field on the full `/api/records` payload. Same public query, same source
 * of truth — this only trims what goes over the wire. A weak WiFi signal
 * makes the full ~1.2MB response unreliable to pull down; this cuts it by
 * roughly an order of magnitude.
 */
export const Route = createFileRoute("/api/records/lite")({
	server: {
		handlers: {
			GET: async () => {
				const publicRows = await listPublicRecords();
				const records = publicRows
					.map((record) => ({
						id: record.id,
						artist: record.artist,
						title: record.title,
						coverKey: record.professionalImageKey ?? record.coverImageKey,
					}))
					.filter((record) => record.coverKey != null);

				return json(
					{ records, count: records.length },
					{ headers: { "access-control-allow-origin": "*" } },
				);
			},
		},
	},
});
