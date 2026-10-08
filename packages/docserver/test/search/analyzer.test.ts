// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    analyze,
    goToLower,
    possessive,
    tokenize,
    toLower,
} from "../../src/search/analyzer.ts";
import { STOP_WORDS_EN } from "../../src/search/stop-words.ts";
import { readGolden } from "../support/golden.ts";

interface Row {
    name: string;
    text: string;
    tokens: { term: string; position: number; start: number; end: number }[];
}

/** Tokens of bleve's "en" analyzer (oracle `analyze`). */
const golden = readGolden<Row[]>(
    new URL("testdata/analyze.golden.json", import.meta.url),
);

describe("analyze against bleve", () => {
    it.each(golden.map((r) => [r.name, r] as const))(
        "matches bleve for %s",
        (_, row) => {
            const have = analyze(row.text);

            expect(have).toEqual(row.tokens);
        },
    );
});

describe("tokenize", () => {
    it("numbers tokens and keeps byte offsets", () => {
        const have = tokenize("Zażółć, the 2 cats");

        expect(have).toEqual([
            { term: "Zażółć", position: 1, start: 0, end: 10 },
            { term: "the", position: 2, start: 12, end: 15 },
            { term: "2", position: 3, start: 16, end: 17 },
            { term: "cats", position: 4, start: 18, end: 22 },
        ]);
    });
});

describe("possessive", () => {
    it.each([
        ["anna's", "anna"],
        ["ANNA'S", "ANNA"],
        ["anna’s", "anna"],
        ["anna＇s", "anna"],
        ["annas", "annas"],
        ["'s", ""],
        ["s", "s"],
        ["", ""],
    ])("%j -> %j", (term, want) => {
        expect(possessive(term)).toBe(want);
    });
});

describe("toLower", () => {
    it.each([
        ["ABC", "abc"],
        ["already", "already"],
        ["ΟΔΟΣ", "οδος".slice(0, 3) + "ς"],
        ["ΣΑ", "σα"],
        ["Ⱥpple", "ⱥpple"],
        ["İ", "i"],
    ])("%j -> %j", (term, want) => {
        expect(toLower(term)).toBe(want);
    });

    it("garbles a term after a shrinking rune, as bleve does", () => {
        // "İ" (2 bytes) lowers to "i" (1 byte); bleve's in-place copy then
        // leaves the unchanged "a" in place, keeping a stray 0xB0 byte.
        expect(toLower("İa")).toBe("i�");
    });
});

describe("goToLower", () => {
    it.each([
        [0x41, 0x61],
        [0x7a, 0x7a],
        [0x130, 0x69],
        [0x3a3, 0x3c3],
        [0x212a, 0x6b],
        [0x1f600, 0x1f600],
    ])("%i -> %i", (cp, want) => {
        expect(goToLower(cp)).toBe(want);
    });
});

describe("STOP_WORDS_EN", () => {
    it("holds the Snowball English list", () => {
        expect(STOP_WORDS_EN.size).toBe(174);
        expect(STOP_WORDS_EN.has("the")).toBe(true);
        expect(STOP_WORDS_EN.has("yourselves")).toBe(true);
        expect(STOP_WORDS_EN.has("mine")).toBe(false);
    });
});
