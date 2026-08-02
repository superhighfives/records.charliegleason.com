import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/db", () => ({ getDb: vi.fn() }));
vi.mock("#/db/schema", () => ({ records: {} }));
vi.mock("#/lib/discogs", () => ({ checkMasterLiveness: vi.fn() }));
vi.mock("@sentry/tanstackstart-react", () => ({
	startSpan: vi.fn((_opts: unknown, fn: () => Promise<unknown>) => fn()),
}));

import { getDb } from "#/db";
import { checkMasterLiveness } from "#/lib/discogs";
import { runMasterCheck } from "./master-health";

describe("runMasterCheck", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	const makeDb = (rows: Array<{ id: string; masterId: string }>) => {
		const updateWhere = vi.fn().mockResolvedValue(undefined);
		const updateChain = { set: () => ({ where: updateWhere }) };
		const limit = vi.fn().mockResolvedValue(rows);
		const selectChain: Record<string, unknown> = {};
		for (const m of ["from", "where", "orderBy"]) {
			selectChain[m] = () => selectChain;
		}
		selectChain.limit = limit;
		const db = { select: () => selectChain, update: () => updateChain };
		(getDb as ReturnType<typeof vi.fn>).mockReturnValue(db);
		return { updateWhere };
	};

	it("counts an inconclusive result and skips the DB update", async () => {
		const { updateWhere } = makeDb([{ id: "1", masterId: "98765" }]);
		(checkMasterLiveness as ReturnType<typeof vi.fn>).mockResolvedValue(
			"inconclusive",
		);

		const result = await runMasterCheck();

		expect(result).toEqual({ checked: 1, gone: 0, live: 0, inconclusive: 1 });
		expect(updateWhere).not.toHaveBeenCalled();
	});

	it("marks the record missing and updates checkedAt on 'gone'", async () => {
		const { updateWhere } = makeDb([{ id: "2", masterId: "00000" }]);
		(checkMasterLiveness as ReturnType<typeof vi.fn>).mockResolvedValue("gone");

		const result = await runMasterCheck();

		expect(result).toEqual({ checked: 1, gone: 1, live: 0, inconclusive: 0 });
		expect(updateWhere).toHaveBeenCalledTimes(1);
	});

	it("clears the missing flag and updates checkedAt on 'live'", async () => {
		const { updateWhere } = makeDb([{ id: "3", masterId: "12345" }]);
		(checkMasterLiveness as ReturnType<typeof vi.fn>).mockResolvedValue("live");

		const result = await runMasterCheck();

		expect(result).toEqual({ checked: 1, gone: 0, live: 1, inconclusive: 0 });
		expect(updateWhere).toHaveBeenCalledTimes(1);
	});

	it("skips rows with a null masterId without checking liveness", async () => {
		const { updateWhere } = makeDb([
			{ id: "4", masterId: null as unknown as string },
		]);

		const result = await runMasterCheck();

		expect(result).toEqual({ checked: 0, gone: 0, live: 0, inconclusive: 0 });
		expect(checkMasterLiveness).not.toHaveBeenCalled();
		expect(updateWhere).not.toHaveBeenCalled();
	});
});
