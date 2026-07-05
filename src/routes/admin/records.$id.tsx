import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Info, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { DuplicateBadge } from "#/components/duplicate-badge";
import { RecordForm } from "#/components/record-form";
import { StatusBadge } from "#/components/status-badge";
import { Button } from "#/components/ui/button";
import { ImageZoom } from "#/components/ui/image-zoom";
import { Input } from "#/components/ui/input";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "#/components/ui/tooltip";
import type { Record } from "#/db/schema";
import { describeAnalysisError } from "#/lib/analysis-error";
import type { DiscogsCandidate, SearchParams } from "#/lib/discogs";
import { squareDownscale } from "#/lib/image-resize";
import type { RecordFormValues } from "#/lib/record-schema";
import {
	getDiscogsRelease,
	lookupDiscogsRelease,
	publishRecord,
	refreshRecord,
	reprocessRecord,
	searchDiscogs,
	uploadCover,
} from "#/lib/records";
import { recordQueryOptions, recordsQueryOptions } from "#/lib/records-queries";
import { cn } from "#/lib/utils";

/** Does the pasted text look like it contains a Discogs release id? */
function looksLikeReleaseId(input: string): boolean {
	const s = input.trim();
	return /^\d+$/.test(s) || /\/releases?\/\d+/.test(s);
}

/** Read a file to a data URL (fallback when the browser can't crop/decode it). */
function readFileAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

