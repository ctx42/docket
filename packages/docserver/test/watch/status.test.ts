// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { CloseReplacedError } from "../../src/engine/engine.ts";
import { IndexTracker, type Reindexable } from "../../src/watch/status.ts";

/** FakeIndex is an engine whose reload can be held, failed, or counted. */
class FakeIndex implements Reindexable {
    gen = 0;
    docs = 2;
    fail: Error | undefined;
    hold: Promise<void> | undefined;

    async reload(): Promise<void> {
        await this.hold;
        if (
            this.fail !== undefined &&
            !(this.fail instanceof CloseReplacedError)
        )
            throw this.fail;
        this.gen++;
        this.docs++;
        if (this.fail !== undefined) throw this.fail;
    }

    listDocs(): readonly unknown[] {
        return Array.from({ length: this.docs });
    }

    generation(): number {
        return this.gen;
    }
}

/** clock returns a clock at ms, moved by setting its at field. */
function clock(ms: number): { at: number; now: () => number } {
    const c = { at: ms, now: () => c.at };
    return c;
}

describe("IndexTracker", () => {
    it("reports the first index as built when it was made", () => {
        // --- Given ---
        const c = clock(Date.UTC(2026, 10, 18, 10));

        // --- When ---
        const have = new IndexTracker(new FakeIndex(), c.now, true).state();

        // --- Then ---
        expect(have).toEqual({
            generation: 0,
            indexedAt: "2026-11-18T10:00:00.000Z",
            docs: 2,
            watching: true,
            pending: false,
            lastError: "",
        });
    });

    it("marks a change pending until a reindex", async () => {
        // --- Given ---
        const c = clock(Date.UTC(2026, 10, 18, 10));
        const trk = new IndexTracker(new FakeIndex(), c.now, true);

        // --- When ---
        trk.signal();
        const before = trk.state().pending;
        c.at += 60_000;
        const res = await trk.reindex();

        // --- Then ---
        expect(before).toBe(true);
        expect(res).toEqual({ ok: true, docs: 3, warning: "" });
        expect(trk.state()).toMatchObject({
            generation: 1,
            indexedAt: "2026-11-18T10:01:00.000Z",
            docs: 3,
            pending: false,
        });
    });

    it("keeps a change that came during a reindex pending", async () => {
        // --- Given ---
        const idx = new FakeIndex();
        let release = (): void => {};
        idx.hold = new Promise<void>((r) => {
            release = r;
        });
        const trk = new IndexTracker(idx, () => 0, true);
        trk.signal();

        // --- When ---
        const run = trk.reindex();
        trk.signal();
        release();
        await run;

        // --- Then ---
        expect(trk.state().pending).toBe(true);
    });

    it("records a failed reindex and keeps the change pending", async () => {
        // --- Given ---
        const idx = new FakeIndex();
        idx.fail = new Error("bad front matter");
        const trk = new IndexTracker(idx, () => 0, false);
        trk.signal();

        // --- When ---
        const res = await trk.reindex();

        // --- Then ---
        expect(res).toEqual({
            ok: false,
            docs: 2,
            warning: "bad front matter",
        });
        expect(trk.state()).toMatchObject({
            generation: 0,
            pending: true,
            lastError: "bad front matter",
        });
    });

    it("counts a reindex that failed only to close the old index", async () => {
        // --- Given ---
        const idx = new FakeIndex();
        idx.fail = new CloseReplacedError(new Error("busy"));
        const trk = new IndexTracker(idx, () => 0, false);

        // --- When ---
        const res = await trk.reindex();

        // --- Then ---
        expect(res.ok).toBe(true);
        expect(res.warning).toContain("busy");
        expect(trk.state()).toMatchObject({ generation: 1, lastError: "" });
    });

    it("clears the last error after a good reindex", async () => {
        // --- Given ---
        const idx = new FakeIndex();
        idx.fail = new Error("bad");
        const trk = new IndexTracker(idx, () => 0, false);
        await trk.reindex();
        idx.fail = undefined;

        // --- When ---
        await trk.reindex();

        // --- Then ---
        expect(trk.state().lastError).toBe("");
    });
});
