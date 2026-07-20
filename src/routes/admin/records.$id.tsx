import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
	ChevronLeft,
	ChevronRight,
	ExternalLink,
	Info,
	Loader2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { CornerEditor } from "#/components/corner-editor";
import { DuplicateBadge } from "#/components/duplicate-badge";
import { ProPreview } from "#/components/pro-preview";
import { RecordForm } from "#/components/record-form";
import { StatusBadge } from "#/components/status-badge";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { ImageZoom } from "#/components/ui/image-zoom";
import { Input } from "#/components/ui/input";
import { Slider } from "#/components/ui/slider";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "#/components/ui/tooltip";
import { UnmatchedBadge } from "#/components/unmatched-badge";
import type { Record } from "#/db/schema";
import { describeAnalysisError } from "#/lib/analysis-error";
import { displayCoverKey, displayMatteKey } from "#/lib/cover";
import { searchMastersFromBrowser } from "#/lib/discogs-browser";
import type {
	DiscogsCandidate,
	DiscogsMasterCandidate,
	DiscogsValue,
	SearchParams,
} from "#/lib/discogs";
import { orderRecordsForReview } from "#/lib/record-order";
import type { RecordFormValues } from "#/lib/record-schema";
import {
	clearProfessional,
	deleteRecord,
	detectCorners,
	fetchRecordValue,
	getDiscogsMasterVersions,
	getDiscogsRelease,
	lookupDiscogsMaster,
	lookupDiscogsRelease,
	previewReleaseValue,
	publishRecord,
	reframeRecord,
	replaceCapture,
	reprocessRecord,
	searchDiscogs,
	searchDiscogsMasters,
} from "#/lib/records";
import { recordQueryOptions, recordsQueryOptions } from "#/lib/records-queries";
import {
	DEFAULT_REFRAME_PARAMS,
	parseReframeParams,
	type ReframeParams,
} from "#/lib/reframe-params";
import {
	type CornerBand,
	isBandValid,
	parseCornerBand,
	serializeCornerBand,
} from "#/lib/sleeve-corners";
import { cn } from "#/lib/utils";
import { effectiveValue, formatMoney } from "#/lib/value";

/** Does the pasted text look like it contains a Discogs release id? */
function looksLikeReleaseId(input: string): boolean {
	const s = input.trim();
	return /^\d+$/.test(s) || /\/releases?\/\d+/.test(s);
}

/** Does the pasted text look like it contains a Discogs master id? */
function looksLikeMasterId(input: string): boolean {
	const s = input.trim();
	return /^\d+$/.test(s) || /\/masters?\/\d+/.test(s);
}

/** Read a file to a data URL — used to ship a replacement capture to the server. */
function readFileAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

function TabButton({
	active,
	onClick,
	children,
}: {
	active: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			role="tab"
			aria-selected={active}
			onClick={onClick}
			className={cn(
				"-mb-px border-b-2 px-3 py-1.5 text-sm",
				active
					? "border-foreground font-medium text-foreground"
					: "border-transparent text-muted-foreground hover:text-foreground",
			)}
		>
			{children}
		</button>
	);
}

/** One labelled reframe knob: a slider with its current value shown on the right. */
function Knob({
	label,
	value,
	display,
	min,
	max,
	step,
	disabled,
	onChange,
}: {
	label: string;
	value: number;
	display: string;
	min: number;
	max: number;
	step: number;
	disabled?: boolean;
	onChange: (v: number) => void;
}) {
	return (
		<div className={cn("space-y-1.5", disabled && "opacity-50")}>
			<div className="flex justify-between text-xs text-muted-foreground">
				<span>{label}</span>
				<span className="tabular-nums">{display}</span>
			</div>
			<Slider
				min={min}
				max={max}
				step={step}
				value={[value]}
				disabled={disabled}
				onValueChange={([v]) => onChange(v)}
			/>
		</div>
	);
}

/** Back/next paging control: two arrow buttons around an "index / total" counter. */
function RecordPager({
	index,
	total,
	hasPrev,
	hasNext,
	onPrev,
	onNext,
	className,
}: {
	index: number;
	total: number;
	hasPrev: boolean;
	hasNext: boolean;
	onPrev: () => void;
	onNext: () => void;
	className?: string;
}) {
	// Nothing to page through — a lone record, or the list hasn't loaded yet.
	if (total <= 1 || index < 0) return null;
	return (
		<div className={cn("flex shrink-0 items-center gap-2", className)}>
			<Button
				type="button"
				variant="outline"
				size="icon-sm"
				disabled={!hasPrev}
				onClick={onPrev}
				aria-label="Previous record"
				title="Previous record (←)"
			>
				<ChevronLeft />
			</Button>
			<span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
				{index + 1} / {total}
			</span>
			<Button
				type="button"
				variant="outline"
				size="icon-sm"
				disabled={!hasNext}
				onClick={onNext}
				aria-label="Next record"
				title="Next record (→)"
			>
				<ChevronRight />
			</Button>
		</div>
	);
}

export const Route = createFileRoute("/admin/records/$id")({
	// `edit` carries the editor-open state across back/next paging, so stepping to
	// the next record lands straight back in the crop/tone editor — the whole point
	// of the pager is to blitz through setting mattes without re-opening it each time.
	validateSearch: (
		search: globalThis.Record<string, unknown>,
	): { edit?: boolean } =>
		search.edit === true || search.edit === "true" ? { edit: true } : {},
	loader: ({ context, params }) =>
		Promise.all([
			context.queryClient.ensureQueryData(
				recordQueryOptions(Number(params.id)),
			),
			// The pager pages through the whole collection, so make sure the list is
			// warm — otherwise the first back/next after a deep-link would no-op.
			context.queryClient.ensureQueryData(recordsQueryOptions),
		]),
	// The background detail page stays keyed by id so paging to another record
	// remounts it: every working-copy `useState` (Discogs picks, search, which tab)
	// re-seeds from the record it lands on rather than carrying the previous one's.
	// The crop/tone editor, though, is lifted into a persistent host (deliberately
	// NOT keyed) so its Dialog doesn't remount — and therefore doesn't replay its
	// open/scale animation — as you page left/right between records.
	component: function RecordDetailRoute() {
		const { id } = Route.useParams();
		return (
			<>
				<RecordEditorHost />
				<RecordDetail key={id} />
			</>
		);
	},
});

function parseCandidates(json: string | null): Array<DiscogsCandidate> {
	if (!json) return [];
	try {
		return JSON.parse(json) as Array<DiscogsCandidate>;
	} catch {
		return [];
	}
}

/**
 * Build form defaults from the record, overlaying a freshly picked Discogs
 * release (most specific — it carries pressing fields) or, failing that, a picked
 * master (album-level fields only). A release pick wins over a master pick.
 */
function toForm(
	record: Record,
	picked: DiscogsCandidate | null,
	pickedMaster: DiscogsMasterCandidate | null,
): RecordFormValues {
	// Album-level fields fall back release → master → record; pressing-specific
	// fields (label, format, size, catno, country) only come from a release.
	return {
		artist: picked?.artist || pickedMaster?.artist || record.artist,
		title: picked?.title || pickedMaster?.title || record.title,
		year: (picked?.year ?? pickedMaster?.year ?? record.year)?.toString() ?? "",
		label: picked?.label ?? record.label ?? "",
		format: picked?.type ?? record.format ?? "LP",
		size: picked?.size ?? record.size ?? "",
		catno: picked?.catno ?? record.catno ?? "",
		country: picked?.country ?? record.country ?? "",
		genre: picked?.genre ?? pickedMaster?.genre ?? record.genre ?? "",
		pitchforkScore: record.pitchforkScore?.toString() ?? "",
		notes: record.notes ?? "",
		manualValue: record.manualValue?.toString() ?? "",
	};
}

/**
 * A single Discogs candidate row. Once selected we fetch the full release so we
 * can fold the richer format/country/year line into the description, and surface
 * the tracklist in a hover tooltip (no inline accordion).
 */
