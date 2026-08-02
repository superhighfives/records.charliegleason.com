import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/db", () => ({ getDb: vi.fn() }));
vi.mock("#/db/schema", () => ({ records: {} }));
vi.mock("#/lib/discogs", () => ({
	checkMasterLiveness: vi.fn(),
	checkReleaseLiveness: vi.fn(),
}));
vi.mock("@sentry/tanstackstart-react", () => ({
	startSpan: vi.fn((_opts: unknown, fn: () => Promise<unknown>) => fn()),
}));

import { getDb } from "#/db";
import { checkMasterLiveness, checkReleaseLiveness } from "#/lib/discogs";
import { runLinkHealthCheck } from "./master-health";

const zero = { checked: 0, gone: 0, live: 0, inconclusive: 0 };

describe("runLinkHealthCheck", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	// The job runs two selects — masters first, then releases. The mock hands the
	// first select() the master rows and the second the release rows, so each pass
	// can be exercised independently. Rows are the `{ id, linkId }` shape the job
	// selects (masterId / discogsId aliased to linkId).
	const makeDb = (
		masterRows: Array<{ id: string; linkId: string | null }>,
		releaseRows: Array<{ id: string; linkId: string | null }>,
	) => {
		const updateWhere = vi.fn().mockResolvedValue(undefined);
		const updateChain = { set: () => ({ where: updateWhere }) };
		let selectCall = 0;
		const makeSelectChain = (rows: unknown) => {
			const chain: Record<string, unknown> = {};
			for (const m of ["from", "where", "orderBy"]) chain[m] = () => chain;
			chain.limit = vi.fn().mockResolvedValue(rows);
			return chain;
		};
		const db = {
			select: () =>
				makeSelectChain(selectCall++ === 0 ? masterRows : releaseRows),
			update: () => updateChain,
		};
		(getDb as ReturnType<typeof vi.fn>).mockReturnValue(db);
		return { updateWhere };
	};

	it("counts an inconclusive master and skips the DB update", async () => {
		const { updateWhere } = makeDb([{ id: "1", linkId: "98765" }], []);
		(checkMasterLiveness as ReturnType<typeof vi.fn>).mockResolvedValue(
			"inconclusive",
		);

		const result = await runLinkHealthCheck();

		expect(result.masters).toEqual({
			checked: 1,
			gone: 0,
			live: 0,
			inconclusive: 1,
		});
		expect(result.releases).toEqual(zero);
		expect(updateWhere).not.toHaveBeenCalled();
	});

	it("marks a record missing on a 'gone' master", async () => {
		const { updateWhere } = makeDb([{ id: "2", linkId: "00000" }], []);
		(checkMasterLiveness as ReturnType<typeof vi.fn>).mockResolvedValue("gone");

		const result = await runLinkHealthCheck();

		expect(result.masters).toEqual({
			checked: 1,
			gone: 1,
			live: 0,
			inconclusive: 0,
		});
		expect(updateWhere).toHaveBeenCalledTimes(1);
	});

	it("clears the flag on a 'live' master", async () => {
		const { updateWhere } = makeDb([{ id: "3", linkId: "12345" }], []);
		(checkMasterLiveness as ReturnType<typeof vi.fn>).mockResolvedValue("live");

		const result = await runLinkHealthCheck();

		expect(result.masters).toEqual({
			checked: 1,
			gone: 0,
			live: 1,
			inconclusive: 0,
		});
		expect(updateWhere).toHaveBeenCalledTimes(1);
	});

	it("validates releases too — a 'gone' release is flagged", async () => {
		const { updateWhere } = makeDb([], [{ id: "5", linkId: "30268103" }]);
		(checkReleaseLiveness as ReturnType<typeof vi.fn>).mockResolvedValue(
			"gone",
		);

		const result = await runLinkHealthCheck();

		expect(result.masters).toEqual(zero);
		expect(result.releases).toEqual({
			checked: 1,
			gone: 1,
			live: 0,
			inconclusive: 0,
		});
		expect(checkReleaseLiveness).toHaveBeenCalledWith("30268103");
		expect(updateWhere).toHaveBeenCalledTimes(1);
	});

	it("skips rows with a null link without checking liveness", async () => {
		const { updateWhere } = makeDb([{ id: "4", linkId: null }], []);

		const result = await runLinkHealthCheck();

		expect(result.masters).toEqual(zero);
		expect(checkMasterLiveness).not.toHaveBeenCalled();
		expect(updateWhere).not.toHaveBeenCalled();
	});
});
