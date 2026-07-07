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
import { UnmatchedBadge } from "#/components/unmatched-badge";
import type { Record } from "#/db/schema";
import { describeAnalysisError } from "#/lib/analysis-error";
import type {
	DiscogsCandidate,
	DiscogsValue,
	SearchParams,
} from "#/lib/discogs";
import { squareDownscale } from "#/lib/image-resize";
import type { RecordFormValues } from "#/lib/record-schema";
import {
	fetchRecordValue,
	generateProfessional,
	getDiscogsRelease,
	lookupDiscogsRelease,
	previewReleaseValue,
	publishRecord,
	refreshRecord,
	reprocessRecord,
	searchDiscogs,
	setProfessionalApproved,
	uploadCover,
} from "#/lib/records";
import { recordQueryOptions, recordsQueryOptions } from "#/lib/records-queries";
import { cn } from "#/lib/utils";
import { effectiveValue, formatMoney } from "#/lib/value";

/** Does the pasted text look like it contains a Discogs release id? */
function looksLikeReleaseId(input: string): boolean {
	const s = input.trim();
	return /^\d+$/.test(s) || /\/releases?\/\d+/.test(s);
}

// Collapse a pasted Discogs release URL to its canonical form, dropping the
// decorative trailing slug: "…/release/12126690-Joe-Goddard-So-Much" →
// "…/release/12126690". A bare id or already-clean URL passes through unchanged.
function cleanDiscogsUrl(input: string): string {
	const m = input.match(/\/releases?\/(\d+)/);
	return m ? `https://www.discogs.com/release/${m[1]}` : input;
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
		manualValue: record.manualValue?.toString() ?? "",
		confirmedRelease: record.confirmedRelease ?? false,
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

function RecordDetail() {
	const { id } = Route.useParams();
	const recordId = Number(id);
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const { data: record } = useQuery({
		...recordQueryOptions(recordId),
		// Poll while the background analysis or a professional-photo job is in flight.
		refetchInterval: (query) => {
			const status = query.state.data?.status;
			const pro = query.state.data?.professionalStatus;
			const active =
				status === "pending" ||
				status === "processing" ||
				pro === "pending" ||
				pro === "processing";
			return active ? 2000 : false;
		},
	});

	const [picked, setPicked] = useState<DiscogsCandidate | null>(null);
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

	// Queue (or re-queue) the professional studio photo. Lands via the queue, so
	// the detail page polls itself to `ready` while `professionalStatus` is in flight.
	const generatePro = useMutation({
		mutationFn: () => generateProfessional({ data: recordId }),
		onSuccess: invalidate,
		onError: (err) =>
			toast.error(
				err instanceof Error ? err.message : "Couldn't start the photo.",
			),
	});

	// Approve (promote) or unapprove the generated professional photo.
	const approvePro = useMutation({
		mutationFn: (approved: boolean) =>
			setProfessionalApproved({ data: { id: recordId, approved } }),
		onSuccess: invalidate,
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

	// The edition a value fetch should target: the picked candidate if the admin
	// has chosen one, otherwise the record's saved release. Previewing (rather than
	// persisting) applies when the pick differs from what's saved — we can't write a
	// value to an unpublished edition, so we show it inline until they publish.
	const activeDiscogsId = picked?.discogsId ?? record.discogsId;
	const isPreviewing = picked != null && picked.discogsId !== record.discogsId;
	const valuePending = fetchValue.isPending || previewValue.isPending;

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
					{record.captureContext && (
						<p className="mt-1 text-sm text-muted-foreground">
							<span className="font-medium text-foreground">Context:</span>{" "}
							{record.captureContext}
						</p>
					)}
				</div>
				<div className="flex flex-wrap items-center justify-end gap-1">
					{record.status === "review" && !record.discogsId && (
						<UnmatchedBadge />
					)}
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
					{record.discogsId ? (
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={refresh.isPending}
							onClick={() => refresh.mutate()}
						>
							{refresh.isPending ? "Refreshing…" : "Refresh"}
						</Button>
					) : (
						// Unmatched: no release to refresh from yet. Re-run the analysis to
						// take another shot at reading the cover and matching Discogs (the
						// fetch retries mean a transient miss is worth retrying).
						record.status === "review" && (
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={retry.isPending}
								onClick={() => retry.mutate()}
							>
								{retry.isPending ? "Matching…" : "Match"}
							</Button>
						)
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

			{/* Professional studio photo — generated from the capture via Replicate,
			    reviewed here, then preferred over the Discogs cover once approved. */}
			{!inFlight && record.capturePhotoKey && (
				<div className="space-y-3 rounded-lg border p-3">
					<div className="flex items-start justify-between gap-2">
						<div>
							<h2 className="text-sm font-semibold">Professional photo</h2>
							<p className="text-xs text-muted-foreground">
								A studio-lit, tight-cropped cutout generated from your capture.
								Once approved it’s shown across the site in place of the cover.
							</p>
						</div>
						{record.professionalStatus === "approved" && (
							<span className="shrink-0 rounded-full bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand">
								Live
							</span>
						)}
					</div>

					{record.professionalStatus === "pending" ||
					record.professionalStatus === "processing" ? (
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<Loader2 className="size-4 shrink-0 animate-spin" />
							Generating the professional photo — this page updates itself when
							it’s ready.
						</div>
					) : record.professionalImageKey &&
						(record.professionalStatus === "ready" ||
							record.professionalStatus === "approved") ? (
						<div className="space-y-3">
							<figure className="space-y-1">
								<ImageZoom
									src={`/api/photos/${record.professionalImageKey}`}
									alt="Professional photo"
									className="size-40 bg-muted"
								/>
								<figcaption className="text-xs text-muted-foreground">
									{record.professionalStatus === "approved"
										? "Approved — shown on the site"
										: "Generated — not shown until approved"}
								</figcaption>
							</figure>
							<div className="flex flex-wrap gap-2">
								{record.professionalStatus === "ready" ? (
									<Button
										type="button"
										size="sm"
										disabled={approvePro.isPending}
										onClick={() => approvePro.mutate(true)}
									>
										{approvePro.isPending ? "…" : "Use as cover"}
									</Button>
								) : (
									<Button
										type="button"
										size="sm"
										variant="outline"
										disabled={approvePro.isPending}
										onClick={() => approvePro.mutate(false)}
									>
										{approvePro.isPending ? "…" : "Stop using"}
									</Button>
								)}
								<Button
									type="button"
									size="sm"
									variant="outline"
									disabled={generatePro.isPending}
									onClick={() => generatePro.mutate()}
								>
									{generatePro.isPending ? "…" : "Regenerate"}
								</Button>
							</div>
						</div>
					) : (
						<div className="space-y-2">
							{record.professionalStatus === "failed" &&
								record.professionalError && (
									<p className="text-xs text-red-600 dark:text-red-400">
										Generation failed: {record.professionalError}
									</p>
								)}
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={generatePro.isPending}
								onClick={() => generatePro.mutate()}
							>
								{generatePro.isPending
									? "Queuing…"
									: record.professionalStatus === "failed"
										? "Try again"
										: "Generate professional photo"}
							</Button>
						</div>
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
					{/* Discogs match: a confidence banner, the search / paste-a-URL
					    controls, and the candidate pick-list — one panel, divided. */}
					<div className="overflow-hidden rounded-lg border">
						{record.confidence != null && (
							<div className="border-b bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
								Identified with {Math.round(record.confidence * 100)}%
								confidence.
								{record.status === "review"
									? " Confirm the details and pick the right Discogs release before publishing."
									: ""}
							</div>
						)}

						{/* Wrong match? Search Discogs or paste a release URL. */}
						<div className="space-y-3 p-3">
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
											No matches on Discogs. Try a different spelling, drop the
											title, or paste the release URL.
										</p>
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
											onChange={(e) =>
												setDiscogsUrl(cleanDiscogsUrl(e.target.value))
											}
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
											{lookup.isPending ? "…" : "Fetch release"}
										</Button>
									</div>
								</form>
							)}
						</div>

						{/* Candidate pick-list — the lower half of the panel, divided from
						    the controls above. A manual search can return every pressing,
						    so cap the height and let it scroll rather than pushing the form
						    off-screen. */}
						{candidates.length > 0 && (
							<ul className="max-h-[345px] divide-y overflow-y-auto border-t">
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
					</div>

					{/* Valuation. The headline is the manual (confirmed) value if set,
					    else the Discogs guess; both are entered/edited in the form below.
					    "Fetch value" pulls a fresh estimate from Discogs. */}
					<div className="space-y-3 rounded-lg border p-3">
						<div>
							<h2 className="text-sm font-semibold">Value</h2>
							<p className="text-xs text-muted-foreground">
								The confirmed price if you’ve set one, otherwise Discogs’
								estimate. Edit it in the form below.
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
								disabled={!activeDiscogsId || valuePending}
								title={
									activeDiscogsId
										? undefined
										: "Match a Discogs release first to fetch a value."
								}
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
