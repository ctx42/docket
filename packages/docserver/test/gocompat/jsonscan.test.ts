// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    goJSONFirstValue,
    goJSONSyntaxError,
} from "../../src/gocompat/jsonscan.ts";
import { utf8Encode } from "../../src/gocompat/utf8.ts";

describe("goJSONSyntaxError", () => {
    it.each([
        "{}",
        "[]",
        ' {"a": [1, -2.5e+3, 0, 0.5E-1, true, false, null, "s\\n\\u00e9\\""]} ',
        '"x"',
        "-0",
        "12",
    ])("accepts %j", (text) => {
        expect(goJSONSyntaxError(text)).toBeUndefined();
    });

    it.each([
        ["", "unexpected end of JSON input"],
        ["{", "unexpected end of JSON input"],
        ["[1,", "unexpected end of JSON input"],
        ["1.", "invalid character ' ' after decimal point in numeric literal"],
        ["{} x", "invalid character 'x' after top-level value"],
        ["x", "invalid character 'x' looking for beginning of value"],
        [
            '{"a": 1,}',
            "invalid character '}' looking for beginning of object key string",
        ],
        [
            "{a: 1}",
            "invalid character 'a' looking for beginning of object key string",
        ],
        ['{"a" 1}', "invalid character '1' after object key"],
        ['{"a": 1 2}', "invalid character '2' after object key:value pair"],
        ["[1 2]", "invalid character '2' after array element"],
        ['{"a": tru}', "invalid character '}' in literal true (expecting 'e')"],
        ["fx", "invalid character 'x' in literal false (expecting 'a')"],
        ["nul!", "invalid character '!' in literal null (expecting 'l')"],
        ['"\u0001"', "invalid character '\\x01' in string literal"],
        ['"\\q"', "invalid character 'q' in string escape code"],
        [
            '"\\u12x4"',
            "invalid character 'x' in \\u hexadecimal character escape",
        ],
        ["-x", "invalid character 'x' in numeric literal"],
        ["1.x", "invalid character 'x' after decimal point in numeric literal"],
        ["1ex", "invalid character 'x' in exponent of numeric literal"],
        ["01", "invalid character '1' after top-level value"],
        ["'a'", "invalid character '\\'' looking for beginning of value"],
        ['"a"""', "invalid character '\"' after top-level value"],
        ["\ufeff{}", "invalid character 'ï' looking for beginning of value"],
    ])("reports %j like Go", (text, want) => {
        expect(goJSONSyntaxError(text)).toBe(want);
    });
});

describe("goJSONSyntaxError on long strings", () => {
    const pad = "x".repeat(100_000);

    it.each([
        [`"${pad}\\n${pad}"`, undefined],
        [`"${pad}\u0001"`, "invalid character '\\x01' in string literal"],
        [`"${pad}\\q"`, "invalid character 'q' in string escape code"],
        [`["${pad}" 1]`, "invalid character '1' after array element"],
    ])("reports a long string like Go (%#)", (text, want) => {
        expect(goJSONSyntaxError(text)).toBe(want);
    });
});

describe("goJSONFirstValue", () => {
    it("finds the first value and ignores what follows", () => {
        const data = utf8Encode(`  {"a":"${"é".repeat(1000)}"}  junk`);

        expect(goJSONFirstValue(data)).toEqual({
            kind: "value",
            start: 2,
            end: 2 + 6 + 2000 + 2,
        });
    });

    it("asks for more when a long string runs past the data", () => {
        const data = utf8Encode(`{"a":"${"x".repeat(100_000)}`);

        expect(goJSONFirstValue(data, false)).toEqual({ kind: "more" });
        expect(goJSONFirstValue(data, true)).toEqual({
            kind: "error",
            message: "unexpected EOF",
        });
    });
});
