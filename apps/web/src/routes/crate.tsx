import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

import type { PublicRecord } from "#/lib/records";
import { recordIdParam } from "#/lib/records-path";
import { publicRecordsQueryOptions } from "#/lib/records-queries";

/**
 * Prototype: browse the collection as a 3D crate (three.js via React Three
 * Fiber + drei). Exploratory — not linked from the main page. The scene is
 * lazy-loaded so three.js never lands in the main bundle, and client-only
 * (WebGL has no SSR story). `?stats` shows a frame meter.
 */
export const Route = createFileRoute("/crate")({
	loader: ({ context }) =>
		context.queryClient.ensureQueryData(publicRecordsQueryOptions),
	head: () => ({ meta: [{ title: "Crate · Records" }] }),
	component: CratePage,
});

const CrateScene = lazy(() => import("#/components/crate/crate-scene"));

/** Wheel pixels per record flipped. */
const WHEEL_PX_PER_RECORD = 90;
/** Drag pixels per record flipped. */
const DRAG_PX_PER_RECORD = 40;
/** Settle on the nearest whole record this long after input stops. */
const SNAP_DELAY_MS = 140;

function CratePage() {
	const { data: allRecords } = useSuspenseQuery(publicRecordsQueryOptions);
	// Records with an approved photo only — a crate of grey placeholders isn't
	// much of a dig.
	const [records] = useState(() =>
		allRecords.filter(
			(r) => r.professionalStatus === "approved" && r.professionalImageKey,
		),
	);
	const navigate = useNavigate();
	const targetRef = useRef(0);
	const [current, setCurrent] = useState(0);
	const [mounted, setMounted] = useState(false);
	const [background, setBackground] = useState("#171717");
	const [showStats, setShowStats] = useState(false);
	const snapTimer = useRef<number | null>(null);

	useEffect(() => {
		setMounted(true);
		setBackground(getComputedStyle(document.body).backgroundColor);
		setShowStats(new URLSearchParams(window.location.search).has("stats"));
	}, []);

	const max = records.length - 1;
	const setTarget = useCallback(
		(next: number, snap = true) => {
			targetRef.current = Math.min(max, Math.max(0, next));
			if (snapTimer.current != null) window.clearTimeout(snapTimer.current);
			if (snap) {
				snapTimer.current = window.setTimeout(() => {
					targetRef.current = Math.round(targetRef.current);
				}, SNAP_DELAY_MS);
			}
		},
		[max],
	);

	const open = useCallback(
		(record: PublicRecord) =>
			navigate({ to: "/records/$id", params: { id: recordIdParam(record) } }),
		[navigate],
	);

	// Wheel + keyboard on the window; drag on the canvas wrapper below.
	useEffect(() => {
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			setTarget(targetRef.current + e.deltaY / WHEEL_PX_PER_RECORD);
		};
		const onKey = (e: KeyboardEvent) => {
			const step =
				e.key === "ArrowDown" || e.key === "ArrowRight" || e.key === "j"
					? 1
					: e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "k"
						? -1
						: 0;
			if (step) {
				e.preventDefault();
				setTarget(Math.round(targetRef.current) + step);
			} else if (e.key === "Enter") {
				open(records[Math.round(targetRef.current)]);
			}
		};
		window.addEventListener("wheel", onWheel, { passive: false });
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("wheel", onWheel);
			window.removeEventListener("keydown", onKey);
		};
	}, [setTarget, open, records]);

	const drag = useRef<{ y: number; start: number; moved: boolean } | null>(
		null,
	);

	const record = records[current];

	return (
		<div
			className="fixed inset-0 overflow-hidden"
			onPointerDown={(e) => {
				drag.current = {
					y: e.clientY,
					start: targetRef.current,
					moved: false,
				};
			}}
			onPointerMove={(e) => {
				if (!drag.current) return;
				const dy = drag.current.y - e.clientY;
				if (Math.abs(dy) > 4) drag.current.moved = true;
				setTarget(drag.current.start + dy / DRAG_PX_PER_RECORD, false);
			}}
			onPointerUp={() => {
				if (drag.current?.moved) setTarget(targetRef.current);
				drag.current = null;
			}}
			onPointerCancel={() => {
				drag.current = null;
			}}
			// A drag that moved shouldn't also count as a click on a record.
			onClickCapture={(e) => {
				if (drag.current?.moved) e.stopPropagation();
			}}
		>
			{mounted && records.length > 0 && (
				<Suspense fallback={null}>
					<CrateScene
						records={records}
						targetRef={targetRef}
						onSelectIndex={(i) => setTarget(i)}
						onCurrentChange={setCurrent}
						onOpen={open}
						background={background}
						showStats={showStats}
					/>
				</Suspense>
			)}

			<Link
				to="/"
				className="fixed top-4 left-4 rounded-full border bg-background/80 px-3 py-1.5 font-mono text-muted-foreground text-xs backdrop-blur-sm hover:text-foreground"
			>
				← Grid
			</Link>

			{record && (
				<div className="pointer-events-none fixed inset-x-0 bottom-6 flex justify-center px-4">
					<div className="flex max-w-[calc(100%-2rem)] flex-col items-center gap-0.5 rounded-md border bg-popover/95 px-4 py-2 text-center text-popover-foreground shadow-lg">
						<p className="text-balance font-serif text-base font-medium leading-tight">
							{record.title}
						</p>
						<p className="font-mono text-muted-foreground text-xs">
							{record.artist}
							{record.year ? ` · ${record.year}` : ""}
							<span className="ml-2 opacity-60">
								{current + 1}/{records.length}
							</span>
						</p>
					</div>
				</div>
			)}

			<p className="pointer-events-none fixed top-5 right-4 font-mono text-[11px] text-muted-foreground">
				scroll / drag / ↑↓ to dig · click to open
			</p>
		</div>
	);
}
