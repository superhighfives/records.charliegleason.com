#!/usr/bin/env node
// Backfill album-level metadata (artist/title/year/genre) onto records whose
// master was linked before assign synced those fields.
//
// Why: `assignRecordMaster` (the bulk "Assign masters" flow) used to write only
// `master_id`/`master_url`, leaving each row's artist/title/year/genre as whatever
// capture/analysis guessed. The editor's album label reads those record fields, so
// a correctly-linked record could still read as a mismatched album. Assign now
// syncs them going forward; this one-off re-syncs the rows linked before that fix.
//
// This script only READS the DB (via wrangler) and Discogs — it never writes.
// It emits a reviewable SQL file of UPDATEs you apply yourself:
//
//   Usage:
//     DISCOGS_TOKEN=... node scripts/backfill-master-metadata.mjs [--local] [id ...]
//
//   Then review and apply:
//     wrangler d1 execute records --remote --file=scripts/backfill-master-metadata.sql
//
//   Flags:
//     --local      read from (and target) the local D1 instead of --remote
//     id ...       limit to specific record ids (handy for a dry run on one row)
//
// The token is read from DISCOGS_TOKEN; `bun run dev` loads it from .env.local, but
// this is a plain node script, so pass it explicitly (or `dotenv -e .env.local --`).

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const token = process.env.DISCOGS_TOKEN;
if (!token) {
	console.error(
		"Set DISCOGS_TOKEN (e.g. `dotenv -e .env.local -- node scripts/backfill-master-metadata.mjs`).",
	);
	process.exit(1);
}

const args = process.argv.slice(2);
const local = args.includes("--local");
const onlyIds = args
	.filter((a) => /^\d+$/.test(a))
	.map((a) => Number.parseInt(a, 10));

const SQL_OUT = join(
	dirname(fileURLToPath(import.meta.url)),
	"backfill-master-metadata.sql",
);

// Discogs' master `artist` is the first credited artist with its " (2)" style
// disambiguator stripped — matches cleanArtistName in src/lib/discogs-shared.ts.
function cleanArtistName(name) {
	return name.replace(/\s*\(\d+\)\s*$/, "").trim();
}

// Shape a raw /masters/{id} payload the same way mapMasterDetail does, for the
// four fields we sync. Returns null when the master couldn't be resolved.
function masterFields(d) {
	if (!d || d.id == null) return null;
	const yearNum = d.year ? Number.parseInt(String(d.year), 10) : null;
	return {
		artist:
			Array.isArray(d.artists) && d.artists[0]?.name
				? cleanArtistName(String(d.artists[0].name))
				: null,
		title: d.title ? String(d.title) : null,
		year: Number.isFinite(yearNum) ? yearNum : null,
		genre: Array.isArray(d.genres) && d.genres[0] ? String(d.genres[0]) : null,
	};
}

function sqlLiteral(value) {
	if (value == null) return "NULL";
	if (typeof value === "number") return String(value);
	return `'${String(value).replace(/'/g, "''")}'`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// wrangler isn't a standalone binary in this repo — it's run via bun. Override with
// WRANGLER=... (e.g. "npx wrangler") if your setup differs.
const WRANGLER = (process.env.WRANGLER ?? "bunx wrangler").split(" ");

// Read the candidate rows through wrangler so we use the same auth/config as the app.
function readRows() {
	const query =
		"SELECT id, artist, title, year, genre, master_id FROM records WHERE master_id IS NOT NULL ORDER BY id";
	const out = execFileSync(
		WRANGLER[0],
		[
			...WRANGLER.slice(1),
			"d1",
			"execute",
			"records",
			local ? "--local" : "--remote",
			"--json",
			"--command",
			query,
		],
		{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
	// wrangler --json prints an array of result sets: [{ results: [...] }]
	const parsed = JSON.parse(out);
	const results = Array.isArray(parsed) ? parsed[0]?.results : parsed?.results;
	return results ?? [];
}

// Fetch a master, retrying once on a 429 (Discogs is 60 req/min authenticated).
async function fetchMaster(id) {
	for (let attempt = 0; attempt < 2; attempt++) {
		const res = await fetch(`https://api.discogs.com/masters/${id}`, {
			headers: {
				Authorization: `Discogs token=${token}`,
				"User-Agent": "records-backfill/1.0",
			},
		});
		if (res.status === 429) {
			await sleep(5000);
			continue;
		}
		if (!res.ok) return null;
		return res.json();
	}
	return null;
}

const rows = readRows().filter(
	(r) => onlyIds.length === 0 || onlyIds.includes(Number(r.id)),
);
console.error(`Found ${rows.length} record(s) with a linked master.`);

const updates = [];
let unchanged = 0;
let failed = 0;

for (const [i, r] of rows.entries()) {
	const detail = await fetchMaster(r.master_id);
	const next = masterFields(detail);
	if (!next) {
		failed++;
		console.error(`  ! ${r.id}: couldn't fetch master ${r.master_id}`);
		await sleep(1100);
		continue;
	}

	// Only touch fields the master actually carries (artist/title are notNull), and
	// only emit a row when something differs — keeps the SQL small and reviewable.
	const set = {};
	if (next.artist && next.artist !== r.artist) set.artist = next.artist;
	if (next.title && next.title !== r.title) set.title = next.title;
	if (next.year !== (r.year ?? null)) set.year = next.year;
	if ((next.genre ?? null) !== (r.genre ?? null)) set.genre = next.genre;

	if (Object.keys(set).length === 0) {
		unchanged++;
	} else {
		// Column names match the keys (artist/title/year/genre are all single words).
		const assignments = Object.entries(set)
			.map(([k, v]) => `${k} = ${sqlLiteral(v)}`)
			.join(", ");
		updates.push(
			`UPDATE records SET ${assignments}, updated_at = (unixepoch()) WHERE id = ${Number(r.id)};`,
		);
		console.error(
			`  ~ ${r.id}: ${Object.entries(set)
				.map(([k, v]) => `${k}: ${JSON.stringify(r[k] ?? null)} -> ${JSON.stringify(v)}`)
				.join(", ")}`,
		);
	}

	// Stay under Discogs' 60/min: ~1.1s spacing. Progress ping every 25 rows.
	if ((i + 1) % 25 === 0) console.error(`  …${i + 1}/${rows.length}`);
	await sleep(1100);
}

const header = [
	"-- Backfill album metadata onto records linked before assign synced it.",
	"-- Generated by scripts/backfill-master-metadata.mjs — review before applying.",
	`-- ${updates.length} record(s) change; ${unchanged} already in sync; ${failed} unresolved.`,
	"--",
	"--   wrangler d1 execute records --remote --file=scripts/backfill-master-metadata.sql",
	"",
].join("\n");

writeFileSync(
	SQL_OUT,
	updates.length ? `${header}${updates.join("\n")}\n` : `${header}-- Nothing to update.\n`,
);

console.error(
	`\nDone. ${updates.length} update(s), ${unchanged} unchanged, ${failed} failed.`,
);
console.error(`Wrote ${SQL_OUT}`);
