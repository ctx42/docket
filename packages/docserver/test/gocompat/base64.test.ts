// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { goBase64Decode } from "../../src/gocompat/base64.ts";
import { utf8Decode } from "../../src/gocompat/utf8.ts";

// Expectations are Go's base64.StdEncoding.DecodeString results.
describe("goBase64Decode", () => {
    it.each([
        ["", ""],
        ["aGk=", "hi"],
        ["aGVsbG8=", "hello"],
        ["aGVs\nbG8=", "hello"],
        ["aGVs\r\nbG8=", "hello"],
        ["aGl=", "hi"],
        ["aG==", "h"],
        ["aGk=\n", "hi"],
        ["YWJj", "abc"],
    ])("decodes %j", (input, want) => {
        // --- When ---
        const have = goBase64Decode(input);

        // --- Then ---
        expect(utf8Decode(have as Uint8Array)).toBe(want);
    });

    it.each([
        "aGVs bG8=",
        "aGk",
        "a===",
        "aGk=aGk=",
        "aG=k",
        "=aGk",
        "a#==",
        "____",
    ])("refuses %j", (input) => {
        expect(goBase64Decode(input)).toBeUndefined();
    });
});
