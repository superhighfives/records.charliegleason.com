import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Info, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { displayCoverKey } from "#/lib/cover";
import type {
	DiscogsCandidate,
	DiscogsValue,
	SearchParams,
} from "#/lib/discogs";
import type { RecordFormValues } from "#/lib/record-schema";
import {
	deleteRecord,
	detectCorners,
	fetchRecordValue,
	generateProfessional,
	getDiscogsRelease,
	lookupDiscogsRelease,
	previewReleaseValue,
	publishRecord,
	reframeRecord,
	replaceCapture,
	reprocessRecord,
	searchDiscogs,
	setProfessionalApproved,
} from "#/lib/records";
import { recordQueryOptions, recordsQueryOptions } from "#/lib/records-queries";
import {
	DEFAULT_REFRAME_PARAMS,
	parseReframeParams,
	type ReframeParams,
} from "#/lib/reframe-params";
import {
	DEFAULT_CORNERS,
	type NormalizedCorners,
	parseCorners,
} from "#/lib/sleeve-corners";
import { cn } from "#/lib/utils";
import { effectiveValue, formatMoney } from "#/lib/value";

/** Does the pasted text look like it contains a Discogs release id? */
function looksLikeReleaseId(input: string): boolean {
	const s = input.trim();
	return /^\d+$/.test(s) || /\/releases?\/\d+/.test(s);
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
		// Poll only while the background analysis is in flight. The professional photo
		// is generated synchronously (no queue), so there's never a pro job to wait on.
		refetchInterval: (query) => {
			const status = query.state.data?.status;
			const active = status === "pending" || status === "processing";
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
	// Editable reframe knobs, seeded from whatever's stored on the record. This is the
	// working copy the sliders drive; "Apply" sends it to the (free) reframe step.
	const [params, setParams] = useState<ReframeParams>(() =>
		parseReframeParams(record?.professionalParamsJson),
	);
	// Working copy of the sleeve corners the crop editor drives, seeded from the row
	// (full-frame default if it's never been cropped). "Apply" warps the capture to these.
	const [corners, setCorners] = useState<NormalizedCorners>(() =>
		parseCorners(record?.sleeveCornersJson),
	);
	// Whether the professional-photo editor modal is open (crop + live preview + knobs).
	const [editorOpen, setEditorOpen] = useState(false);
	// The editor's "Use as cover" toggle — pre-checked on open so applying an edit
	// promotes it to the shown cover by default (uncheck to keep it un-approved).
	const [useAsCover, setUseAsCover] = useState(true);
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
			setCorners(parseCorners(row.sleeveCornersJson));
			setParams(parseReframeParams(row.professionalParamsJson));
			setUseAsCover(true);
			setEditorOpen(true);
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

	// The free interactive reframe: warp the capture to the current corners + knobs.
	// Synchronous — the server returns the updated row, which we drop straight into the
	// cache so the preview updates in place (no queue, no polling).
	const reframePro = useMutation({
		mutationFn: (input: {
			corners: NormalizedCorners;
			params: ReframeParams;
		}) => reframeRecord({ data: { id: recordId, ...input } }),
		onSuccess: (row) => {
			if (row)
				queryClient.setQueryData(recordQueryOptions(recordId).queryKey, row);
		},
		onError: (err) =>
			toast.error(
				err instanceof Error ? err.message : "Couldn't apply the changes.",
			),
	});

	// First-pass generation for a record that has no professional photo yet (captured
	// before auto-generation, or a prior failure). Detects the sleeve, warps and tones —
	// synchronously — so opening the editor always has something to preview and tweak.
	const generateFirst = useMutation({
		mutationFn: () => generateProfessional({ data: recordId }),
		onSuccess: (row) => {
			if (!row) return;
			queryClient.setQueryData(recordQueryOptions(recordId).queryKey, row);
			// Adopt the detected crop so the editor + live preview reflect it.
			setCorners(parseCorners(row.sleeveCornersJson));
			setParams(parseReframeParams(row.professionalParamsJson));
		},
		onError: (err) =>
			toast.error(
				err instanceof Error
					? err.message
					: "Couldn't generate the professional photo.",
			),
	});

	// Apply the edit: warp the capture to the current corners + tone, set whether it's
	// used as the cover (the modal's checkbox), then dismiss the editor.
	const applyPro = useMutation({
		mutationFn: async () => {
			await reframeRecord({ data: { id: recordId, corners, params } });
			return setProfessionalApproved({
				data: { id: recordId, approved: useAsCover },
			});
		},
		onSuccess: async (row) => {
			if (row)
				queryClient.setQueryData(recordQueryOptions(recordId).queryKey, row);
			await invalidate();
			setEditorOpen(false);
		},
		onError: (err) =>
			toast.error(
				err instanceof Error ? err.message : "Couldn't apply the changes.",
			),
	});

	// Open the editor, syncing the working copies to the row and seeding a first pass if
	// the record has never been cropped (so the preview pane isn't empty). "Use as cover"
	// starts checked — editing implies you want to show the result.
	const openEditor = () => {
		setCorners(parseCorners(record?.sleeveCornersJson));
		setParams(parseReframeParams(record?.professionalParamsJson));
		setUseAsCover(true);
		setEditorOpen(true);
		if (!record?.professionalImageKey && !generateFirst.isPending) {
			generateFirst.mutate();
		}
	};

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

	// Professional-photo derived state. Generation is synchronous, so there's no "busy"
	// queue state to poll — the editor's own mutations report their progress. `p` merges
	// the working-copy params over the defaults so the sliders always have a concrete value.
	const p = { ...DEFAULT_REFRAME_PARAMS, ...params };

	// Cover preview source, best-first: the freshly downloaded full-res artwork,
	// then the picked candidate's thumbnail (instant, while the full-res loads or
	// if it failed), then the stored cover when nothing is picked. Discogs-only —
	// shown inside the Discogs section, never used as the record's display image.
	const coverPreviewSrc =
		coverProbe.status === "ready"
			? coverProbe.url
			: (picked?.thumb ??
				(record.coverImageKey ? `/api/photos/${record.coverImageKey}` : null));
	// Header photo: the approved professional crop, else the raw capture. Never the
	// Discogs cover (see displayCoverKey) — that stays in the Discogs section only.
	const headerCoverKey = displayCoverKey(record, { includeCapture: true });
	const headerPhotoSrc = headerCoverKey
		? `/api/photos/${headerCoverKey}`
		: null;

	return (
		<div className="mx-auto max-w-2xl space-y-6">
			<div>
				<Link
					to="/admin"
					className="text-sm text-brand underline underline-offset-4 hover:text-brand-strong"
				>
					← Collection
				</Link>
				{/* Photo, text and badges share one bottom baseline (items-end) so the
				    status badge sits opposite the Context line rather than the title. */}
				<div className="mt-3 flex items-end gap-4">
					{headerPhotoSrc && (
						<ImageZoom
							src={headerPhotoSrc}
							alt="Record photo"
							className="size-24 shrink-0"
						/>
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
						{record.captureContext && (
							<p className="mt-1 text-sm text-muted-foreground">
								<span className="font-medium text-foreground">Context:</span>{" "}
								{record.captureContext}
							</p>
						)}
					</div>
					<div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
						{record.status === "review" && !record.discogsId && (
							<UnmatchedBadge />
						)}
						{record.duplicateOf != null && <DuplicateBadge />}
						<StatusBadge status={record.status} />
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
						variant="outline"
						disabled={replacingCapture}
						onClick={() => captureInputRef.current?.click()}
					>
						{replacingCapture ? "Replacing…" : "Replace capture"}
					</Button>
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={openEditor}
					>
						Edit image
					</Button>
					{record.professionalStatus === "failed" &&
						record.professionalError && (
							<span className="text-xs text-red-600 dark:text-red-400">
								Last generation failed: {record.professionalError}. Open the
								editor and adjust the corners to try again.
							</span>
						)}
				</div>
			)}

			{/* The editor: crop on the left, live output on the right, knobs below.
			    "Use as cover" (footer checkbox) controls whether Apply promotes it. */}
			{!inFlight && record.capturePhotoKey && (
				<Dialog open={editorOpen} onOpenChange={setEditorOpen}>
					<DialogContent className="max-w-5xl">
						<DialogHeader>
							<DialogTitle>Edit image</DialogTitle>
							<DialogDescription>
								Drag the corners to the sleeve’s edges (or auto-detect), then
								tune the tone — the preview updates live. Apply saves it.
							</DialogDescription>
						</DialogHeader>

						<div className="grid gap-4 sm:grid-cols-2">
							<div className="space-y-1">
								<p className="text-xs font-medium text-muted-foreground">
									Crop
								</p>
								<CornerEditor
									src={`/api/photos/${record.capturePhotoKey}`}
									value={corners}
									onChange={setCorners}
									onDetect={async () => {
										const res = await detectCorners({ data: recordId });
										return res.corners;
									}}
									disabled={reframePro.isPending}
								/>
							</div>
							<div className="space-y-1">
								<div className="flex items-baseline justify-between">
									<p className="text-xs font-medium text-muted-foreground">
										Preview
									</p>
									<p className="text-[10px] text-muted-foreground/70">
										Live · Apply to save
									</p>
								</div>
								{record.capturePhotoKey && (
									<ProPreview
										src={`/api/photos/${record.capturePhotoKey}`}
										corners={corners}
										params={params}
									/>
								)}
							</div>
						</div>

						{/* Tone knobs. Auto-tone is the smart, foreground-aware baseline;
						    the polish factors below map straight to the pixel encode pass.
						    Every Apply re-warps + re-tones — all free. */}
						<div className="space-y-3 rounded-md border bg-muted/30 p-3">
							<label
								htmlFor="pro-autotone"
								className="flex items-center gap-2 text-xs text-muted-foreground"
							>
								<Checkbox
									id="pro-autotone"
									checked={!p.skipTone}
									disabled={reframePro.isPending}
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
									disabled={p.skipTone || reframePro.isPending}
									onChange={(v) =>
										setParams({ ...params, wbStrength: v / 100 })
									}
								/>
								<Knob
									label="Saturation"
									display={`${Math.round(p.saturation * 100)}%`}
									value={Math.round(p.saturation * 100)}
									min={0}
									max={200}
									step={5}
									disabled={reframePro.isPending}
									onChange={(v) =>
										setParams({ ...params, saturation: v / 100 })
									}
								/>
								<Knob
									label="Contrast"
									display={`${Math.round(p.contrast * 100)}%`}
									value={Math.round(p.contrast * 100)}
									min={50}
									max={200}
									step={5}
									disabled={reframePro.isPending}
									onChange={(v) => setParams({ ...params, contrast: v / 100 })}
								/>
								<Knob
									label="Gamma"
									display={p.gamma.toFixed(2)}
									value={Math.round(p.gamma * 100)}
									min={50}
									max={200}
									step={5}
									disabled={reframePro.isPending}
									onChange={(v) => setParams({ ...params, gamma: v / 100 })}
								/>
							</div>
						</div>

						{/* Use-as-cover on the left; Reset + Apply on the right (Apply last).
						    Apply saves the crop/tone, sets approval, and dismisses. */}
						<DialogFooter className="items-center justify-between sm:justify-between">
							<label
								htmlFor="pro-usecover"
								className="flex items-center gap-2 text-sm"
							>
								<Checkbox
									id="pro-usecover"
									checked={useAsCover}
									disabled={applyPro.isPending}
									onChange={(e) => setUseAsCover(e.currentTarget.checked)}
								/>
								Use as cover
							</label>
							<div className="flex gap-2">
								<Button
									type="button"
									size="sm"
									variant="ghost"
									disabled={reframePro.isPending || applyPro.isPending}
									onClick={() => {
										setParams({});
										setCorners(DEFAULT_CORNERS);
										reframePro.mutate({
											corners: DEFAULT_CORNERS,
											params: {},
										});
									}}
								>
									Reset
								</Button>
								<Button
									type="button"
									size="sm"
									disabled={applyPro.isPending}
									onClick={() => applyPro.mutate()}
								>
									{applyPro.isPending ? "Applying…" : "Apply"}
								</Button>
							</div>
						</DialogFooter>
					</DialogContent>
				</Dialog>
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

						{/* Wrong match? The sourced cover sits to the left of the search /
						    paste-a-URL controls. */}
						<div className="flex gap-3 p-3">
							{coverPreviewSrc && (
								<div className="flex shrink-0 flex-col gap-2">
									<figure className="space-y-1">
										<ImageZoom
											src={coverPreviewSrc}
											alt={picked ? "Selected Discogs cover" : "Sourced cover"}
											className="size-32"
										/>
										<figcaption className="text-xs text-muted-foreground">
											{picked ? "Discogs (selected)" : "Discogs"}
										</figcaption>
									</figure>
								</div>
							)}
							<div className="min-w-0 flex-1 space-y-3">
								<div
									role="tablist"
									aria-label="Discogs lookup method"
									className="flex gap-1 border-b"
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
