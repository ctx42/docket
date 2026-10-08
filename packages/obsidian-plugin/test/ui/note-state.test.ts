// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import type { PreflightEntry, StatusReport } from "@docket/core";
import { describe, expect, it } from "vitest";
import { type NoteFacts, noteState } from "../../src/ui/note-state.ts";

const synced = {
    docket_page_id: "1",
    docket_page_version: 3,
    docket_mode: "pull",
};

const entry = (cls: PreflightEntry["cls"], reason = ""): PreflightEntry => ({
    dest: "wiki/A.md",
    name: "A.md",
    pageId: "1",
    localBase: 3,
    remoteVersion: 5,
    cls,
    reason,
    resolves: [],
});

const empty: StatusReport = {
    push: [],
    pull: [],
    diverged: [],
    warnings: [],
    ignored: [],
};

/** facts builds the card facts for wiki/A.md with the given overrides. */
function facts(over: Partial<NoteFacts>): NoteFacts {
    return {
        dest: "wiki/A.md",
        fm: synced,
        inSyncRoot: true,
        conflicts: false,
        mtime: 100,
        status: null,
        ...over,
    };
}

describe("noteState", () => {
    it("calls a note without a page id unsynced", () => {
        const have = noteState(facts({ fm: { tags: ["x"] } }));

        expect(have.kind).toBe("unsynced");
        expect(have.actions).toEqual([]);
    });

    it("calls a note marked never-push ignored", () => {
        const have = noteState(
            facts({ fm: { ...synced, docket_mode: "ignore-push" } }),
        );

        expect(have.kind).toBe("ignored");
        expect(have.label).toBe("Ignored by push");
    });

    it("calls a synced note unknown before any status check", () => {
        const have = noteState(facts({}));

        expect(have.kind).toBe("unknown");
        expect(have.detail).toBe("Check status to compare with Confluence");
    });

    it("calls a titled note under the sync root new", () => {
        const have = noteState(facts({ fm: { title: "T" } }));

        expect(have.kind).toBe("new");
    });

    it("puts conflict markers before the report", () => {
        const status = {
            report: { ...empty, push: [entry("modified")] },
            at: 200,
        };

        const have = noteState(facts({ conflicts: true, status }));

        expect(have.kind).toBe("conflict");
        expect(have.primary).toBeNull();
    });

    it.each([
        ["modified", "push", "edited", "push"],
        ["refused", "push", "refused", "discard"],
        ["remote-moved", "pull", "incoming", "pull"],
        ["diverged", "diverged", "diverged", "push"],
        ["skip", "warnings", "unchecked", null],
    ] as const)("maps a %s entry in %s to %s", (cls, list, kind, primary) => {
        const status = {
            report: { ...empty, [list]: [entry(cls, "why")] },
            at: 200,
        };

        const have = noteState(facts({ status }));

        expect(have.kind).toBe(kind);
        expect(have.primary).toBe(primary);
    });

    it("is up to date when the report lists nothing and no edit followed", () => {
        const have = noteState(facts({ status: { report: empty, at: 200 } }));

        expect(have.kind).toBe("synced");
        expect(have.version).toBe(3);
    });

    it("flags an edit made after the report", () => {
        const have = noteState(
            facts({ mtime: 300, status: { report: empty, at: 200 } }),
        );

        expect(have.kind).toBe("unknown");
        expect(have.label).toBe("Edited since the last check");
    });

    it("offers no push as primary on an ignore-push note", () => {
        const fm = { ...synced, docket_mode: "ignore-push" };
        const status = {
            report: { ...empty, diverged: [entry("diverged")] },
            at: 200,
        };

        const have = noteState(facts({ fm, status }));

        expect(have.primary).toBeNull();
        expect(have.actions).toEqual(["pull", "discard"]);
    });
});
