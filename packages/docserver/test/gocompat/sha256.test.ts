// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { sha256Hex } from "../../src/gocompat/sha256.ts";

function nodeHex(data: string | Uint8Array): string {
    return createHash("sha256").update(data).digest("hex");
}

describe("sha256Hex", () => {
    it("hashes the empty string", () => {
        const have = sha256Hex("");

        const want =
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        expect(have).toBe(want);
    });

    it.each([0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 70000])(
        "matches node:crypto for %i bytes",
        (n) => {
            const data = Uint8Array.from(
                { length: n },
                (_, i) => (i * 31 + 7) & 0xff,
            );

            const have = sha256Hex(data);

            expect(have).toBe(nodeHex(data));
        },
    );

    it("hashes a string as UTF-8", () => {
        const s = "Zażółć gęślą jaźń 😀\r\n";

        const have = sha256Hex(s);

        expect(have).toBe(nodeHex(Buffer.from(s, "utf8")));
    });
});