/** Square-crop + downscale a chosen cover, falling back to the raw file. */
async function prepareCover(file: File): Promise<string> {
	try {
		return (await squareDownscale(file)).dataUrl;
	} catch {
		return readFileAsDataUrl(file);
	}
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

export const Route = createFileRoute("/admin/records/$id")({
	loader: ({ context, params }) =>
		context.queryClient.ensureQueryData(recordQueryOptions(Number(params.id))),
	component: RecordDetail,
});

function parseCandidates(json: string | null): Array<DiscogsCandidate> {
	if (!json) return [];
	try {
		return JSON.parse(json) as Array<DiscogsCandidate>;
	} catch {
		return [];
	}
}

/** Build form defaults from the record, overlaying a freshly picked Discogs release. */
function toForm(
	record: Record,
	picked: DiscogsCandidate | null,
): RecordFormValues {
	return {
		artist: picked?.artist || record.artist,
		title: picked?.title || record.title,
		year: (picked?.year ?? record.year)?.toString() ?? "",
		label: picked?.label ?? record.label ?? "",
		format: picked?.type ?? record.format ?? "LP",
		size: picked?.size ?? record.size ?? "",
		catno: picked?.catno ?? record.catno ?? "",
		country: picked?.country ?? record.country ?? "",
		genre: picked?.genre ?? record.genre ?? "",
		pitchforkScore: record.pitchforkScore?.toString() ?? "",
		notes: record.notes ?? "",
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
				className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm ${
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

function RecordDetail() {
	const { id } = Route.useParams();
	const recordId = Number(id);
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const { data: record } = useQuery({
		...recordQueryOptions(recordId),
		// Poll while the background analysis is in flight.
		refetchInterval: (query) => {
			const status = query.state.data?.status;
			return status === "pending" || status === "processing" ? 2000 : false;
		},
	});

	const [picked, setPicked] = useState<DiscogsCandidate | null>(null);
	const [results, setResults] = useState<Array<DiscogsCandidate> | null>(null);
	const [query, setQuery] = useState({
		artist: record?.artist ?? "",
		title: record?.title ?? "",
		country: "",
		year: "",
	});
	// The Discogs box is always open; default to the URL tab (paste-and-go).
	const [tab, setTab] = useState<"search" | "url">("url");
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [discogsUrl, setDiscogsUrl] = useState("");
	// Briefly shown after a refresh so the enrichment landing isn't silent.
	const [justRefreshed, setJustRefreshed] = useState(false);
	// A user-uploaded cover overrides the auto-sourced Discogs artwork on publish.
	const [customCover, setCustomCover] = useState<{
		key: string;
		preview: string;
	} | null>(null);
	const [uploadingCover, setUploadingCover] = useState(false);
	const coverInputRef = useRef<HTMLInputElement>(null);

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

	async function handleCoverFile(file: File | undefined) {
		if (!file || !file.type.startsWith("image/")) return;
		setUploadingCover(true);
		try {
			const dataUrl = await prepareCover(file);
			const key = await uploadCover({ data: { imageBase64: dataUrl } });
			if (key) setCustomCover({ key, preview: dataUrl });
		} finally {
			setUploadingCover(false);
		}
	}

	const retry = useMutation({
		mutationFn: () => reprocessRecord({ data: recordId }),
		onSuccess: invalidate,
	});

	// Re-pull the enrichment fields from the stored Discogs release (no re-scan of
	// the photo). Clears any locally picked candidate so the form shows fresh data.
	const refresh = useMutation({
		mutationFn: () => refreshRecord({ data: recordId }),
		onSuccess: async () => {
			setPicked(null);
			setResults(null);
			await invalidate();
			// Surface that fresh content landed, then let the message fade out.
			setJustRefreshed(true);
			setTimeout(() => setJustRefreshed(false), 2500);
		},
	});

	if (!record) {
		return <p className="text-muted-foreground">Record not found.</p>;
	}

	const candidates = results ?? parseCandidates(record.candidatesJson);
	const inFlight =
		record.status === "pending" || record.status === "processing";
	const failure =
		record.status === "failed" ? describeAnalysisError(record.error) : null;

	// Cover preview source, best-first: the freshly downloaded full-res artwork,
	// then the picked candidate's thumbnail (instant, while the full-res loads or
	// if it failed), then the stored cover when nothing is picked.
	const coverPreviewSrc =
		coverProbe.status === "ready"
			? coverProbe.url
			: (picked?.thumb ??
				(record.coverImageKey ? `/api/photos/${record.coverImageKey}` : null));
	const heading =
		record.artist || record.title
			? `${record.artist || "Unknown"} — ${record.title || "Untitled"}`
			: "Captured record";

	return (
		<div className="mx-auto max-w-2xl space-y-6">
			<div className="flex items-start justify-between gap-4">
				<div>
					<Link
						to="/admin"
						className="text-sm text-brand underline underline-offset-4 hover:text-brand-strong"
					>
						← Collection
					</Link>
					<h1 className="mt-1 text-2xl font-semibold">{heading}</h1>
				</div>
				<div className="flex flex-wrap items-center justify-end gap-1">
					{record.duplicateOf != null && <DuplicateBadge />}
					<StatusBadge status={record.status} />
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

			{/* Photos: the iPhone capture, plus the sourced cover once we have one. */}
			<div className="flex gap-3">
				{record.capturePhotoKey && (
					<figure className="space-y-1">
						<ImageZoom
							src={`/api/photos/${record.capturePhotoKey}`}
							alt="Original capture"
							className="size-32"
						/>
						<figcaption className="text-xs text-muted-foreground">
							Capture
						</figcaption>
					</figure>
				)}
				{/* Preview the picked candidate's Discogs artwork immediately — the
				    full-res cover isn't sourced into R2 until publish, so we grab it
				    through the proxy for a zoomable, verified preview. */}
				{coverPreviewSrc && (
					<figure className="space-y-1">
						<ImageZoom
							src={coverPreviewSrc}
							alt={picked ? "Selected Discogs cover" : "Sourced cover"}
							className="size-32"
						/>
						<figcaption className="text-xs text-muted-foreground">
							{picked ? "Cover (selected)" : "Cover"}
						</figcaption>
					</figure>
				)}
				{customCover && (
					<figure className="space-y-1">
						<ImageZoom
							src={customCover.preview}
							alt="Uploaded cover"
							className="size-32"
						/>
						<figcaption className="text-xs text-muted-foreground">
							Upload
						</figcaption>
					</figure>
				)}
			</div>

			{/* Download status for the picked candidate's cover — confirms the grab
			    worked (with size/type) or surfaces why it didn't. */}
			{picked && coverProbe.status !== "idle" && (
				<p className="text-xs text-muted-foreground" aria-live="polite">
					{coverProbe.status === "loading" && "Downloading cover from Discogs…"}
					{coverProbe.status === "ready" &&
						`Cover downloaded — ${(coverProbe.bytes / 1024).toFixed(0)} KB, ${coverProbe.type}.`}
					{coverProbe.status === "error" && (
						<span className="text-red-600 dark:text-red-400">
							Couldn’t download cover: {coverProbe.message}. It’ll be re-sourced
							on publish.
						</span>
					)}
				</p>
			)}

			{/* Upload your own cover — overrides the Discogs artwork on publish. */}
			{!inFlight && (
				<div className="flex items-center gap-2">
					<input
						ref={coverInputRef}
						type="file"
						accept="image/*"
						className="hidden"
						onChange={(e) => {
							handleCoverFile(e.target.files?.[0]);
							// Allow re-selecting the same file after a remove.
							e.target.value = "";
						}}
					/>
					{record.discogsId && (
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={refresh.isPending}
							onClick={() => refresh.mutate()}
						>
							{refresh.isPending ? "Refreshing…" : "Refresh from Discogs"}
						</Button>
					)}
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={uploadingCover}
						onClick={() => coverInputRef.current?.click()}
					>
						{uploadingCover
							? "Uploading…"
							: customCover
								? "Replace cover"
								: "Upload cover"}
					</Button>
					{customCover && (
						<button
							type="button"
							onClick={() => setCustomCover(null)}
							className="text-sm text-muted-foreground underline underline-offset-4"
						>
							Remove
						</button>
					)}
					{justRefreshed && (
						<span className="text-sm text-muted-foreground">
							Updating content…
						</span>
					)}
				</div>
			)}

			{record.captureContext && (
				<p className="text-sm text-muted-foreground">
					<span className="font-medium text-foreground">Context:</span>{" "}
					{record.captureContext}
				</p>
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
					{record.confidence != null && (
						<p className="text-sm text-muted-foreground">
							Identified with {Math.round(record.confidence * 100)}% confidence.
							{record.status === "review"
								? " Confirm the details and pick the right Discogs release before publishing."
								: ""}
						</p>
					)}

					{/* Wrong match? Search Discogs or paste a release URL. */}
					<div className="space-y-3 rounded-lg border p-3">
						<div
							role="tablist"
							aria-label="Discogs lookup method"
							className="flex gap-1 border-b"
						>
							<TabButton active={tab === "url"} onClick={() => setTab("url")}>
								Discogs URL
							</TabButton>
							<TabButton
								active={tab === "search"}
								onClick={() => setTab("search")}
							>
								Search
							</TabButton>
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
												setQuery((q) => ({ ...q, artist: e.target.value }))
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
									{showAdvanced ? "Hide advanced options" : "Advanced options"}
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
													setQuery((q) => ({ ...q, country: e.target.value }))
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
													setQuery((q) => ({ ...q, year: e.target.value }))
												}
											/>
										</div>
									</div>
								)}

								<div className="flex justify-end">
									<Button
										type="submit"
										variant="outline"
										disabled={search.isPending}
									>
										{search.isPending ? "…" : "Search"}
									</Button>
								</div>
							</form>
						) : (
							<form
								className="space-y-2"
								onSubmit={(e) => {
									e.preventDefault();
									if (looksLikeReleaseId(discogsUrl) && !lookup.isPending) {
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
									<p className="text-xs text-red-600">{lookup.error.message}</p>
								)}
								<div className="flex justify-end">
									<Button
										type="submit"
										variant="outline"
										disabled={
											lookup.isPending || !looksLikeReleaseId(discogsUrl)
										}
									>
										{lookup.isPending ? "…" : "Fetch release"}
									</Button>
								</div>
							</form>
						)}
					</div>

					{/* Candidate pick-list. */}
					{candidates.length > 0 && (
						<ul className="divide-y rounded-md border">
							{candidates.map((c) => {
								const active =
									picked?.discogsId === c.discogsId ||
									(!picked && record.discogsId === c.discogsId);
								return (
									<CandidateRow
										key={c.discogsId}
										candidate={c}
										active={active}
										onToggle={() => setPicked(active ? null : c)}
									/>
								);
							})}
						</ul>
					)}

					<div className="border-t pt-4">
						<RecordForm
							key={picked?.discogsId ?? record.discogsId ?? "record"}
							defaultValues={toForm(record, picked)}
							submitLabel={
								record.status === "complete" ? "Save changes" : "Save & publish"
							}
							onSubmit={async (input) => {
								const result = await publishRecord({
									data: {
										id: recordId,
										data: input,
										discogsId: picked?.discogsId ?? record.discogsId ?? null,
										discogsUrl: picked?.discogsUrl ?? record.discogsUrl ?? null,
										coverImageKey: customCover?.key ?? null,
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
								} else {
									toast.success("Record saved.");
								}
								navigate({ to: "/admin" });
							}}
						/>
					</div>
				</div>
			)}
		</div>
	);
}
