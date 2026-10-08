// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { ChangeSet, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { computeHunks, lineFromPos } from "../../src/git/signs/diff.ts";
import {
    allSigns,
    calcSigns,
    createHunk,
    findHunk,
} from "../../src/git/signs/hunks.ts";

/** signs diffs `b` against `a` and returns `lnum:type` per signed line. */
function signs(a: string, b: string): string[] {
    return allSigns(computeHunks(a, b).hunks).map((s) => `${s.lnum}:${s.type}`);
}

const BASE = "1\n2\n3\n4\n5\n6\n7\n";

describe("computeHunks + allSigns", () => {
    it("marks an edited line as changed", () => {
        expect(signs(BASE, "1\n2\n3\n4\nfive\n6\n7\n")).toEqual(["5:change"]);
    });

    it("marks inserted lines as added", () => {
        expect(signs(BASE, "1\n2\nx\ny\n3\n4\n5\n6\n7\n")).toEqual([
            "3:add",
            "4:add",
        ]);
    });

    it("puts a deleted marker where lines were removed", () => {
        expect(signs(BASE, "1\n2\n5\n6\n7\n")).toEqual(["2:delete"]);
    });

    it("puts a top-delete marker for removed leading lines", () => {
        expect(signs(BASE, "3\n4\n5\n6\n7\n")).toEqual(["1:topdelete"]);
    });

    it("marks every line of a note without a base as added", () => {
        expect(signs("", "a\nb\n")).toEqual(["1:add", "2:add"]);
    });

    it("has no signs for an unchanged note", () => {
        expect(signs(BASE, BASE)).toEqual([]);
    });

    it("marks lines a change grew as changed, then added", () => {
        expect(signs(BASE, "1\n2\nx\ny\nz\n4\n5\n6\n7\n")).toEqual([
            "3:change",
            "4:add",
            "5:add",
        ]);
    });

    it("marks the last line of a change that shrank as changedelete", () => {
        expect(signs(BASE, "1\n2\nx\n5\n6\n7\n")).toEqual(["3:changedelete"]);
    });

    it("has no signs for an empty note without a base", () => {
        expect(signs("", "")).toEqual([]);
    });
});

describe("computeHunks", () => {
    it("flags the side that lacks a final newline", () => {
        const { hunks } = computeHunks("1\n2", "1\nB");

        expect(hunks).toHaveLength(1);
        expect(hunks[0]?.removed).toEqual({
            start: 2,
            count: 1,
            lines: ["2"],
            no_nl_at_eof: true,
        });
        expect(hunks[0]?.added.no_nl_at_eof).toBe(true);
    });

    it("updates the previous chunks incrementally", () => {
        const first = computeHunks(BASE, BASE);
        const changes = ChangeSet.of(
            [{ from: 0, to: 1, insert: "one" }],
            BASE.length,
        );

        const have = computeHunks(
            BASE,
            `one${BASE.slice(1)}`,
            first.chunks,
            changes.desc,
        );

        expect(have.hunks.map((h) => h.type)).toEqual(["change"]);
        expect(have.chunks).toHaveLength(1);
    });

    it("lineFromPos gives the empty line after a final newline to the one before", () => {
        const doc = Text.of(["a", "b", ""]);

        expect(lineFromPos(doc, doc.length)).toBe(2);
        expect(lineFromPos(doc, 0)).toBe(1);
    });
});

describe("calcSigns", () => {
    it("marks a delete at the very top as topdelete on line 1", () => {
        const del = createHunk(1, 2, 0, 0);

        const have = calcSigns(undefined, del, undefined);

        expect(have).toEqual([{ type: "topdelete", lnum: 1, count: 2 }]);
    });

    it("marks a change after a top add as changedelete", () => {
        const add = createHunk(0, 0, 0, 1);
        const change = createHunk(3, 1, 3, 1);

        const have = calcSigns(add, change, undefined);

        expect(have).toEqual([{ type: "changedelete", lnum: 3, count: 1 }]);
    });

    it("clips the signs to the requested line range", () => {
        const change = createHunk(2, 1, 2, 4);

        const have = calcSigns(undefined, change, undefined, 3, 4);

        expect(have.map((s) => `${s.lnum}:${s.type}`)).toEqual([
            "3:add",
            "4:add",
        ]);
    });
});

describe("findHunk", () => {
    it("finds the hunk under a line, with its base lines", () => {
        const { hunks } = computeHunks(BASE, "1\n2\n3\n4\nfive\n6\n7\n");

        const have = findHunk(5, hunks);

        expect(have?.removed.lines).toEqual(["5"]);
        expect(findHunk(4, hunks)).toBeUndefined();
    });

    it("finds a top delete from line 1", () => {
        const { hunks } = computeHunks(BASE, "3\n4\n5\n6\n7\n");

        const have = findHunk(1, hunks);

        expect(have?.type).toBe("delete");
    });
});