function CandidateRow({
	candidate: c,
	active,
	onToggle,
}: {
	candidate: DiscogsCandidate;
	active: boolean;
	onToggle: () => void;
}) {
	const { data: detail } = useQuery({
		queryKey: ["discogs-release", c.discogsId] as const,
		queryFn: () => getDiscogsRelease({ data: c.discogsId }),
		staleTime: 5 * 60 * 1000,
		enabled: active,
	});

	// Keep the description identical whether or not the row is selected — always the
	// search-hit metadata, never the (selected-only) fetched detail. The fetch below
	// exists purely to populate the tracklist tooltip. Discogs hands back a literal
	// "none" for missing fields, so drop those alongside empty values.
	const metaParts = (
		[
			["Format", c.format],
			["Country", c.country],
			["Label", c.label],
			["Cat#", c.catno],
			["Year", c.year],
		] as const
	)
		.map(([k, v]) => [k, v == null ? "" : String(v).trim()] as const)
		.filter(([, v]) => v !== "" && v.toLowerCase() !== "none");
	const tracklist = detail?.tracklist ?? [];

	return (
		<li>
			<button
				type="button"
				onClick={onToggle}
				className={`flex min-h-[68px] w-full items-center gap-3 px-3 py-2 text-left text-sm ${
					active ? "bg-accent" : "hover:bg-accent/50"
				}`}
			>
				{c.thumb ? (
					<img
						src={c.thumb}
						alt=""
						className="size-10 shrink-0 rounded object-cover"
					/>
				) : (
					<div className="size-10 shrink-0 rounded bg-muted" />
				)}
				<span className="min-w-0 flex-1">
					<span className="block truncate">
						<span className="font-medium">{c.artist}</span> — {c.title}
						{c.year ? ` (${c.year})` : ""}
					</span>
					{(metaParts.length > 0 || (active && tracklist.length > 0)) && (
						<span className="flex items-start gap-1.5 text-xs text-muted-foreground">
							{metaParts.length > 0 && (
								<span>
									{metaParts.map(([k, v], i) => (
										<span key={k}>
											{i > 0 && (
												<span className="text-muted-foreground/40"> / </span>
											)}
											<span className="font-semibold">{k}:</span> {v}
										</span>
									))}
								</span>
							)}
							{active && tracklist.length > 0 && (
								<Tooltip>
									<TooltipTrigger asChild>
										{/* Presentational span keeps this valid inside the row button;
										    Radix supplies the hover/focus handlers. The click handler only
										    stops the event reaching the row so tapping the icon (notably on
										    touch) doesn't toggle/deselect the candidate. */}
										{/* biome-ignore lint/a11y/noStaticElementInteractions: tooltip trigger, not a control */}
										{/* biome-ignore lint/a11y/useKeyWithClickEvents: click only stops propagation, no action to key-bind */}
										<span
											onClick={(e) => e.stopPropagation()}
											className="mt-px shrink-0 cursor-help text-muted-foreground hover:text-foreground"
										>
											<Info className="size-3.5" aria-label="Show tracklist" />
										</span>
									</TooltipTrigger>
									<TooltipContent
										align="start"
										className="max-h-80 max-w-xs overflow-auto"
									>
										<ol className="space-y-0.5">
											{tracklist.map((t) => (
												<li
													key={`${t.position}-${t.title}`}
													className="flex gap-2 text-xs"
												>
													<span className="w-8 shrink-0 tabular-nums text-muted-foreground">
														{t.position}
													</span>
													<span className="flex-1">{t.title}</span>
													{t.duration && (
														<span className="tabular-nums text-muted-foreground">
															{t.duration}
														</span>
													)}
												</li>
											))}
										</ol>
									</TooltipContent>
								</Tooltip>
							)}
						</span>
					)}
				</span>
				{active && <span className="shrink-0 text-xs">✓</span>}
			</button>
		</li>
	);
}

/**
 * The album (master) picker — the primary "what record is this?" control. A record
 * needs a master to be publishable; the specific release (pressing) is an optional
 * pin handled by the separate candidate list below. Self-contained: owns its own
 * search / paste-URL flows and reports the chosen master (or a clear) to the parent.
 */
