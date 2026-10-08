// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { logLine, parseLog } from "../../src/git/log.ts";

describe("parseLog", () => {
    it("reads one entry per NUL-separated record", () => {
        const out =
            "h1\x1f1700000000\x1ffirst\0\nh2\x1f1700000060\x1fsecond: x\0";

        const have = parseLog(out);

        expect(have).toEqual([
            { hash: "h1", at: 1_700_000_000_000, subject: "first" },
            { hash: "h2", at: 1_700_000_060_000, subject: "second: x" },
        ]);
    });
});

describe("logLine", () => {
    it("formats DD/MM/YY HH:MM in local time", () => {
        const at = new Date(2026, 0, 5, 7, 9).getTime();

        const have = logLine({ hash: "h", at, subject: "docs: x" });

        expect(have).toBe("05/01/26 07:09: docs: x");
        expect(have).toMatch(/^\d{2}\/\d{2}\/\d{2} \d{2}:\d{2}: .+$/);
    });

    it("stands in for an empty subject", () => {
        expect(logLine({ hash: "h", at: 0, subject: "" })).toMatch(
            /: \(no message\)$/,
        );
    });
});
