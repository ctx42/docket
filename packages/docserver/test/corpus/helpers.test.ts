// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    estTokens,
    nonEmpty,
    sourceURL,
    trimURL,
} from "../../src/corpus/helpers.ts";

// go: Test_estTokens_tabular
describe("estTokens", () => {
    it.each([
        ["empty", "", 0],
        ["whitespace only", "  \n\t ", 0],
        ["three words", "one two three", 4],
        ["six words", "a b c d e f", 8],
        ["go whitespace splits words", "a\u0085b　c", 4],
        ["byte order mark is not whitespace", "a﻿b", 1],
    ])("%s", (_, input, want) => {
        const have = estTokens(input);

        expect(have).toBe(want);
    });
});

// go: Test_nonEmpty_tabular
describe("nonEmpty", () => {
    it.each([
        ["all kept", ["a", "b"], ["a", "b"]],
        ["drops empties", ["", "a", "", "b"], ["a", "b"]],
        ["all empty", ["", ""], []],
        ["nil", null, []],
    ])("%s", (_, input, want) => {
        const have = nonEmpty(input);

        expect(have).toEqual(want);
    });
});

// go: Test_sourceURL_tabular
describe("sourceURL", () => {
    it.each([
        ["none", "no links at all", ""],
        ["any url", "see https://ex.com/page).", "https://ex.com/page"],
        [
            "first url wins",
            "a https://ex.com/x then https://docs.example.com/p end",
            "https://ex.com/x",
        ],
        [
            "link text is the url",
            "[https://ex.com/a](https://ex.com/a)",
            "https://ex.com/a",
        ],
        [
            "only ASCII whitespace ends a url",
            "https://ex.com/a b c",
            "https://ex.com/a b",
        ],
    ])("%s", (_, body, want) => {
        const have = sourceURL(body);

        expect(have).toBe(want);
    });
});

// go: Test_trimURL_tabular
describe("trimURL", () => {
    it.each([
        ["clean", "http://x/a", "http://x/a"],
        ["trailing punctuation", "http://x/a).", "http://x/a"],
        ["trailing bracket", "http://x/a]>", "http://x/a"],
    ])("%s", (_, input, want) => {
        const have = trimURL(input);

        expect(have).toBe(want);
    });
});
