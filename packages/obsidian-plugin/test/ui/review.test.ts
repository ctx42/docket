// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import type { PreflightEntry, StatusReport } from "@docket/core";
import { describe, expect, it } from "vitest";
import {
    changeGroups,
    type NewChoice,
    reviewCommit,
    reviewModel,
    statusSections,
    statusText,
} from "../../src/ui/review.ts";

const entry = (
    name: string,
    cls: PreflightEntry["cls"],
    reason = "",
): PreflightEntry => ({
    dest: `/v/${name}`,
    name,
    pageId: "1",
    localBase: 3,
    remoteVersion: cls === "diverged" || cls === "remote-moved" ? 5 : 3,
    cls,
    reason,
    resolves: [],
});

describe("reviewModel", () => {
    it("hides notes a push would not change and locks refused ones", () => {
        const have = reviewModel([
            entry("same.md", "unchanged"),
            entry("behind.md", "remote-moved"),
            entry("edited.md", "modified"),
            entry("both.md", "diverged"),
            entry("new.md", "new"),
            entry("bad.md", "refused", "conflict markers"),
        ]);

        expect(have.hidden).toBe(2);
        expect(have.rows.map((r) => [r.entry.name, r.control])).toEqual([
            ["edited.md", "pick"],
            ["both.md", "pick"],
            ["new.md", "new"],
            ["bad.md", "locked"],
        ]);
        expect(have.rows[3]?.note).toContain("conflict markers");
    });

    it("locks a note it could not check", () => {
        const have = reviewModel([entry("odd.md", "skip", "no page id")]);

        expect(have.rows).toEqual([
            {
                entry: entry("odd.md", "skip", "no page id"),
                control: "locked",
                kind: "err",
                note: "Not checked: no page id",
            },
        ]);
    });
});

describe("reviewCommit", () => {
    it("pushes ticked notes and created new ones, marking never ones", () => {
        const answers = new Map<string, NewChoice>([
            ["/v/a.md", "create"],
            ["/v/b.md", "never"],
            ["/v/c.md", "later"],
        ]);

        const have = reviewCommit(new Set(["/v/edited.md"]), answers);

        expect(have).toEqual({
            push: ["/v/edited.md", "/v/a.md"],
            never: ["/v/b.md"],
        });
    });

    it("creates nothing for new notes left untouched", () => {
        const have = reviewCommit(new Set(), new Map());

        expect(have).toEqual({ push: [], never: [] });
    });
});

describe("statusSections", () => {
    const report: StatusReport = {
        push: [entry("new.md", "new"), entry("bad.md", "refused", "why")],
        pull: [entry("behind.md", "remote-moved")],
        diverged: [],
        warnings: [],
        ignored: ["/v/mine.md"],
    };

    it("lists non-empty sections in order, hiding ignored by default", () => {
        const have = statusSections(report, "/v", false);

        expect(have.map((s) => s.title)).toEqual(["To push", "To pull"]);
        expect(have[0]?.lines[1]).toEqual({
            name: "bad.md",
            word: "refused",
            detail: "why",
        });
        expect(have[1]?.lines[0]?.detail).toBe("local v3 → remote v5");
    });

    it("lists diverged notes and failed checks", () => {
        const have = statusSections(
            {
                ...report,
                diverged: [entry("both.md", "diverged")],
                warnings: [entry("odd.md", "skip", "timeout")],
            },
            "/v",
            false,
        );

        expect(have.slice(2)).toEqual([
            {
                title: "Diverged",
                lines: [
                    {
                        name: "both.md",
                        word: "diverged",
                        detail: "local v3 → remote v5, local edits",
                    },
                ],
            },
            {
                title: "Could not check",
                lines: [{ name: "odd.md", word: "warning", detail: "timeout" }],
            },
        ]);
    });

    it("lists ignored notes when asked", () => {
        const have = statusSections(report, "/v", true);

        expect(have.map((s) => s.title)).toContain("Ignored");
        expect(have.find((s) => s.title === "Ignored")?.lines[0]?.name).toBe(
            "mine.md",
        );
    });
});

describe("statusText", () => {
    it("renders sections as copyable plain text", () => {
        const have = statusText([
            {
                title: "To push",
                lines: [
                    { name: "a.md", word: "modified", detail: "" },
                    { name: "b.md", word: "refused", detail: "why" },
                ],
            },
            {
                title: "To pull",
                lines: [{ name: "c.md", word: "remote", detail: "v1 → v2" }],
            },
        ]);

        expect(have).toBe(
            "To push (2):\n  modified  a.md\n  refused  b.md  why\n" +
                "\nTo pull (1):\n  remote  c.md  v1 → v2\n",
        );
    });
});

describe("changeGroups", () => {
    it("groups a report in action order, conflicts apart from problems", () => {
        const r: StatusReport = {
            push: [
                entry("edited.md", "modified"),
                entry("new.md", "new"),
                entry("marked.md", "refused", "unresolved conflict markers"),
                entry("bad.md", "refused", "unsupported edit"),
            ],
            pull: [entry("behind.md", "remote-moved")],
            diverged: [entry("both.md", "diverged")],
            warnings: [entry("gone.md", "skip", "page not found")],
            ignored: ["/v/quiet.md"],
        };

        const have = changeGroups(r, "/v", false);

        expect(have.map((g) => [g.id, g.rows.map((x) => x.name)])).toEqual([
            ["conflicts", ["marked.md"]],
            ["outgoing", ["edited.md"]],
            ["new", ["new.md"]],
            ["incoming", ["behind.md"]],
            ["diverged", ["both.md"]],
            ["problems", ["bad.md", "gone.md"]],
        ]);
        const incoming = have.find((g) => g.id === "incoming")?.rows[0];
        expect(incoming?.detail).toBe("v3 → v5");
        expect(incoming?.row?.kind).toBe("remote");
        const gone = have.find((g) => g.id === "problems")?.rows[1];
        expect(gone?.row).toBeNull();
    });

    it("lists ignored notes only on request", () => {
        const r: StatusReport = {
            push: [],
            pull: [],
            diverged: [],
            warnings: [],
            ignored: ["/v/quiet.md"],
        };

        const have = changeGroups(r, "/v", true);

        expect(have.map((g) => g.id)).toEqual(["ignored"]);
        expect(have[0]?.rows[0]?.name).toBe("quiet.md");
        expect(have[0]?.rows[0]?.row?.kind).toBe("ignored");
    });
});
