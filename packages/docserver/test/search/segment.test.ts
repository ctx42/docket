// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { maskOf, segmentWords } from "../../src/search/segment.ts";
import { WB_PROPS } from "../../src/search/segment-tables.ts";

/** props lists the word-break properties of code point cp. */
function props(cp: number): string[] {
    const mask = maskOf(cp);
    return WB_PROPS.filter((_, i) => (mask >> i) & 1);
}

describe("maskOf", () => {
    it.each([
        [0x61, ["ALetter"]],
        [0x30, ["Numeric"]],
        [0x5f, ["ExtendNumLet"]],
        [0x27, ["Single_Quote"]],
        [0x2e, ["MidNumLet"]],
        [0x0a, ["LF"]],
        [0x301, ["Extend"]],
        [0x30ab, ["Katakana"]],
        [0xac00, ["ALetter", "Hangul"]],
        [0x6f22, ["Han"]],
        [0x3072, ["Hiragana"]],
        [0x20, []],
        [0x10ffff, []],
    ])("classifies U+%s", (cp, want) => {
        expect(props(cp)).toEqual(want);
    });
});

describe("segmentWords", () => {
    it("types segments as blevesearch/segment does", () => {
        const have = segmentWords("ab 12 カタ_カナ 漢字 한글 ひら .\r\n");

        expect(have.map((s) => [s.text, s.type])).toEqual([
            ["ab", "letter"],
            [" ", "none"],
            ["12", "number"],
            [" ", "none"],
            ["カタ_カナ", "letter"],
            [" ", "none"],
            ["漢", "ideo"],
            ["字", "ideo"],
            [" ", "none"],
            ["한글", "letter"],
            [" ", "none"],
            ["ひ", "ideo"],
            ["ら", "ideo"],
            [" ", "none"],
            [".", "none"],
            ["\r\n", "none"],
        ]);
    });

    it("splits a leading combining mark off and reads lone surrogates as U+FFFD", () => {
        const have = segmentWords("́́a\ud800");

        expect(have.map((s) => [s.text, s.type, s.start, s.end])).toEqual([
            ["́́", "none", 0, 4],
            ["a", "letter", 4, 5],
            ["�", "none", 5, 8],
        ]);
    });

    it("returns nothing for empty text", () => {
        expect(segmentWords("")).toEqual([]);
    });
});
