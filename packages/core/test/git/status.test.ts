// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    type GitChange,
    moveCandidates,
    pairMoves,
    parseStatus,
} from "../../src/git/status.ts";

const H = "a".repeat(40);
const I = "b".repeat(40);
const Z = "0".repeat(40);

/** one builds a porcelain v2 `1` record. */
function one(xy: string, path: string, h = H, i = I): string {
    return `1 ${xy} N... 100644 100644 100644 ${h} ${i} ${path}`;
}

/** z joins records the way `-z` output does. */
function z(...recs: string[]): string {
    return `${recs.join("\0")}\0`;
}

/** plain strips the pairing fields from parsed entries. */
function plain(out: string): GitChange[] {
    return pairMoves(parseStatus(out), new Map());
}

describe("parseStatus", () => {
    it("reads modified, deleted, added, and untracked paths", () => {
        const out = z(
            one(".M", "ENG/a b.md"),
            one("D.", "gone.md", H, Z),
            one("A.", "new.md", Z, I),
            "? ENG/fresh.md",
        );

        const have = plain(out);

        expect(have).toEqual([
            {
                path: "ENG/a b.md",
                from: "",
                kind: "M",
                staged: false,
                untracking: false,
            },
            {
                path: "gone.md",
                from: "",
                kind: "D",
                staged: true,
                untracking: true,
            },
            {
                path: "new.md",
                from: "",
                kind: "A",
                staged: true,
                untracking: false,
            },
            {
                path: "ENG/fresh.md",
                from: "",
                kind: "A",
                staged: false,
                untracking: false,
            },
        ]);
    });

    it("marks a partly staged file as staged", () => {
        const have = plain(z(one("MM", "a.md")));

        expect(have[0]?.staged).toBe(true);
        expect(have[0]?.kind).toBe("M");
    });

    it("reads a staged rename with its old path", () => {
        const out = z(
            `2 R. N... 100644 100644 100644 ${H} ${H} R100 B/p.md`,
            "A/p.md",
        );

        const have = plain(out);

        expect(have).toEqual([
            {
                path: "B/p.md",
                from: "A/p.md",
                kind: "R",
                staged: true,
                untracking: false,
            },
        ]);
    });

    it("folds an untracked copy of an untracked-from-index path into its removal", () => {
        const out = z(one("D.", "ig.md", H, Z), "? ig.md");

        const have = plain(out);

        expect(have).toHaveLength(1);
        expect(have[0]?.untracking).toBe(true);
    });

    it("reads an intent-to-add file as added", () => {
        expect(plain(z(one(".A", "x.md", Z, I)))[0]?.kind).toBe("A");
    });

    it("reads a renamed file deleted from disk as deleted", () => {
        const out = z(
            `2 RD N... 100644 100644 000000 ${H} ${H} R100 B/p.md`,
            "A/p.md",
        );

        const have = plain(out);

        expect(have[0]?.kind).toBe("D");
        expect(have[0]?.from).toBe("A/p.md");
    });

    it("reads an unmerged path as a staged modification", () => {
        const out = z(
            "# branch.oid abc",
            `u UU N... 100644 100644 100644 100644 ${H} ${I} ${H} c f.md`,
        );

        const have = plain(out);

        expect(have).toEqual([
            {
                path: "c f.md",
                from: "",
                kind: "M",
                staged: true,
                untracking: false,
            },
        ]);
    });

    it("parses a truncated record without throwing", () => {
        const have = plain(z("1 .M"));

        expect(have).toEqual([
            {
                path: "",
                from: "",
                kind: "M",
                staged: false,
                untracking: false,
            },
        ]);
    });
});

describe("pairMoves", () => {
    it("pairs a missing file with an untracked one of the same content", () => {
        const entries = parseStatus(z(one(".D", "A/p.md"), "? B/q.md"));

        const have = pairMoves(entries, new Map([["B/q.md", H]]));

        expect(have).toEqual([
            {
                path: "B/q.md",
                from: "A/p.md",
                kind: "R",
                staged: false,
                untracking: false,
            },
        ]);
    });

    it("pairs by a file name both sides hold once", () => {
        const entries = parseStatus(
            z(one(".D", "A/p.md"), "? B/p.md", "? B/x.md"),
        );

        const have = pairMoves(entries, new Map());

        expect(have.map((c) => [c.kind, c.from, c.path])).toEqual([
            ["R", "A/p.md", "B/p.md"],
            ["A", "", "B/x.md"],
        ]);
    });

    it("leaves an ambiguous name unpaired", () => {
        const entries = parseStatus(
            z(one(".D", "A/p.md"), "? B/p.md", "? C/p.md"),
        );

        const have = pairMoves(entries, new Map());

        expect(have.map((c) => c.kind)).toEqual(["D", "A", "A"]);
    });
});

describe("moveCandidates", () => {
    it("lists untracked paths only when a tracked file went missing", () => {
        expect(moveCandidates(parseStatus(z("? a.md")))).toEqual([]);
        expect(
            moveCandidates(parseStatus(z(one(".D", "b.md"), "? a.md"))),
        ).toEqual(["a.md"]);
    });
});
