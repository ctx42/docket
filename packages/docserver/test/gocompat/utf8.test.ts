// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    byteString,
    quoteBytes,
    utf8Decode,
    utf8DecodeEscaped,
    utf8Encode,
} from "../../src/gocompat/utf8.ts";

describe("utf8Encode", () => {
    it.each([
        ["", []],
        ["a", [0x61]],
        ["é", [0xc3, 0xa9]],
        ["漢", [0xe6, 0xbc, 0xa2]],
        ["😀", [0xf0, 0x9f, 0x98, 0x80]],
        ["\ud800", [0xef, 0xbf, 0xbd]],
    ])("encodes %j", (s, want) => {
        const have = utf8Encode(s);

        expect([...have]).toEqual(want);
    });

    it("matches Buffer for mixed text", () => {
        const s = "Zażółć 漢字 😀 \u0000\u007f\u0080߿ࠀ￿";

        const have = utf8Encode(s);

        expect([...have]).toEqual([...Buffer.from(s, "utf8")]);
    });
});

describe("byteString", () => {
    it("maps each UTF-8 byte to one char", () => {
        const have = byteString("aé");

        expect(have).toBe("aÃ©");
    });
});

describe("quoteBytes", () => {
    it("escapes quote, backslash, control and high bytes", () => {
        const have = quoteBytes('x"\\\u0000\u001f\u007fÿ');

        expect(have).toBe('"x\\"\\\\\\x00\\x1f\u007f\\xff"');
    });
});

describe("utf8Decode", () => {
    it("round-trips valid text", () => {
        const s = "Zażółć 漢字 😀 \u0000\u007f\u0080\u07ff\u0800\uffff";

        expect(utf8Decode(utf8Encode(s))).toBe(s);
    });

    it.each([
        [[0x80], "\ufffd"],
        [[0xc0, 0x80], "\ufffd\ufffd"],
        [[0xe2, 0x82], "\ufffd\ufffd"],
        [[0xe0, 0x80, 0x80], "\ufffd\ufffd\ufffd"],
        [[0xed, 0xa0, 0x80], "\ufffd\ufffd\ufffd"],
        [[0xf4, 0x90, 0x80, 0x80], "\ufffd\ufffd\ufffd\ufffd"],
        [[0xf8], "\ufffd"],
        [[0x61, 0xc3], "a\ufffd"],
    ])("replaces invalid bytes %j", (bytes, want) => {
        expect(utf8Decode(Uint8Array.from(bytes))).toBe(want);
    });
});

describe("utf8DecodeEscaped", () => {
    it.each<[string, number[], string]>([
        ["valid text", [0x63, 0x61, 0x66, 0xc3, 0xa9], "café"],
        ["an invalid byte", [0x61, 0xff, 0x62], "a\udcffb"],
        ["a truncated sequence", [0xe9, 0x74], "\udce9t"],
        ["a real U+FFFD stays", [0xef, 0xbf, 0xbd], "\ufffd"],
    ])("%s", (_name, bytes, want) => {
        // --- When ---
        const have = utf8DecodeEscaped(new Uint8Array(bytes));

        // --- Then ---
        expect(have).toBe(want);
    });
});
