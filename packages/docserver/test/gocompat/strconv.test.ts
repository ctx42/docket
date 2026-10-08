// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { goQuote } from "../../src/gocompat/strconv.ts";

describe("goQuote", () => {
    it.each([
        ["", '""'],
        ["title", '"title"'],
        ['a"b\\c', '"a\\"b\\\\c"'],
        ["\u0007\b\t\n\u000b\f\r", '"\\a\\b\\t\\n\\v\\f\\r"'],
        ["\u0000\u001f\u007f", '"\\x00\\x1f\\x7f"'],
        ["é漢😀", '"é漢😀"'],
        ["a b", '"a b"'],
        ["\u00a0\u200b\u2028", '"\\u00a0\\u200b\\u2028"'],
        ["\u{e0001}", '"\\U000e0001"'],
        ["\ud800", '"\\ufffd"'],
    ])("quotes %j like strconv.Quote", (s, want) => {
        expect(goQuote(s)).toBe(want);
    });
});

describe("goQuote of kept invalid bytes", () => {
    it.each<[string, string, string]>([
        ["an escaped byte", "a\udcffb", '"a\\xffb"'],
        ["another lone surrogate", "a\ud800b", '"a\\ufffdb"'],
    ])("%s", (_name, s, want) => {
        // --- When ---
        const have = goQuote(s);

        // --- Then ---
        expect(have).toBe(want);
    });
});
