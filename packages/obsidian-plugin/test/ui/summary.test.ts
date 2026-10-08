// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import type { PreflightEntry, StatusReport } from "@docket/core";
import { describe, expect, it } from "vitest";
import type { RunState } from "../../src/ui/run-state.ts";
import {
    ago,
    barText,
    needsAttention,
    needsSettings,
    runSummary,
} from "../../src/ui/summary.ts";

/** run builds a finished RunState with the given overrides. */
function run(over: Partial<RunState>): RunState {
    return {
        verb: "pulling",
        phase: "done",
        found: 0,
        total: 0,
        pos: 0,
        current: "",
        rows: [],
        counts: { ok: 0, warn: 0, err: 0 },
        tally: null,
        errorText: "",
        ...over,
    };
}

const tally = { added: 0, updated: 2, unchanged: 9, conflict: 1, deleted: 0 };

/** report builds a status report with `n` entries in each named section. */
function report(
    over: Partial<Record<keyof StatusReport, number>>,
): StatusReport {
    const entries = (n = 0): PreflightEntry[] =>
        Array.from({ length: n }, () => ({}) as PreflightEntry);
    return {
        push: entries(over.push),
        pull: entries(over.pull),
        diverged: entries(over.diverged),
        warnings: entries(over.warnings),
        ignored: [],
    } as unknown as StatusReport;
}

describe("runSummary", () => {
    it("words a pull's non-zero outcomes", () => {
        const have = runSummary(run({ tally }));

        expect(have).toBe("Pulled: 2 updated · 1 conflict · 9 unchanged");
    });

    it("words a push", () => {
        const s = run({ verb: "pushing", counts: { ok: 1, warn: 0, err: 2 } });

        const have = runSummary(s);

        expect(have).toBe("Pushed: 1 pushed · 2 refused");
    });

    it("says when nothing happened", () => {
        const have = runSummary(run({ verb: "applying" }));

        expect(have).toBe("Applied: nothing to do");
    });

    it("reports a failed run", () => {
        const s = run({ verb: "discarding", phase: "error", errorText: "x" });

        const have = runSummary(s);

        expect(have).toBe("Discarded failed: x");
    });
});

describe("needsAttention", () => {
    it.each([
        ["a conflict", run({ tally }), true],
        ["a failure", run({ counts: { ok: 0, warn: 0, err: 1 } }), true],
        ["an error phase", run({ phase: "error" }), true],
        ["a clean push", run({ counts: { ok: 3, warn: 0, err: 0 } }), false],
    ])("is %s → %s", (_, s, want) => {
        const have = needsAttention(s);

        expect(have).toBe(want);
    });
});

describe("barText", () => {
    it("shows progress while busy", () => {
        const s = run({ phase: "processing", pos: 3, total: 12 });

        const have = barText(s, true, null);

        expect(have).toBe("3/12");
    });

    it("shows an ellipsis while discovering", () => {
        const have = barText(run({ phase: "discovering" }), true, null);

        expect(have).toBe("…");
    });

    it("shows the last report's counts when idle", () => {
        const have = barText(
            null,
            false,
            report({ push: 2, pull: 1, diverged: 1 }),
        );

        expect(have).toBe("↑2 ↓1 ⇅1");
    });

    it("shows a check for a clean report", () => {
        const have = barText(null, false, report({}));

        expect(have).toBe("✓");
    });

    it("is empty with no report", () => {
        const have = barText(null, false, null);

        expect(have).toBe("");
    });
});

describe("needsSettings", () => {
    it.each([
        ["config: site is required", true],
        ["authentication rejected by https://x (HTTP 401)", true],
        ["fetching page 1: HTTP 403", true],
        ["fetching page 1: HTTP 503", false],
        ["not a managed page: a.md", false],
    ])("%s → %s", (msg, want) => {
        const have = needsSettings(msg);

        expect(have).toBe(want);
    });
});

describe("ago", () => {
    it.each([
        [10_000, "just now"],
        [3 * 60_000, "3 min ago"],
        [2 * 3_600_000, "2 h ago"],
        [3 * 86_400_000, "3 d ago"],
    ])("renders %i ms as %s", (age, want) => {
        const have = ago(1_000_000_000 - age, 1_000_000_000);

        expect(have).toBe(want);
    });
});