function MasterPicker({
	seedArtist,
	seedTitle,
	currentMasterId,
	currentLabel,
	currentUrl,
	pickedId,
	onPick,
	onClear,
}: {
	seedArtist: string;
	seedTitle: string;
	currentMasterId: string | null;
	currentLabel: string | null;
	currentUrl: string | null;
	pickedId: string | null;
	onPick: (c: DiscogsMasterCandidate) => void;
	onClear: () => void;
}) {
	const [q, setQ] = useState({ artist: seedArtist, title: seedTitle });
	const [urlInput, setUrlInput] = useState("");
	const [results, setResults] = useState<Array<DiscogsMasterCandidate> | null>(
		null,
	);

	const search = useMutation({
		mutationFn: (params: SearchParams) =>
			searchDiscogsMasters({ data: params }),
		onSuccess: setResults,
	});
	// Fallback when the server-side search is rate-limited: the Worker shares a
	// Cloudflare egress IP that Discogs throttles per-IP, so run the same search
	// from the admin's own (clean) browser IP instead. Unauthenticated — see
	// src/lib/discogs-browser.ts.
	const browserSearch = useMutation({
		mutationFn: (params: { artist: string; title: string }) =>
			searchMastersFromBrowser(params),
		onSuccess: setResults,
	});
	const lookup = useMutation({
		mutationFn: async (url: string) => {
			const c = await lookupDiscogsMaster({ data: url });
			if (!c) throw new Error("Couldn’t find a Discogs master at that URL.");
			return c;
		},
		onSuccess: (c) => {
			setResults([c]);
			onPick(c);
		},
	});

	return (
		<div className="space-y-3 rounded-lg border p-3">
			<div>
				<h2 className="text-sm font-semibold">
					Album{" "}
					<span className="font-normal text-muted-foreground">(master)</span>
				</h2>
				<p className="text-xs text-muted-foreground">
					The album is the record’s identity — it needs one to be published. A
					specific pressing is optional (below).
				</p>
			</div>

			{currentMasterId ? (
				<div className="flex items-center justify-between gap-3 rounded-md border bg-accent/30 px-3 py-2 text-sm">
					<span className="min-w-0 truncate">
						{currentUrl ? (
							<a
								href={currentUrl}
								target="_blank"
								rel="noreferrer"
								className="inline-flex items-center gap-1 hover:underline"
							>
								<span className="truncate">{currentLabel}</span>
								<ExternalLink className="size-3 shrink-0 text-muted-foreground" />
							</a>
						) : (
							currentLabel
						)}
					</span>
					<Button type="button" size="xs" variant="ghost" onClick={onClear}>
						Remove
					</Button>
				</div>
			) : (
				<p className="text-xs text-amber-600 dark:text-amber-400">
					No album linked — search or paste a master URL to make this
					publishable.
				</p>
			)}

			<form
				className="space-y-2"
				onSubmit={(e) => {
					e.preventDefault();
					if (!search.isPending) {
						search.mutate({
							artist: q.artist,
							title: q.title,
							country: "",
							year: "",
							q: "",
						});
					}
				}}
			>
				<div className="grid grid-cols-2 gap-2">
					<Input
						value={q.artist}
						placeholder="Artist"
						onChange={(e) => setQ((s) => ({ ...s, artist: e.target.value }))}
					/>
					<Input
						value={q.title}
						placeholder="Album title"
						onChange={(e) => setQ((s) => ({ ...s, title: e.target.value }))}
					/>
				</div>
				{search.isError && (
					<div className="space-y-2" role="alert">
						<p className="text-xs text-red-600">
							{search.error instanceof Error
								? search.error.message
								: "Search failed. Try again."}
						</p>
						<div className="flex items-center justify-between gap-2">
							<p className="text-xs text-muted-foreground">
								The server shares a rate-limited IP. Retry from your browser
								instead.
							</p>
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={browserSearch.isPending}
								onClick={() =>
									browserSearch.mutate({ artist: q.artist, title: q.title })
								}
							>
								{browserSearch.isPending ? "Searching…" : "Search from browser"}
							</Button>
						</div>
						{browserSearch.isError && (
							<p className="text-xs text-red-600">
								{browserSearch.error instanceof Error
									? browserSearch.error.message
									: "Browser search failed. Try again."}
							</p>
						)}
					</div>
				)}
				<div className="flex justify-end">
					<Button
						type="submit"
						variant="outline"
						size="sm"
						disabled={search.isPending}
					>
						{search.isPending ? "Searching…" : "Search albums"}
					</Button>
				</div>
			</form>

			{results && results.length > 0 && (
				<ul className="max-h-64 divide-y overflow-y-auto rounded-md border">
					{results.map((m) => {
						const active =
							pickedId === m.masterId ||
							(pickedId == null && currentMasterId === m.masterId);
						return (
							<li key={m.masterId}>
								<button
									type="button"
									onClick={() => onPick(m)}
									className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm ${
										active ? "bg-accent" : "hover:bg-accent/50"
									}`}
								>
									{m.thumb ? (
										<img
											src={m.thumb}
											alt=""
											className="size-10 shrink-0 rounded object-cover"
										/>
									) : (
										<div className="size-10 shrink-0 rounded bg-muted" />
									)}
									<span className="min-w-0 flex-1 truncate">
										<span className="block truncate">
											<span className="font-medium">{m.artist}</span> —{" "}
											{m.title}
											{m.year ? ` (${m.year})` : ""}
										</span>
										{m.genre && (
											<span className="block truncate text-xs text-muted-foreground">
												{m.genre}
											</span>
										)}
									</span>
									{active && <span className="shrink-0 text-xs">✓</span>}
								</button>
							</li>
						);
					})}
				</ul>
			)}
			{search.isSuccess && results?.length === 0 && (
				<p className="text-xs text-muted-foreground" aria-live="polite">
					No albums found. Try a different spelling or paste the master URL.
				</p>
			)}

			<form
				className="space-y-1"
				onSubmit={(e) => {
					e.preventDefault();
					if (looksLikeMasterId(urlInput) && !lookup.isPending) {
						lookup.mutate(urlInput);
					}
				}}
			>
				<label htmlFor="master-url" className="text-xs text-muted-foreground">
					Or paste a Discogs master URL
				</label>
				<div className="flex gap-2">
					<Input
						id="master-url"
						value={urlInput}
						placeholder="https://www.discogs.com/master/…"
						onChange={(e) => setUrlInput(e.target.value)}
					/>
					<Button
						type="submit"
						variant="outline"
						size="sm"
						disabled={lookup.isPending || !looksLikeMasterId(urlInput)}
					>
						{lookup.isPending ? "…" : "Link"}
					</Button>
				</div>
				{lookup.isError && (
					<p className="text-xs text-red-600">{lookup.error.message}</p>
				)}
			</form>
		</div>
	);
}

function RecordDetail() {
	const { id } = Route.useParams();
	const recordId = Number(id);
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	// Back/next paging through the collection, in the same order the admin list
	// shows (attention-needing first, then newest). Tracked by id so it never
	// jumps to the wrong record if the list re-sorts under it.
	const { data: allRecords } = useQuery(recordsQueryOptions);
	const ordered = useMemo(
		() => orderRecordsForReview(allRecords ?? []),
		[allRecords],
	);
	const pagerIndex = ordered.findIndex((r) => r.id === recordId);
	const prevRecord = pagerIndex > 0 ? ordered[pagerIndex - 1] : null;
	const nextRecord =
		pagerIndex >= 0 && pagerIndex < ordered.length - 1
			? ordered[pagerIndex + 1]
			: null;

	// Page to another record, carrying the editor-open state so a next/prev press
	// from inside the editor lands straight back in it (`keepEditor`), or drops the
	// flag so plain paging leaves the editor closed.
	const goToRecord = useCallback(
		(targetId: number, keepEditor: boolean) =>
			navigate({
				to: "/admin/records/$id",
				params: { id: String(targetId) },
				search: keepEditor ? { edit: true } : {},
			}),
		[navigate],
	);

	const { data: record } = useQuery({
		...recordQueryOptions(recordId),
		// Poll while anything's in flight: the background analysis (`status`) OR the queued
		// Apply photo job (`professionalJobStatus`). Without the latter the editor would sit
		// on "Generating…" until a manual refresh — the header queue (own poll) would show
		// then clear the job while this view stayed stale.
		refetchInterval: (query) => {
			const r = query.state.data;
			const active =
				r?.status === "pending" ||
				r?.status === "processing" ||
				r?.professionalJobStatus === "queued" ||
				r?.professionalJobStatus === "processing";
			return active ? 2000 : false;
		},
	});

	// The album (master) is the record's identity. `pickedMaster` is an explicit
	// choice from the master picker; `unmatchMaster` explicitly clears the album
	// (making the record unpublishable) — distinct from "no pick yet", which falls
	// back to the record's existing master (or a picked release's master).
	const [pickedMaster, setPickedMaster] =
		useState<DiscogsMasterCandidate | null>(null);
	const [unmatchMaster, setUnmatchMaster] = useState(false);

	const [picked, setPicked] = useState<DiscogsCandidate | null>(null);
	// "Album only": explicitly drop the pinned release on save while keeping the
	// master (the album). Distinct from "no pick yet" — which falls back to the
	// record's existing release — so the admin can un-pin a pressing on purpose.
	// Picking a candidate re-pins, so it clears this.
	const [albumOnly, setAlbumOnly] = useState(false);
	const [results, setResults] = useState<Array<DiscogsCandidate> | null>(null);
	// A non-persisted Discogs value estimate for a picked-but-unpublished edition,
	// so the admin can compare pricing across editions before committing. Cleared
	// whenever the picked candidate changes so it never shows a stale edition's price.
	const [preview, setPreview] = useState<DiscogsValue | null>(null);
	// Any change to the picked edition invalidates a previously previewed price.
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the id only.
	useEffect(() => {
		setPreview(null);
	}, [picked?.discogsId]);
	const [query, setQuery] = useState({
		artist: record?.artist ?? "",
		title: record?.title ?? "",
		country: "",
		year: "",
		q: "",
	});
	// The Discogs box is always open; default to the URL tab (paste-and-go).
	const [tab, setTab] = useState<"search" | "url">("url");
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [discogsUrl, setDiscogsUrl] = useState("");
	const [replacingCapture, setReplacingCapture] = useState(false);
	const captureInputRef = useRef<HTMLInputElement>(null);

	// When a Discogs candidate is picked, grab its full-res cover through our own
	// proxy so we can (a) show a zoomable preview of the actual artwork that will
	// be published and (b) confirm the download succeeded before committing. The
	// stored `record.coverImageKey` still shows until a pick is made.
	const [coverProbe, setCoverProbe] = useState<
		| { status: "idle" }
		| { status: "loading" }
		| { status: "ready"; url: string; bytes: number; type: string }
		| { status: "error"; message: string }
	>({ status: "idle" });

	const pickedId = picked?.discogsId ?? null;
	useEffect(() => {
		if (!pickedId) {
			setCoverProbe({ status: "idle" });
			return;
		}
		let objectUrl: string | null = null;
		let cancelled = false;
		setCoverProbe({ status: "loading" });
		fetch(`/api/discogs-cover/${pickedId}`)
			.then(async (res) => {
				if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
				const blob = await res.blob();
				if (cancelled) return;
				objectUrl = URL.createObjectURL(blob);
				setCoverProbe({
					status: "ready",
					url: objectUrl,
					bytes: blob.size,
					type: blob.type || "image",
				});
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setCoverProbe({
					status: "error",
					message: err instanceof Error ? err.message : "Download failed",
				});
			});
		return () => {
			cancelled = true;
			// Release the blob URL from this run — a new pick (or unmount) supersedes it.
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [pickedId]);

	const invalidate = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: recordsQueryOptions.queryKey }),
			queryClient.invalidateQueries({
				queryKey: recordQueryOptions(recordId).queryKey,
			}),
		]);

	const search = useMutation({
		mutationFn: (q: SearchParams) => searchDiscogs({ data: q }),
		onSuccess: setResults,
	});

	// Resolve a pasted Discogs release URL into a single candidate, then select it
	// so the form populates and it publishes just like a search hit.
	const lookup = useMutation({
		mutationFn: async (url: string) => {
			const candidate = await lookupDiscogsRelease({ data: url });
			if (!candidate) {
				throw new Error("Couldn’t find a Discogs release at that URL.");
			}
			return candidate;
		},
		onSuccess: (candidate) => {
			setResults([candidate]);
			setPicked(candidate);
		},
	});

	// Replace the source capture with a freshly chosen photo, regenerate the crop
	// server-side, then open the editor on the new image so it can be reviewed.
	const replaceCaptureMut = useMutation({
		mutationFn: (input: { dataUrl: string; mediaType: string }) =>
			replaceCapture({
				data: {
					id: recordId,
					imageBase64: input.dataUrl,
					mediaType: input.mediaType,
				},
			}),
		onSuccess: (row) => {
			if (!row) return;
			queryClient.setQueryData(recordQueryOptions(recordId).queryKey, row);
			// Open the editor on the new capture. The editor body re-seeds its crop/
			// tone from the record on mount — and its key includes the capture key,
			// which just changed — so there's nothing to seed here.
			navigate({
				to: "/admin/records/$id",
				params: { id },
				search: { edit: true },
			});
			toast.success("Capture replaced — review the crop, then Apply.");
		},
		onError: (err) =>
			toast.error(
				err instanceof Error ? err.message : "Couldn't replace the capture.",
			),
	});

	async function handleCaptureFile(file: File | undefined) {
		if (!file || !file.type.startsWith("image/")) return;
		setReplacingCapture(true);
		try {
			const dataUrl = await readFileAsDataUrl(file);
			await replaceCaptureMut.mutateAsync({ dataUrl, mediaType: file.type });
		} finally {
			setReplacingCapture(false);
		}
	}

	const retry = useMutation({
		mutationFn: () => reprocessRecord({ data: recordId }),
		onSuccess: invalidate,
	});

	// Permanently remove the record, then head back to the collection. Mirrors the
	// list's delete (see admin/index) — the server also clears any dangling
	// `duplicateOf` back-references pointing at this row.
	const remove = useMutation({
		mutationFn: () => deleteRecord({ data: recordId }),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: recordsQueryOptions.queryKey,
			});
			toast.success("Record deleted.");
			navigate({ to: "/admin" });
		},
		onError: () => toast.error("Couldn't delete this record."),
	});

	// Pull a fresh Discogs value estimate (seller price suggestions, falling back
	// to the lowest listing) for this record, leaving all other metadata alone.
	const fetchValue = useMutation({
		mutationFn: () => fetchRecordValue({ data: recordId }),
		onSuccess: async (row) => {
			await invalidate();
			if (!row || row.discogsValue == null) {
				toast.error("Couldn’t fetch a value from Discogs for this release.");
			} else {
				toast.success("Value updated from Discogs.");
			}
		},
		onError: () => toast.error("Couldn’t fetch a value from Discogs."),
	});

	// Preview a picked edition's value without saving it. Used when the admin has
	// selected a candidate that isn't yet published, so "Fetch value" can't persist
	// to it — we show the estimate inline instead and let publishing commit it.
	const previewValue = useMutation({
		mutationFn: (discogsId: string) => previewReleaseValue({ data: discogsId }),
		onSuccess: (value, discogsId) => {
			// A newer pick may have landed while this request was in flight. Ignore a
			// result for an edition that's no longer selected so we never overwrite the
			// display with a stale edition's price.
			if (discogsId !== picked?.discogsId) return;
			setPreview(value);
			if (!value || value.value == null) {
				toast.error("Couldn’t fetch a value from Discogs for this release.");
			}
		},
		onError: () => toast.error("Couldn’t fetch a value from Discogs."),
	});

	// Once an album (master) is linked, its vinyl pressings are the release
	// pick-list — pick the album first, then optionally a specific pressing.
	// Computed here (before the early return) to satisfy the rules of hooks.
	const versionsMasterId = unmatchMaster
		? null
		: (pickedMaster?.masterId ?? picked?.masterId ?? record?.masterId ?? null);
	const masterVersionsQuery = useQuery({
		queryKey: ["master-versions", versionsMasterId] as const,
		queryFn: () => getDiscogsMasterVersions({ data: versionsMasterId ?? "" }),
		enabled: versionsMasterId != null,
		staleTime: 5 * 60 * 1000,
	});

	if (!record) {
		return <p className="text-muted-foreground">Record not found.</p>;
	}

	// The edition a value fetch should target: the picked candidate if the admin
	// has chosen one, otherwise the record's saved release. Previewing (rather than
	// persisting) applies when the pick differs from what's saved — we can't write a
	// value to an unpublished edition, so we show it inline until they publish.
	// Album-only drops the pin, so there's no release to value against.
	const activeDiscogsId = albumOnly
		? null
		: (picked?.discogsId ?? record.discogsId);
	const isPreviewing = picked != null && picked.discogsId !== record.discogsId;
	const valuePending = fetchValue.isPending || previewValue.isPending;

	// The album (master) that would be saved: an explicit master pick wins, then a
	// picked release's master, then the record's own — unless explicitly unmatched.
	// A record needs this to be publishable.
	const effectiveMasterId = unmatchMaster
		? null
		: (pickedMaster?.masterId ?? picked?.masterId ?? record.masterId ?? null);
	const effectiveMasterUrl = unmatchMaster
		? null
		: (pickedMaster?.masterUrl ??
			picked?.masterUrl ??
			record.masterUrl ??
			null);
	const effectiveMasterLabel = pickedMaster
		? `${pickedMaster.artist} — ${pickedMaster.title}${pickedMaster.year ? ` (${pickedMaster.year})` : ""}`
		: `${record.artist} — ${record.title}${record.year ? ` (${record.year})` : ""}`;

	// Release pick-list: a manual search/URL result wins; otherwise the linked
	// album's vinyl pressings; falling back to whatever analysis stored on the row.
	const candidates =
		results ??
		masterVersionsQuery.data ??
		parseCandidates(record.candidatesJson);
	const inFlight =
		record.status === "pending" || record.status === "processing";
	const failure =
		record.status === "failed" ? describeAnalysisError(record.error) : null;

	// A background Apply job (reframe + enhance + matte) is queued or running for this
	// record — the record view polls, so this flips true/false on its own. Drives the
	// "Generating photo…" hint next to the capture actions below.
	const proGenerating =
		record.professionalJobStatus === "queued" ||
		record.professionalJobStatus === "processing";

	// Whether the record has a cover/matte that would actually show publicly — the
	// approved professional photo (displayCoverKey without the capture fallback).
	// Publishing needs this as well as an album; without it the record would go live
	// as a placeholder.
	const hasPublicCover = displayCoverKey(record) != null;

	// Header photo: the approved professional crop, else the raw capture. Never the
	// Discogs cover (see displayCoverKey) — that stays in the Discogs section only.
	const headerCoverKey = displayCoverKey(record, { includeCapture: true });
	const headerPhotoSrc = headerCoverKey
		? `/api/photos/${headerCoverKey}`
		: null;

	// When an approved professional matte exists, float it over the bottom-right
	// corner of the header cover as a small preview of the public grid treatment.
	const headerMatteKey = displayMatteKey(record);
	const headerMatteSrc = headerMatteKey
		? `/api/photos/${headerMatteKey}`
		: null;

	return (
		<div className="mx-auto max-w-2xl space-y-6">
			<div>
				<div className="flex items-center justify-between gap-2">
					<Link
						to="/admin"
						className="text-sm text-brand underline underline-offset-4 hover:text-brand-strong"
					>
						← Collection
					</Link>
					<RecordPager
						index={pagerIndex}
						total={ordered.length}
						hasPrev={prevRecord != null}
						hasNext={nextRecord != null}
						onPrev={() => prevRecord && goToRecord(prevRecord.id, false)}
						onNext={() => nextRecord && goToRecord(nextRecord.id, false)}
					/>
				</div>
				{/* Photo + text take ~half the width on desktop, with the badges pushed
				    to the far right; on mobile they stack into two rows (photo + text,
				    then the badges). Everything shares one bottom baseline so the status
				    badge sits opposite the Context line. */}
				<div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-end">
					{headerPhotoSrc && (
						<div className="relative w-full shrink-0 sm:w-1/2">
							<ImageZoom
								src={headerPhotoSrc}
								alt="Record photo"
								className="aspect-square w-full"
							/>
							{headerMatteSrc && (
								<img
									src={headerMatteSrc}
									alt=""
									aria-hidden
									className="pointer-events-none absolute -bottom-[10px] right-[10px] w-1/4"
								/>
							)}
						</div>
					)}
					<div className="min-w-0 flex-1">
						{record.artist && (
							<p className="truncate text-sm text-muted-foreground">
								{record.artist}
							</p>
						)}
						<h1 className="text-2xl font-semibold leading-tight">
							{record.title || "Captured record"}
						</h1>
						{/* Context and the status badges share a row on desktop (badge pushed
						    right, opposite the context); on mobile the badges drop to their
						    own line below the context. */}
						<div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
							{record.captureContext ? (
								<p className="min-w-0 text-sm text-muted-foreground">
									<span className="font-medium text-foreground">Context:</span>{" "}
									{record.captureContext}
								</p>
							) : (
								<span />
							)}
							<div className="flex flex-wrap items-center gap-1">
								{record.duplicateOf != null && <DuplicateBadge />}
								{/* Unmatched (no album) supersedes the plain "Unpublished" status. */}
								{record.status === "review" && !record.masterId ? (
									<UnmatchedBadge />
								) : (
									<StatusBadge status={record.status} />
								)}
							</div>
						</div>
					</div>
				</div>
			</div>

			{/* Flagged by analysis as already in the collection — link to the original. */}
			{record.duplicateOf != null && (
				<div className="flex items-center gap-2 rounded-md border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800 dark:border-orange-900 dark:bg-orange-950/40 dark:text-orange-200">
					<span>This release looks like it’s already in your collection.</span>
					<Link
						to="/admin/records/$id"
						params={{ id: String(record.duplicateOf) }}
						className="font-medium underline underline-offset-4"
					>
						View the original
					</Link>
				</div>
			)}

			{/* Two actions on the capture: swap the source photo, or open the crop/
			    tone editor. The image itself is shown (bottom-aligned) in the header. */}
			{!inFlight && record.capturePhotoKey && (
				<div className="flex flex-wrap items-center gap-2">
					<input
						ref={captureInputRef}
						type="file"
						accept="image/*"
						className="hidden"
						onChange={(e) => {
							handleCaptureFile(e.target.files?.[0]);
							// Allow re-selecting the same file after a cancel.
							e.target.value = "";
						}}
					/>
					<Button
						type="button"
						size="sm"
						onClick={() =>
							navigate({
								to: "/admin/records/$id",
								params: { id },
								search: { edit: true },
							})
						}
					>
						Edit image
					</Button>
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={replacingCapture}
						onClick={() => captureInputRef.current?.click()}
					>
						{replacingCapture ? "Replacing…" : "Replace capture"}
					</Button>
					{proGenerating && (
						<span className="text-xs text-muted-foreground">
							Generating photo… this runs in the background.
						</span>
					)}
					{record.professionalJobStatus === "failed" &&
						record.professionalError && (
							<span className="text-xs text-red-600 dark:text-red-400">
								Last generation failed: {record.professionalError}
							</span>
						)}
				</div>
			)}

			{/* In-flight: just wait and poll. */}
			{inFlight && (
				<div className="flex items-start gap-3 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
					<Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />
					Analyzing the photo in the background — reading the cover, matching
					Discogs, scoring on Pitchfork. This page updates itself when it’s
					ready.
				</div>
			)}

			{/* Failed: show the error and let the user retry or fill it in by hand. */}
			{failure && (
				<div className="space-y-3 rounded-md border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40">
					<div className="space-y-1">
						<p className="text-sm text-red-800 dark:text-red-200">
							<span className="font-medium">Analysis failed.</span>{" "}
							{failure.message}
						</p>
						{failure.hint && (
							<p className="text-sm text-red-700 dark:text-red-300">
								{failure.hint}
							</p>
						)}
					</div>
					<Button
						type="button"
						variant="outline"
						disabled={retry.isPending}
						onClick={() => retry.mutate()}
					>
						{retry.isPending ? "Re-queuing…" : "Retry analysis"}
					</Button>
				</div>
			)}

			{/* Review / failed / complete: confirm, edit, re-pick, publish. */}
			{!inFlight && (
				<div className="space-y-4">
					{/* Album (master) — the record's identity and publish gate. Sits above
					    the release picker: pick the album first, pin a pressing second. */}
					<MasterPicker
						seedArtist={record.artist}
						seedTitle={record.title}
						currentMasterId={effectiveMasterId}
						currentLabel={effectiveMasterLabel}
						currentUrl={effectiveMasterUrl}
						pickedId={pickedMaster?.masterId ?? null}
						onPick={(m) => {
							setPickedMaster(m);
							setUnmatchMaster(false);
						}}
						onClear={() => {
							setPickedMaster(null);
							setUnmatchMaster(true);
						}}
					/>

					{/* Release (pressing) — only shown once an album is linked, since a
					    release is one of that album's pressings. A confidence banner, the
					    search / paste-a-URL controls, and the pick-list — one panel, divided. */}
					{effectiveMasterId != null && (
						<div className="overflow-hidden rounded-lg border">
							<div className="p-3 pb-0">
								<h2 className="text-sm font-semibold">
									Release{" "}
									<span className="font-normal text-muted-foreground">
										(optional)
									</span>
								</h2>
								<p className="text-xs text-muted-foreground">
									Pin a specific pressing for its catalog number, country and
									value — or leave it album-only.
								</p>
							</div>
							{record.confidence != null && (
								<div className="mt-3 border-y bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
									Identified with {Math.round(record.confidence * 100)}%
									confidence.
									{record.status === "review"
										? " Confirm the details before publishing."
										: ""}
								</div>
							)}

							{/* Wrong match? Search or paste a Discogs URL. The sourced cover isn't
						    previewed here — it's visible in the candidate thumbnails below. */}
							<div className="p-3">
								<div className="min-w-0 space-y-3">
									{/* Tabs on the left; the cover-download status (progress →
								    size/type, or a failure) sits opposite, on the same row. */}
									<div className="flex items-center justify-between gap-2 border-b">
										<div
											role="tablist"
											aria-label="Discogs lookup method"
											className="flex gap-1"
										>
											<TabButton
												active={tab === "url"}
												onClick={() => setTab("url")}
											>
												Discogs URL
											</TabButton>
											<TabButton
												active={tab === "search"}
												onClick={() => setTab("search")}
											>
												Search
											</TabButton>
										</div>
										{picked && coverProbe.status !== "idle" && (
											<span
												className={cn(
													"shrink-0 text-xs text-muted-foreground",
													coverProbe.status === "error" &&
														"text-red-600 dark:text-red-400",
												)}
												aria-live="polite"
											>
												{coverProbe.status === "loading" && "Downloading…"}
												{coverProbe.status === "ready" &&
													`${(coverProbe.bytes / 1024).toFixed(0)} KB, ${coverProbe.type}`}
												{coverProbe.status === "error" && "Download failed"}
											</span>
										)}
									</div>

									{tab === "search" ? (
										<form
											className="space-y-2"
											onSubmit={(e) => {
												e.preventDefault();
												if (!search.isPending) search.mutate(query);
											}}
										>
											<div className="flex items-end gap-2">
												<div className="flex-1 space-y-1">
													<label
														htmlFor="q-artist"
														className="text-xs text-muted-foreground"
													>
														Artist
													</label>
													<Input
														id="q-artist"
														value={query.artist}
														onChange={(e) =>
															setQuery((q) => ({
																...q,
																artist: e.target.value,
															}))
														}
													/>
												</div>
												<div className="flex-1 space-y-1">
													<label
														htmlFor="q-title"
														className="text-xs text-muted-foreground"
													>
														Title
													</label>
													<Input
														id="q-title"
														value={query.title}
														onChange={(e) =>
															setQuery((q) => ({ ...q, title: e.target.value }))
														}
													/>
												</div>
											</div>

											{/* Country/Year are rarely needed — tuck them behind a disclosure. */}
											<button
												type="button"
												aria-expanded={showAdvanced}
												onClick={() => setShowAdvanced((v) => !v)}
												className="text-xs text-muted-foreground underline underline-offset-4"
											>
												{showAdvanced
													? "Hide advanced options"
													: "Advanced options"}
											</button>

											{showAdvanced && (
												<div className="flex items-end gap-2">
													<div className="flex-1 space-y-1">
														<label
															htmlFor="q-country"
															className="text-xs text-muted-foreground"
														>
															Country
														</label>
														<Input
															id="q-country"
															value={query.country}
															placeholder="e.g. UK"
															onChange={(e) =>
																setQuery((q) => ({
																	...q,
																	country: e.target.value,
																}))
															}
														/>
													</div>
													<div className="flex-1 space-y-1">
														<label
															htmlFor="q-year"
															className="text-xs text-muted-foreground"
														>
															Year
														</label>
														<Input
															id="q-year"
															inputMode="numeric"
															value={query.year}
															placeholder="e.g. 1971"
															onChange={(e) =>
																setQuery((q) => ({
																	...q,
																	year: e.target.value,
																}))
															}
														/>
													</div>
												</div>
											)}

											{/* Free-text catch-all — passed to Discogs' general search for
								    anything the structured fields miss (label, catalog number). */}
											{showAdvanced && (
												<div className="space-y-1">
													<label
														htmlFor="q-keywords"
														className="text-xs text-muted-foreground"
													>
														Discogs search
													</label>
													<Input
														id="q-keywords"
														value={query.q}
														placeholder="e.g. label, catalog number, or any keywords"
														onChange={(e) =>
															setQuery((q) => ({ ...q, q: e.target.value }))
														}
													/>
												</div>
											)}

											{search.isError && (
												<p className="text-xs text-red-600" role="alert">
													{search.error instanceof Error
														? search.error.message
														: "Search failed. Try again."}
												</p>
											)}
											{search.isSuccess && (search.data?.length ?? 0) === 0 && (
												<p
													className="text-xs text-muted-foreground"
													aria-live="polite"
												>
													No matches on Discogs. Try a different spelling, drop
													the title, or paste the release URL.
												</p>
											)}
											<div className="flex justify-end">
												<Button
													type="submit"
													variant="outline"
													disabled={search.isPending}
												>
													{search.isPending ? "Searching…" : "Search"}
												</Button>
											</div>
										</form>
									) : (
										<form
											className="space-y-2"
											onSubmit={(e) => {
												e.preventDefault();
												if (
													looksLikeReleaseId(discogsUrl) &&
													!lookup.isPending
												) {
													lookup.mutate(discogsUrl);
												}
											}}
										>
											<div className="space-y-1">
												<label
													htmlFor="q-url"
													className="text-xs text-muted-foreground"
												>
													Discogs release URL
												</label>
												<Input
													id="q-url"
													value={discogsUrl}
													placeholder="https://www.discogs.com/release/…"
													onChange={(e) => setDiscogsUrl(e.target.value)}
												/>
											</div>
											{lookup.isError && (
												<p className="text-xs text-red-600">
													{lookup.error.message}
												</p>
											)}
											<div className="flex justify-end">
												<Button
													type="submit"
													variant="outline"
													disabled={
														lookup.isPending || !looksLikeReleaseId(discogsUrl)
													}
												>
													{lookup.isPending ? "Fetching…" : "Fetch release"}
												</Button>
											</div>
										</form>
									)}
								</div>
							</div>

							{/* Loading the linked album's pressings (two Discogs calls). */}
							{masterVersionsQuery.isFetching && results == null && (
								<p className="border-t px-3 py-2 text-xs text-muted-foreground">
									Loading pressings for this album…
								</p>
							)}

							{/* Candidate pick-list — the lower half of the panel, divided from
						    the controls above. A manual search can return every pressing,
						    so cap the height and let it scroll rather than pushing the form
						    off-screen. */}
							{candidates.length > 0 && (
								<ul className="max-h-[345px] divide-y overflow-y-auto border-t">
									{candidates.map((c) => {
										const active = picked
											? picked.discogsId === c.discogsId
											: !albumOnly && record.discogsId === c.discogsId;
										return (
											<CandidateRow
												key={c.discogsId}
												candidate={c}
												active={active}
												onToggle={() => {
													// Picking a release re-pins, so it clears album-only.
													setAlbumOnly(false);
													// A release implies its album, so a fresh pick also
													// re-establishes the master (undoes an explicit unmatch).
													if (!active) setUnmatchMaster(false);
													setPicked(active ? null : c);
												}}
											/>
										);
									})}
								</ul>
							)}

							{/* Pressing un-pin control. Only meaningful when there's an album to
						    keep — un-pinning drops the specific pressing but holds the album
						    identity, and value/catno/country come from a pinned release, so
						    they go quiet until one is picked again. */}
							{effectiveMasterId != null && (
								<div className="flex items-center justify-between gap-3 border-t px-3 py-2 text-xs">
									<p className="text-muted-foreground">
										{activeDiscogsId
											? "Pinned to a specific pressing — its details and value apply."
											: "No specific pressing pinned — album only. Pick a release above to pin one."}
									</p>
									{activeDiscogsId ? (
										<Button
											type="button"
											size="xs"
											variant="ghost"
											onClick={() => {
												setPicked(null);
												setAlbumOnly(true);
											}}
										>
											Remove pressing
										</Button>
									) : (
										record.discogsId != null && (
											<Button
												type="button"
												size="xs"
												variant="ghost"
												onClick={() => setAlbumOnly(false)}
											>
												Undo
											</Button>
										)
									)}
								</div>
							)}
						</div>
					)}

					{/* Value is per-pressing, so it only appears once an album is linked AND
					    a specific release is pinned (a release without a master is a stale
					    leftover — don't surface its value). The headline is the manual
					    (confirmed) value if set, else the Discogs guess. */}
					{effectiveMasterId != null && activeDiscogsId != null && (
						<div className="space-y-3 rounded-lg border p-3">
							<div>
								<h2 className="text-sm font-semibold">Value</h2>
								<p className="text-xs text-muted-foreground">
									The pinned pressing’s Discogs price — or a confirmed price you
									set. Edit it in the form below.
								</p>
							</div>
							<div className="flex items-start justify-between gap-3">
								<div>
									<p className="text-xl font-semibold tabular-nums">
										{formatMoney(
											effectiveValue(record),
											record.discogsValueCurrency ?? "USD",
										)}
										<span className="ml-2 align-middle text-xs font-normal text-muted-foreground">
											{record.manualValue != null ? "confirmed" : "estimated"}
										</span>
									</p>
									<p className="mt-1 text-xs text-muted-foreground">
										Manual{" "}
										{record.manualValue != null
											? formatMoney(
													record.manualValue,
													record.discogsValueCurrency ?? "USD",
												)
											: "—"}{" "}
										· Discogs guess{" "}
										{record.discogsValue != null
											? formatMoney(
													record.discogsValue,
													record.discogsValueCurrency ?? "USD",
												)
											: "—"}
									</p>
									{isPreviewing && preview?.value != null && (
										<p className="mt-1 text-xs font-medium text-foreground">
											Picked edition{" "}
											{formatMoney(preview.value, preview.currency)}
											<span className="ml-1 font-normal text-muted-foreground">
												— preview, save to keep
											</span>
										</p>
									)}
								</div>
								<Button
									type="button"
									size="sm"
									variant="outline"
									disabled={valuePending}
									onClick={() =>
										isPreviewing && activeDiscogsId
											? previewValue.mutate(activeDiscogsId)
											: fetchValue.mutate()
									}
								>
									{valuePending
										? "Fetching…"
										: isPreviewing
											? "Preview value"
											: "Fetch value"}
								</Button>
							</div>
						</div>
					)}

					<div className="border-t pt-4">
						<RecordForm
							key={
								picked?.discogsId ??
								pickedMaster?.masterId ??
								record.discogsId ??
								record.masterId ??
								"record"
							}
							defaultValues={toForm(record, picked, pickedMaster)}
							submitLabel={
								// Publishing needs an album (master) *and* an approved cover/matte.
								// Without either, the save can only keep the record as a draft.
								!effectiveMasterId || !hasPublicCover
									? "Save draft"
									: record.status === "complete"
										? "Save changes"
										: "Save & publish"
							}
							onSubmit={async (input) => {
								const result = await publishRecord({
									data: {
										id: recordId,
										data: input,
										// The album (master) is the identity: an explicit master pick
										// wins, else a picked release's master, else the record's own —
										// unless it's been explicitly unmatched. Publishing requires it.
										masterId: effectiveMasterId,
										masterUrl: effectiveMasterUrl,
										discogsId: albumOnly
											? null
											: (picked?.discogsId ?? record.discogsId ?? null),
										discogsUrl: albumOnly
											? null
											: (picked?.discogsUrl ?? record.discogsUrl ?? null),
										coverImageKey: null,
									},
								});
								if (!result) {
									// The record no longer exists (deleted mid-edit) — nothing was
									// saved. Surface it and stay put rather than navigating away.
									toast.error("Couldn't save — this record no longer exists.");
									return;
								}
								await invalidate();
								if (result.coverFetchFailed) {
									// The new match saved, but its cover couldn't be sourced from
									// Discogs — the old artwork was cleared rather than kept. Point
									// the admin at the manual upload as a fallback.
									toast.error(
										"Saved, but couldn't fetch the cover from Discogs. Upload one manually or try again.",
									);
								} else if (result.needsMaster) {
									// Saved as a draft — no album linked, so it can't go live yet.
									toast.warning(
										"Saved as a draft. Link an album (master) to publish it.",
									);
								} else if (result.needsCover) {
									// Saved as a draft — album linked, but no approved cover/matte to
									// display, so it can't go live yet.
									toast.warning(
										"Saved as a draft. Approve a cover photo to publish it.",
									);
								} else {
									toast.success("Record saved.");
								}
								navigate({ to: "/admin" });
							}}
						/>
					</div>
				</div>
			)}

			{/* Danger zone. Kept outside the `!inFlight` gate so a record wedged mid-
			    analysis can still be removed. Deleting is permanent, so confirm first. */}
			<div className="flex flex-col gap-2 border-t border-destructive/30 pt-4 sm:flex-row sm:items-center sm:justify-between">
				<div>
					<h2 className="text-sm font-semibold">Delete record</h2>
					<p className="text-xs text-muted-foreground">
						Permanently removes this record and its photos. This can’t be
						undone.
					</p>
				</div>
				<Button
					type="button"
					variant="destructive"
					size="sm"
					className="shrink-0"
					disabled={remove.isPending}
					onClick={() => {
						const label =
							[record.artist, record.title].filter(Boolean).join(" — ") ||
							"this record";
						if (confirm(`Delete "${label}"? This can't be undone.`)) {
							remove.mutate();
						}
					}}
				>
					{remove.isPending ? "Deleting…" : "Delete record"}
				</Button>
			</div>
		</div>
	);
}

// Persistent host for the crop/tone editor Dialog. It reads the current record from
// the URL (id + `edit` search param) and is deliberately NOT keyed by id, so paging
// next/prev doesn't remount the Dialog — the Radix content stays mounted, so it never
// replays its open/scale animation between records. Only the body inside (keyed) re-
// seeds its working copy per record.
function RecordEditorHost() {
	const { id } = Route.useParams();
	const recordId = Number(id);
	const { edit: editParam } = Route.useSearch();
	const navigate = useNavigate();

	// Back/next paging through the collection, in the same order the admin list shows —
	// used by the pager in the editor header and the ← / → keyboard nav below.
	const { data: allRecords } = useQuery(recordsQueryOptions);
	const ordered = useMemo(
		() => orderRecordsForReview(allRecords ?? []),
		[allRecords],
	);
	const pagerIndex = ordered.findIndex((r) => r.id === recordId);
	const prevRecord = pagerIndex > 0 ? ordered[pagerIndex - 1] : null;
	const nextRecord =
		pagerIndex >= 0 && pagerIndex < ordered.length - 1
			? ordered[pagerIndex + 1]
			: null;

	const goToRecord = useCallback(
		(targetId: number, keepEditor: boolean) =>
			navigate({
				to: "/admin/records/$id",
				params: { id: String(targetId) },
				search: keepEditor ? { edit: true } : {},
			}),
		[navigate],
	);

	// No polling here — `RecordDetail` (always mounted alongside this host) already
	// drives the `refetchInterval` for this key, and both share one query cache, so
	// the editor's "Generating…" state stays live off the detail page's poll.
	const { data: record } = useQuery(recordQueryOptions(recordId));

	// Closing the editor drops `edit` from the URL (via `replace` so it doesn't add
	// history), otherwise a refresh or back-nav to `?edit=true` would reopen it.
	const handleOpenChange = useCallback(
		(open: boolean) => {
			if (!open && editParam) {
				navigate({
					to: "/admin/records/$id",
					params: { id },
					search: {},
					replace: true,
				});
			}
		},
		[navigate, id, editParam],
	);

	// ← / → page through the collection, so you can blitz through setting mattes from
	// the keyboard — including from inside the editor, where the crop handles and tone
	// sliders own the arrows only while they're focused. A control that consumed the key
	// (slider, crop handle) will have called preventDefault by the time this bubbles to
	// the window; ignore those, and any key aimed at a text field, so we never hijack
	// caret movement or a value nudge.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
			if (e.defaultPrevented) return;
			const el = e.target as HTMLElement | null;
			if (
				el?.isContentEditable ||
				el?.closest(
					"input, textarea, select, [contenteditable='true'], [role='slider']",
				)
			) {
				return;
			}
			const target = e.key === "ArrowLeft" ? prevRecord : nextRecord;
			if (!target) return;
			e.preventDefault();
			goToRecord(target.id, Boolean(editParam));
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [prevRecord, nextRecord, editParam, goToRecord]);

	const inFlight =
		record?.status === "pending" || record?.status === "processing";
	// Open only once the record's loaded, has a capture to edit, and analysis isn't
	// still in flight — mirrors the old inline guard the Dialog used to sit behind.
	const editorOpen =
		Boolean(editParam) && !inFlight && !!record?.capturePhotoKey;

	return (
		<Dialog open={editorOpen} onOpenChange={handleOpenChange}>
			<DialogContent className="max-w-5xl">
				<DialogHeader>
					{/* Title + the same back/next pager as the page header. `pr-8` keeps it
					    clear of the dialog's absolute close button. Paging from here keeps the
					    editor open so you can run straight down the collection setting mattes. */}
					<div className="flex items-start justify-between gap-4 pr-8">
						<DialogTitle>Edit image</DialogTitle>
						<RecordPager
							index={pagerIndex}
							total={ordered.length}
							hasPrev={prevRecord != null}
							hasNext={nextRecord != null}
							onPrev={() => prevRecord && goToRecord(prevRecord.id, true)}
							onNext={() => nextRecord && goToRecord(nextRecord.id, true)}
						/>
					</div>
					<DialogDescription>
						Drag the outer frame onto the background and the inner one onto the
						sleeve (or auto-detect), then tune the tone — the preview updates
						live. Apply runs the whole pipeline (enhance + AI matte) and can
						take a minute.
					</DialogDescription>
				</DialogHeader>
				{record?.capturePhotoKey && (
					<RecordEditorBody
						key={`${id}:${record.capturePhotoKey}`}
						record={record}
						recordId={recordId}
						onClose={() => handleOpenChange(false)}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

// The crop/tone editor body — everything inside the Dialog below the header. Keyed by
// id + capture key in the host, so it remounts (re-seeding band/tone from the record)
// when you page to another record or replace the capture, but NOT on an ordinary poll
// while a job runs — so an open editor keeps its unsaved edits.
function RecordEditorBody({
	record,
	recordId,
	onClose,
}: {
	record: Record;
	recordId: number;
	onClose: () => void;
}) {
	const queryClient = useQueryClient();

	const invalidate = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: recordsQueryOptions.queryKey }),
			queryClient.invalidateQueries({
				queryKey: recordQueryOptions(recordId).queryKey,
			}),
		]);

	// Editable reframe knobs, seeded from whatever's stored on the record. This is the
	// working copy the sliders drive; "Apply" sends it to the (free) reframe step.
	const [params, setParams] = useState<ReframeParams>(() =>
		parseReframeParams(record.professionalParamsJson),
	);
	// Working copy of the corner band the crop editor drives, seeded from the row
	// (full-frame default if it's never been cropped; legacy single-quad rows are
	// synthesised into a band). "Apply" warps the capture to this.
	const [band, setBand] = useState<CornerBand>(() =>
		parseCornerBand(record.sleeveCornersJson),
	);
	// Which output the live editing preview shows — the matte (default, the primary
	// render) or the square cover — toggled by the switch in the preview's top-right.
	const [previewMode, setPreviewMode] = useState<"matte" | "cover">("matte");
	// Which panel below the crop/preview shows — the tone knobs ("Edit") or the links to
	// the stored renders ("Outputs"). Same little tab style as the matte/cover toggle.
	const [toolTab, setToolTab] = useState<"edit" | "outputs">("edit");
	// `/api/photos/…` srcs of saved renders that failed to load, so a stale/missing key
	// hides that image instead of showing a broken-image glyph.
	const [savedImgError, setSavedImgError] = useState<Set<string>>(
		() => new Set(),
	);

	// When an Apply photo job finishes, flip the Edit/Outputs tabs to Outputs so the
	// freshly generated renders are what's shown. The editor stays open through Apply,
	// so this lands live while it's on screen.
	const wasGeneratingRef = useRef(false);
	useEffect(() => {
		const generating =
			record.professionalJobStatus === "queued" ||
			record.professionalJobStatus === "processing";
		if (wasGeneratingRef.current && !generating) setToolTab("outputs");
		wasGeneratingRef.current = generating;
	}, [record.professionalJobStatus]);

	// Apply the edit: persist the current corner band + tone and enqueue the paid pipeline
	// (reframe + Real-ESRGAN enhance + AI matte), which runs in the background. Returns
	// immediately; the editor stays open showing the regenerating state, and the record
	// view polls and swaps in the generated cover + matte in place when it lands.
	const applyPro = useMutation({
		mutationFn: () => reframeRecord({ data: { id: recordId, band, params } }),
		onSuccess: async (row) => {
			if (row)
				queryClient.setQueryData(recordQueryOptions(recordId).queryKey, row);
			await invalidate();
			// Keep the editor open so the Generated panel shows the regenerating state
			// (gray + spinner) and swaps in the new render in place when the job lands.
			toast.success("Generating photo...");
		},
		onError: (err) =>
			toast.error(
				err instanceof Error ? err.message : "Couldn't apply the changes.",
			),
	});

	// Remove the professional photo altogether: delete it from R2 and clear the record
	// back to a zero-state (no image, default crop + tone), then close the editor and
	// return to the detail view. A later edit regenerates from scratch.
	const removeCover = useMutation({
		mutationFn: () => clearProfessional({ data: recordId }),
		onSuccess: async (row) => {
			if (row)
				queryClient.setQueryData(recordQueryOptions(recordId).queryKey, row);
			await invalidate();
			onClose();
			toast.success("Cover removed.");
		},
		onError: (err) =>
			toast.error(
				err instanceof Error ? err.message : "Couldn't remove the cover.",
			),
	});

	// Professional-photo derived state. `p` merges the working-copy params over the
	// defaults so the sliders always have a concrete value.
	const p = { ...DEFAULT_REFRAME_PARAMS, ...params };

	// Does the working copy (band + tone) differ from what's saved on the row? Both
	// signatures normalise (round corners / merge tone defaults + sort keys) so a
	// reopened-but-untouched editor reads clean.
	const paramSig = (v: ReframeParams) =>
		JSON.stringify(
			Object.entries({ ...DEFAULT_REFRAME_PARAMS, ...v }).sort(([a], [b]) =>
				a < b ? -1 : a > b ? 1 : 0,
			),
		);
	const isDirty =
		serializeCornerBand(band) !==
			serializeCornerBand(parseCornerBand(record.sleeveCornersJson)) ||
		paramSig(params) !==
			paramSig(parseReframeParams(record.professionalParamsJson));
	// The photo's relationship to the shown cover drives the button states:
	//  - approved  → it's the live cover;
	//  - "live"    → approved *and* unchanged, so the primary button is a plain Close;
	//  - "Re-apply" only makes sense against a live cover; anything else is a first Apply.
	const isApproved = record.professionalStatus === "approved";
	// The last background job ended in an error (e.g. a transient matte failure that
	// preserved the old cover/matte). The primary button offers a retry even when the
	// cover is live and unchanged, so a hiccup isn't a dead end behind a plain "Close".
	const jobFailed = record.professionalJobStatus === "failed";
	const proIsLive = isApproved && !isDirty;
	// A background Apply job (reframe + enhance + matte) is queued or running for this
	// record — the record view polls, so this flips true/false on its own.
	const proGenerating =
		record.professionalJobStatus === "queued" ||
		record.professionalJobStatus === "processing";
	// Any editor mutation in flight, or a background job running — disables the controls
	// (a second Apply while one is generating would just stack jobs).
	const editorBusy = applyPro.isPending || proGenerating;

	// Links to every stored render for this record, for the "Outputs" tab — the original
	// capture, the square hero, and both matte variants. Only the keys that exist show.
	const referenceImages = [
		{ label: "Original capture", key: record.capturePhotoKey },
		{ label: "Square cover", key: record.professionalImageKey },
		{ label: "Matte (shadow)", key: record.professionalAlphaKey },
		{ label: "Matte (cutout)", key: record.professionalAlphaCutoutKey },
	].filter((r): r is { label: string; key: string } => r.key != null);

	return (
		<>
			<div className="grid gap-4 sm:grid-cols-2">
				<div className="space-y-2">
					<p className="text-xs font-medium text-muted-foreground">Crop</p>
					<CornerEditor
						src={`/api/photos/${record.capturePhotoKey}`}
						value={band}
						onChange={setBand}
						onDetect={async () => {
							const res = await detectCorners({ data: recordId });
							return res.corners;
						}}
						disabled={editorBusy}
					/>
				</div>
				<div className="space-y-2">
					<div className="flex items-baseline justify-between">
						<p className="text-xs font-medium text-muted-foreground">
							{proIsLive ? "Generated" : "Preview"}
						</p>
						{/* Matte / Cover toggle — picks which saved render the generated
						    view shows. Only shown once generated: both saved renders are
						    high-res, whereas the live editing preview's client-side matte
						    is too low-res to be useful, so editing just shows the cover. */}
						{proIsLive && record.capturePhotoKey && (
							<div className="flex items-center gap-3 text-[10px]">
								{(["matte", "cover"] as const).map((m) => (
									<button
										key={m}
										type="button"
										aria-pressed={previewMode === m}
										onClick={() => setPreviewMode(m)}
										className={cn(
											"capitalize transition-colors",
											previewMode === m
												? "text-foreground underline underline-offset-4"
												: "text-muted-foreground/70 hover:text-foreground",
										)}
									>
										{m}
									</button>
								))}
							</div>
						)}
					</div>
					{record.capturePhotoKey &&
						(proGenerating ? (
							// A job is running: don't keep showing the stale saved render
							// (it "flicks" the old matte back in until the swap). Show a
							// neutral placeholder + spinner so it reads as regenerating.
							<div className="flex aspect-square items-center justify-center rounded-md border bg-muted">
								<Loader2 className="size-6 animate-spin text-muted-foreground" />
							</div>
						) : proIsLive ? (
							(() => {
								// Generated + unchanged: show the saved render for the selected
								// tab in high res. Editing any corner/knob drops back to the
								// live preview below until Apply/Reset.
								const saved =
									previewMode === "matte"
										? { key: record.professionalAlphaKey, checker: true }
										: {
												key: record.professionalImageKey,
												checker: false,
											};
								const src = saved.key ? `/api/photos/${saved.key}` : null;
								if (!src || savedImgError.has(src)) {
									return (
										<div className="flex aspect-square items-center justify-center rounded-md border bg-muted/30 text-xs text-muted-foreground">
											No {previewMode} generated
										</div>
									);
								}
								return (
									<div
										className="overflow-hidden rounded-md border bg-background"
										style={
											saved.checker
												? {
														backgroundImage:
															"repeating-conic-gradient(hsl(var(--muted)) 0% 25%, transparent 0% 50%)",
														backgroundSize: "24px 24px",
													}
												: undefined
										}
									>
										<img
											src={src}
											alt={`Saved ${previewMode}`}
											onError={() =>
												setSavedImgError((s) => new Set(s).add(src))
											}
											className={cn(
												"block aspect-square size-full",
												saved.checker ? "object-contain" : "object-cover",
											)}
										/>
									</div>
								);
							})()
						) : (
							// Editing (never applied, or dirty): the live client-side cover
							// preview, updating as band/knobs change. No matte here — the
							// client-side matte is too low-res; the real one comes on Apply.
							<ProPreview
								src={`/api/photos/${record.capturePhotoKey}`}
								band={band}
								params={params}
							/>
						))}
				</div>
			</div>

			{/* Edit / Outputs tabs — the tone knobs vs links to the stored renders,
			    switched with the same little tab style as the matte/cover toggle. */}
			<div className="space-y-3">
				<div className="flex items-center gap-3 text-[10px]">
					{(
						[
							["edit", "Edit"],
							...(referenceImages.length > 0
								? ([["outputs", "Outputs"]] as const)
								: []),
						] as const
					).map(([id, label]) => (
						<button
							key={id}
							type="button"
							aria-pressed={toolTab === id}
							onClick={() => setToolTab(id)}
							className={cn(
								"transition-colors",
								toolTab === id
									? "text-foreground underline underline-offset-4"
									: "text-muted-foreground/70 hover:text-foreground",
							)}
						>
							{label}
						</button>
					))}
				</div>

				{toolTab === "edit" || referenceImages.length === 0 ? (
					/* Tone knobs. Auto-tone is the smart, foreground-aware baseline;
					   the polish factors below map straight to the pixel encode pass.
					   Every Apply re-warps + re-tones — all free. */
					<div className="space-y-3 rounded-md border bg-muted/30 p-3">
						<label
							htmlFor="pro-autotone"
							className="flex items-center gap-2 text-xs text-muted-foreground"
						>
							<Checkbox
								id="pro-autotone"
								checked={!p.skipTone}
								disabled={editorBusy}
								onChange={(e) =>
									setParams({
										...params,
										skipTone: !e.currentTarget.checked,
									})
								}
							/>
							Auto-tone (levels + white balance)
						</label>
						{/* 4×1 on wide screens, 2×2 as it narrows, 1×4 on mobile. */}
						<div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
							<Knob
								label="White balance"
								display={`${Math.round(p.wbStrength * 100)}%`}
								value={Math.round(p.wbStrength * 100)}
								min={0}
								max={100}
								step={1}
								disabled={p.skipTone || editorBusy}
								onChange={(v) => setParams({ ...params, wbStrength: v / 100 })}
							/>
							<Knob
								label="Saturation"
								display={`${Math.round(p.saturation * 100)}%`}
								value={Math.round(p.saturation * 100)}
								min={0}
								max={200}
								step={5}
								disabled={editorBusy}
								onChange={(v) => setParams({ ...params, saturation: v / 100 })}
							/>
							<Knob
								label="Contrast"
								display={`${Math.round(p.contrast * 100)}%`}
								value={Math.round(p.contrast * 100)}
								min={50}
								max={200}
								step={5}
								disabled={editorBusy}
								onChange={(v) => setParams({ ...params, contrast: v / 100 })}
							/>
							<Knob
								label="Gamma"
								display={p.gamma.toFixed(2)}
								value={Math.round(p.gamma * 100)}
								min={50}
								max={200}
								step={5}
								disabled={editorBusy}
								onChange={(v) => setParams({ ...params, gamma: v / 100 })}
							/>
						</div>
					</div>
				) : (
					/* Outputs tab: links to every stored render for this record. */
					<div className="rounded-md border bg-muted/30 p-3">
						<dl className="divide-y divide-border">
							{referenceImages.map(({ label, key }) => (
								<div
									key={key}
									className="flex items-baseline justify-between gap-4 py-1.5 text-xs"
								>
									<dt className="shrink-0 text-muted-foreground">{label}</dt>
									<dd className="min-w-0 text-right">
										<a
											href={`/api/photos/${key}`}
											target="_blank"
											rel="noreferrer"
											className="inline-flex items-center gap-1 text-foreground hover:text-brand"
										>
											Open
											<ExternalLink className="size-3" />
										</a>
									</dd>
								</div>
							))}
						</dl>
					</div>
				)}
			</div>

			{/* Destructive "Remove cover" on the left (only when there's an
			    approved cover to take down); Reset + Apply on the right (Apply
			    last). Apply saves the crop/tone and promotes it to the cover;
			    Remove cover unapproves it and returns to the detail view. */}
			<DialogFooter className="items-center justify-between sm:justify-between">
				{record.professionalStatus === "approved" ? (
					<Button
						type="button"
						size="sm"
						variant="destructive"
						disabled={removeCover.isPending || applyPro.isPending || editorBusy}
						onClick={() => removeCover.mutate()}
					>
						{removeCover.isPending ? "Removing…" : "Remove cover"}
					</Button>
				) : (
					<span />
				)}
				<div className="flex items-center gap-2">
					{/* Discard unsaved edits: snap the working copy back to what's
					    saved on the row. Purely client-side — no re-warp, no write —
					    so it can't leave a half-applied state. Disabled when there's
					    nothing to discard. */}
					<Button
						type="button"
						size="sm"
						variant="ghost"
						disabled={!isDirty || editorBusy}
						onClick={() => {
							setBand(parseCornerBand(record.sleeveCornersJson));
							setParams(parseReframeParams(record.professionalParamsJson));
						}}
					>
						Reset
					</Button>
					{/* One primary action, three states: Apply (nothing live yet),
					    Re-apply (live, but the crop/tone has been nudged), or a
					    plain Close (live and unchanged — nothing left to do). Only
					    the first two mutate; Close just dismisses. */}
					<Button
						type="button"
						size="sm"
						variant={proIsLive && !jobFailed ? "outline" : "default"}
						// Disabled while a job runs (editorBusy) — including the
						// "Generating…" state — so a second Apply can't stack, and
						// while the band is invalid (inner corners outside the outer
						// frame) so a self-contradictory trimap can't be applied. When
						// live + idle it's a plain Close, which is always allowed.
						disabled={
							editorBusy || (!(proIsLive && !jobFailed) && !isBandValid(band))
						}
						onClick={() =>
							proIsLive && !jobFailed ? onClose() : applyPro.mutate()
						}
					>
						{applyPro.isPending || proGenerating
							? "Generating…"
							: jobFailed
								? "Retry"
								: proIsLive
									? "Close"
									: isApproved && isDirty
										? "Re-apply"
										: "Apply"}
					</Button>
				</div>
			</DialogFooter>
		</>
	);
}
