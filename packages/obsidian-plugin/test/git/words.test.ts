// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { computeHunks } from "../../src/git/signs/diff.ts";
import { type Segment, wordDiff } from "../../src/git/signs/words.ts";

/** marked renders segments as text with each changed run in [brackets]. */
function marked(lines: Segment[][]): string[] {
    return lines.map((segs) =>
        segs.map((s) => (s.changed ? `[${s.text}]` : s.text)).join(""),
    );
}

/** diff word-diffs the single hunk of `b` against `a`. */
function diff(a: string, b: string): { removed: string[]; added: string[] } {
    const { hunks } = computeHunks(a, b);
    const [hunk] = hunks;
    if (hunk === undefined || hunks.length !== 1) throw new Error("one hunk");
    const have = wordDiff(hunk);
    return { removed: marked(have.removed), added: marked(have.added) };
}

describe("wordDiff", () => {
    it("marks only the edited word of a changed line", () => {
        const have = diff(
            "a\nThe quick brown fox jumps.\nz\n",
            "a\nThe quick red fox jumps.\nz\n",
        );

        expect(have).toEqual({
            removed: ["The quick [brown] fox jumps."],
            added: ["The quick [red] fox jumps."],
        });
    });

    it("marks words across every line of a multi-line change", () => {
        const have = diff(
            "a\none two three\nfour five six\nz\n",
            "a\none 2 three\nfour five 6\nz\n",
        );

        expect(have).toEqual({
            removed: ["one [two] three", "four five [six]"],
            added: ["one [2] three", "four five [6]"],
        });
    });

    it("marks a whole line inserted inside a change", () => {
        const have = diff(
            "a\nfirst line here\nz\n",
            "a\nfirst line here!\nbrand new\nz\n",
        );

        expect(have.removed).toEqual(["first line here"]);
        expect(have.added).toEqual(["first line here[!]", "[brand new]"]);
    });

    it("leaves the lines of an added hunk unmarked", () => {
        const have = diff("a\nz\n", "a\nnew one\nnew two\nz\n");

        expect(have).toEqual({ removed: [], added: ["new one", "new two"] });
    });

    it("leaves the lines of a deleted hunk unmarked", () => {
        const have = diff("a\nold\nz\n", "a\nz\n");

        expect(have).toEqual({ removed: ["old"], added: [] });
    });

    it("keeps an empty line as a line without segments", () => {
        const have = diff("a\nx\n\ny\nz\n", "a\nX\n\nY\nz\n");

        expect(have.removed).toEqual(["[x]", "", "[y]"]);
        expect(have.added).toEqual(["[X]", "", "[Y]"]);
    });
});
