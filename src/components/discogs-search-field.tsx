import { useMutation } from "@tanstack/react-query";
import { SearchIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import type { AsinIdentity } from "#/lib/asin";
import {
	lookupMasterFromBrowser,
	lookupReleaseFromBrowser,
	searchByBarcodeFromBrowser,
	searchMastersFromBrowser,
	searchReleasesFromBrowser,
} from "#/lib/discogs-browser";
import {
	type Candidate,
	mergeReleases,
	toMaster,
	toRelease,
} from "#/lib/discogs-candidate";
import { classifyQuery, type DiscogsCandidate } from "#/lib/discogs-shared";
import {
	identifyAsin,
	lookupDiscogsMaster,
	lookupDiscogsRelease,
	searchDiscogs,
	searchDiscogsBarcode,
	searchDiscogsMasters,
} from "#/lib/records";

/**
 * The structured precision filters that sit behind the single search box —
 * available when a keyword search needs narrowing, and auto-filled when an ASIN
 * resolves. Country is release-only (masters ignore it). Strings, "" = no filter.
 */
export interface StructuredFields {
	artist: string;
	title: string;
	country: string;
	year: string;
}

const EMPTY_FIELDS: StructuredFields = {
	artist: "",
	title: "",
	country: "",
	year: "",
};

/** The result of one search run: the merged pick-list plus a human status note. */
interface SearchOutcome {
	candidates: Array<Candidate>;
	// A one-line note surfaced above the results — e.g. what an ASIN resolved to,
	// or why a barcode/URL came back empty. Null when there's nothing to say.
	notice: string | null;
	// When an ASIN resolves, the structured fields it pre-fills so the user sees
	// (and can tweak) what Amazon reported.
	fields?: StructuredFields;
	// The `key` of a release we're confident is the exact pressing — a barcode
	// match. The batch dialogs pre-select this when present, else fall back to the
	// top album (master) as a placeholder. Null/absent when nothing's certain.
	exactReleaseKey?: string | null;
}

function combine(qText: string, fields: StructuredFields) {
	return {
		artist: fields.artist,
		title: fields.title,
		country: fields.country,
		year: fields.year,
		q: qText,
	};
}

const releaseCount = (n: number) => `${n} pressing${n === 1 ? "" : "s"}`;

/**
 * Turn an ASIN identity into a pick-list: barcode-match first (the exact
 * pressing), then a filtered release + master shortlist from the same facts so
 * there's something to pick even when the barcode misses or is absent.
 */
async function candidatesFromAsin(
	identity: AsinIdentity,
): Promise<SearchOutcome> {
	const fields: StructuredFields = {
		artist: identity.artist,
		title: identity.title,
		country: identity.country ?? "",
		year: identity.year ? String(identity.year) : "",
	};

	const exact: Array<DiscogsCandidate> = identity.barcode
		? await searchDiscogsBarcode({ data: identity.barcode }).catch(() => [])
		: [];

	// Broader shortlist from the facts, always run so the barcode isn't a
	// single point of failure. Failures degrade to empty rather than erroring.
	const params = combine("", fields);
	const [masters, filtered] = await Promise.all([
		searchDiscogsMasters({ data: params }).catch(() => []),
		searchDiscogs({ data: params }).catch(() => []),
	]);
	const releases = mergeReleases(exact, filtered);

	const headline = `Identified from Amazon: ${identity.artist} — ${identity.title}${
		identity.year ? ` (${identity.year})` : ""
	}`;
	const barcodeNote = identity.barcode
		? exact.length
			? `barcode ${identity.barcode} matched ${releaseCount(exact.length)}`
			: `barcode ${identity.barcode} had no exact match`
		: "no barcode on the listing — pick the right pressing below";

	return {
		candidates: [...masters.map(toMaster), ...releases.map(toRelease)],
		notice: `${headline} · ${barcodeNote}`,
		fields,
		// A barcode hit is the exact pressing — flag the first for pre-selection.
		exactReleaseKey: exact.length ? toRelease(exact[0]).key : null,
	};
}

/**
 * Run a search against the server fns, routing on what was typed. A Discogs
 * release/master URL resolves directly; an ASIN resolves through web search then
 * barcode/keyword matches; a barcode hits the exact-pressing lookup; anything else
 * is a keyword search over masters *and* releases (merged). Structured fields
 * refine a keyword search and are ignored for URL/ASIN/barcode routes.
 */
async function executeSearch(
	input: string,
	fields: StructuredFields,
): Promise<SearchOutcome> {
	const raw = input.trim();
	const route = raw
		? classifyQuery(raw)
		: ({ kind: "text", text: "" } as const);

	switch (route.kind) {
		case "release-url": {
			const c = await lookupDiscogsRelease({ data: raw });
			return {
				candidates: c ? [toRelease(c)] : [],
				notice: c ? null : "That Discogs release URL didn't resolve.",
			};
		}
		case "master-url": {
			const c = await lookupDiscogsMaster({ data: raw });
			return {
				candidates: c ? [toMaster(c)] : [],
				notice: c ? null : "That Discogs master URL didn't resolve.",
			};
		}
		case "asin": {
			const identity = await identifyAsin({ data: route.asin });
			if (!identity) {
				return {
					candidates: [],
					notice: `Couldn't identify ${route.asin} from Amazon — try the artist and title instead.`,
				};
			}
			return candidatesFromAsin(identity);
		}
		case "barcode": {
			const releases = await searchDiscogsBarcode({ data: route.barcode });
			return {
				candidates: releases.map(toRelease),
				notice: releases.length
					? null
					: `No Discogs release matches barcode ${route.barcode}.`,
				// A direct barcode search is all exact pressings — flag the first.
				exactReleaseKey: releases.length ? toRelease(releases[0]).key : null,
			};
		}
		default: {
			const params = combine(route.text, fields);
			if (!params.artist && !params.title && !params.q) {
				return { candidates: [], notice: null };
			}
			// Both searches; keep whichever succeeds. Only a total failure throws so
			// the caller can surface the clean-IP browser fallback.
			const [m, r] = await Promise.allSettled([
				searchDiscogsMasters({ data: params }),
				searchDiscogs({ data: params }),
			]);
			if (m.status === "rejected" && r.status === "rejected") throw m.reason;
			return {
				candidates: [
					...(m.status === "fulfilled" ? m.value.map(toMaster) : []),
					...(r.status === "fulfilled" ? r.value.map(toRelease) : []),
				],
				notice: null,
			};
		}
	}
}

/**
 * Browser-side re-run for the rate-limit fallback. Covers the URL / barcode /
 * keyword routes (all unauthenticated, clean-IP). An ASIN route can't run here —
 * it needs the server's web_search — so it re-runs the whole server path instead.
 */
async function executeBrowserSearch(
	input: string,
	fields: StructuredFields,
): Promise<SearchOutcome> {
	const raw = input.trim();
	const route = raw
		? classifyQuery(raw)
		: ({ kind: "text", text: "" } as const);

	switch (route.kind) {
		case "release-url": {
			const c = await lookupReleaseFromBrowser(route.id).catch(() => null);
			return {
				candidates: c ? [toRelease(c)] : [],
				notice: c ? null : "That Discogs release URL didn't resolve.",
			};
		}
		case "master-url": {
			const c = await lookupMasterFromBrowser(route.id).catch(() => null);
			return {
				candidates: c ? [toMaster(c)] : [],
				notice: c ? null : "That Discogs master URL didn't resolve.",
			};
		}
		case "asin":
			// No clean-IP path for identify — fall back to the full server run.
			return executeSearch(input, fields);
		case "barcode": {
			const releases = await searchByBarcodeFromBrowser(route.barcode);
			return {
				candidates: releases.map(toRelease),
				notice: releases.length
					? null
					: `No Discogs release matches barcode ${route.barcode}.`,
				exactReleaseKey: releases.length ? toRelease(releases[0]).key : null,
			};
		}
		default: {
			const params = combine(route.text, fields);
			if (!params.artist && !params.title && !params.q) {
				return { candidates: [], notice: null };
			}
			const [m, r] = await Promise.allSettled([
				searchMastersFromBrowser(params),
				searchReleasesFromBrowser(params),
			]);
			if (m.status === "rejected" && r.status === "rejected") throw m.reason;
			return {
				candidates: [
					...(m.status === "fulfilled" ? m.value.map(toMaster) : []),
					...(r.status === "fulfilled" ? r.value.map(toRelease) : []),
				],
				notice: null,
			};
		}
	}
}

/** Everything a surface needs to drive the unified field and render its results. */
export interface UseDiscogsSearch {
	input: string;
	setInput: (v: string) => void;
	fields: StructuredFields;
	setFields: (f: StructuredFields) => void;
	/** Run the search for the current input/fields. */
	run: () => void;
	/** Re-run the last search from the browser's clean IP (rate-limit fallback). */
	runBrowserFallback: () => void;
	/** Clear input, fields and results back to the initial state. */
	reset: () => void;
	results: Array<Candidate> | null;
	notice: string | null;
	pending: boolean;
	browserPending: boolean;
	error: Error | null;
}

/**
 * The shared search engine behind the unified field — owns the input + structured
 * fields, routes/executes the search (see {@link executeSearch}), and exposes the
 * merged candidates for the surface to render however it likes (a dropdown in the
 * bulk dialog, a list in the editor). Pre-fills the structured fields when an ASIN
 * resolves. `onResults` fires after every successful run so a surface can react
 * (e.g. clear its current selection).
 */
export function useDiscogsSearch(opts?: {
	initialInput?: string;
	initialFields?: Partial<StructuredFields>;
	// Fires after a successful search with the merged candidates and the key to
	// pre-select by the "prefer an exact release, else the top album placeholder"
	// rule (null when there's nothing to pick). The batch dialogs use `preferredKey`.
	onResults?: (
		candidates: Array<Candidate>,
		preferredKey: string | null,
	) => void;
	// Fires after any run (server or browser) settles, success or error — the
	// bulk dialog uses it to advance its one-at-a-time auto-search queue.
	onSettled?: () => void;
}): UseDiscogsSearch {
	const [input, setInput] = useState(opts?.initialInput ?? "");
	const [fields, setFields] = useState<StructuredFields>({
		...EMPTY_FIELDS,
		...opts?.initialFields,
	});
	const [results, setResults] = useState<Array<Candidate> | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const onOutcome = (outcome: SearchOutcome) => {
		setResults(outcome.candidates);
		setNotice(outcome.notice);
		if (outcome.fields) setFields(outcome.fields);
		// Prefer an exact (barcode-matched) release, else the top album (master) as a
		// placeholder, else the first release. The batch dialogs pre-select this.
		const preferredKey =
			outcome.exactReleaseKey ??
			outcome.candidates.find((c) => c.kind === "master")?.key ??
			outcome.candidates.find((c) => c.kind === "release")?.key ??
			null;
		opts?.onResults?.(outcome.candidates, preferredKey);
	};

	const search = useMutation({
		mutationFn: () => executeSearch(input, fields),
		onSuccess: onOutcome,
		onSettled: opts?.onSettled,
	});
	const browserSearch = useMutation({
		mutationFn: () => executeBrowserSearch(input, fields),
		onSuccess: onOutcome,
		onSettled: opts?.onSettled,
	});

	return {
		input,
		setInput,
		fields,
		setFields,
		run: () => {
			setResults(null);
			setNotice(null);
			search.mutate();
		},
		runBrowserFallback: () => browserSearch.mutate(),
		reset: () => {
			setInput("");
			setFields({ ...EMPTY_FIELDS });
			setResults(null);
			setNotice(null);
			search.reset();
			browserSearch.reset();
		},
		results,
		notice,
		pending: search.isPending,
		browserPending: browserSearch.isPending,
		// Once a browser retry has been attempted, its outcome (success or error)
		// replaces the original server error — otherwise a failed retry leaves the
		// user staring at the stale server-side message with no feedback that the
		// retry itself also failed.
		error:
			browserSearch.status !== "idle"
				? browserSearch.isError
					? (browserSearch.error as Error)
					: null
				: search.isError
					? (search.error as Error)
					: null,
	};
}

/** A short label for what the field detected, so the routing isn't a mystery. */
function detectionHint(input: string): string | null {
	const raw = input.trim();
	if (!raw) return null;
	switch (classifyQuery(raw).kind) {
		case "release-url":
			return "Discogs release link";
		case "master-url":
			return "Discogs album link";
		case "asin":
			return "Amazon ASIN — will look up the release";
		case "barcode":
			return "Barcode — exact pressing lookup";
		default:
			return null;
	}
}

/**
 * The unified search box: one field that accepts a Discogs URL, an Amazon ASIN, a
 * barcode, or keywords, with the structured artist/title/country/year filters
 * tucked behind a disclosure for when a keyword search needs narrowing. Driven by
 * a {@link useDiscogsSearch} instance; the surface renders `search.results` itself.
 */
export function DiscogsSearchInput({
	search,
	placeholder = "Artist and title, Discogs link, barcode, or Amazon ASIN",
	autoFocus,
	idPrefix = "discogs-search",
}: {
	search: UseDiscogsSearch;
	placeholder?: string;
	autoFocus?: boolean;
	idPrefix?: string;
}) {
	const [showAdvanced, setShowAdvanced] = useState(false);
	const hint = detectionHint(search.input);
	const busy = search.pending || search.browserPending;

	const setField = (patch: Partial<StructuredFields>) =>
		search.setFields({ ...search.fields, ...patch });

	return (
		<form
			className="space-y-2"
			onSubmit={(e) => {
				e.preventDefault();
				if (!busy) search.run();
			}}
		>
			<div className="flex items-end gap-2">
				<div className="flex-1 space-y-1">
					<Input
						autoFocus={autoFocus}
						value={search.input}
						placeholder={placeholder}
						onChange={(e) => search.setInput(e.target.value)}
					/>
					{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
				</div>
				<Button type="submit" disabled={busy} className="shrink-0">
					<SearchIcon className="size-4" />
					{search.pending ? "Searching…" : "Search"}
				</Button>
			</div>

			{/* Structured filters — rarely needed with the single box, so disclosed. */}
			<button
				type="button"
				aria-expanded={showAdvanced}
				onClick={() => setShowAdvanced((v) => !v)}
				className="text-xs text-muted-foreground underline underline-offset-4"
			>
				{showAdvanced ? "Hide advanced options" : "Advanced options"}
			</button>

			{showAdvanced && (
				<div className="space-y-2">
					<div className="flex items-end gap-2">
						<div className="flex-1 space-y-1">
							<label
								htmlFor={`${idPrefix}-artist`}
								className="text-xs text-muted-foreground"
							>
								Artist
							</label>
							<Input
								id={`${idPrefix}-artist`}
								value={search.fields.artist}
								onChange={(e) => setField({ artist: e.target.value })}
							/>
						</div>
						<div className="flex-1 space-y-1">
							<label
								htmlFor={`${idPrefix}-title`}
								className="text-xs text-muted-foreground"
							>
								Title
							</label>
							<Input
								id={`${idPrefix}-title`}
								value={search.fields.title}
								onChange={(e) => setField({ title: e.target.value })}
							/>
						</div>
					</div>
					<div className="flex items-end gap-2">
						<div className="flex-1 space-y-1">
							<label
								htmlFor={`${idPrefix}-country`}
								className="text-xs text-muted-foreground"
							>
								Country
							</label>
							<Input
								id={`${idPrefix}-country`}
								value={search.fields.country}
								placeholder="e.g. UK"
								onChange={(e) => setField({ country: e.target.value })}
							/>
						</div>
						<div className="flex-1 space-y-1">
							<label
								htmlFor={`${idPrefix}-year`}
								className="text-xs text-muted-foreground"
							>
								Year
							</label>
							<Input
								id={`${idPrefix}-year`}
								inputMode="numeric"
								value={search.fields.year}
								placeholder="e.g. 1971"
								onChange={(e) => setField({ year: e.target.value })}
							/>
						</div>
					</div>
				</div>
			)}

			{search.notice && (
				<p className="text-xs text-muted-foreground">{search.notice}</p>
			)}

			{search.error && (
				<div className="flex flex-wrap items-center gap-2" role="alert">
					<p className="text-xs text-red-600">{search.error.message}</p>
					<Button
						type="button"
						variant="outline"
						size="xs"
						disabled={search.browserPending}
						onClick={() => search.runBrowserFallback()}
					>
						{search.browserPending ? "Searching…" : "Search from browser"}
					</Button>
				</div>
			)}
		</form>
	);
}
