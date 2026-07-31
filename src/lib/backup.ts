import { env } from "cloudflare:workers";
import { Zip, ZipPassThrough } from "fflate";

import { getDb } from "#/db";
import { colors, records } from "#/db/schema";

/**
 * A full snapshot of the collection as a streamed zip: the D1 tables as JSON
 * plus every object in the `PHOTOS` R2 bucket. Not a restore tool — just a
 * point-in-time backup the admin can pull down and keep offline.
 *
 * Built on fflate's streaming `Zip`/`ZipPassThrough` rather than buffering the
 * whole archive in memory: each R2 object is fetched and pushed as its own
 * entry, and the zip's compressed-chunk callback enqueues straight into the
 * response stream. Photos are stored rather than deflated — they're already
 * JPEG/PNG, so re-compressing would just burn CPU for no size win.
 */
export function createBackupZipStream(): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const zip = new Zip((err, chunk, final) => {
				if (err) {
					controller.error(err);
					return;
				}
				if (chunk) controller.enqueue(chunk);
				if (final) controller.close();
			});

			try {
				const db = getDb(env.DB);
				const [recordRows, colorRows] = await Promise.all([
					db.select().from(records),
					db.select().from(colors),
				]);

				const pushJson = (name: string, data: unknown) => {
					const file = new ZipPassThrough(name);
					zip.add(file);
					file.push(
						new TextEncoder().encode(JSON.stringify(data, null, 2)),
						true,
					);
				};
				pushJson("db/records.json", recordRows);
				pushJson("db/colors.json", colorRows);

				let cursor: string | undefined;
				do {
					const listing = await env.PHOTOS.list({ cursor, limit: 500 });
					for (const object of listing.objects) {
						const got = await env.PHOTOS.get(object.key);
						if (!got) continue;
						const file = new ZipPassThrough(`photos/${object.key}`);
						zip.add(file);
						file.push(new Uint8Array(await got.arrayBuffer()), true);
					}
					cursor = listing.truncated ? listing.cursor : undefined;
				} while (cursor);

				zip.end();
			} catch (err) {
				controller.error(err);
			}
		},
	});
}
