// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
    capHistory,
    firstLine,
    HISTORY_CAP,
    parseHistoryCap,
    recordMessage,
} from "../../src/git/history.ts";

describe("recordMessage", () => {
    it("puts the trimmed message first and drops its older copy", () => {
        let have: string[] = [];
        for (const m of ["a", "b", " a "]) {
            have = recordMessage(have, m, HISTORY_CAP);
        }

        expect(have).toEqual(["a", "b"]);
    });

    it("drops the oldest entries past the cap", () => {
        let have: string[] = [];
        for (const m of ["a", "b", "c", "d"]) have = recordMessage(have, m, 3);

        expect(have).toEqual(["d", "c", "b"]);
    });

    it("records nothing with a cap of 0", () => {
        expect(recordMessage([], "a", 0)).toEqual([]);
    });

    it("ignores a blank message", () => {
        expect(recordMessage(["a"], "  \n", HISTORY_CAP)).toEqual(["a"]);
    });
});

describe("capHistory", () => {
    it("keeps the newest entries", () => {
        const list = ["8", "7", "6", "5", "4", "3", "2", "1"];

        expect(capHistory(list, 5)).toEqual(["8", "7", "6", "5", "4"]);
        expect(capHistory(list, 0)).toEqual([]);
    });
});

describe("parseHistoryCap", () => {
    it("accepts whole numbers from 0 to 100", () => {
        expect(parseHistoryCap("0")).toBe(0);
        expect(parseHistoryCap(" 20 ")).toBe(20);
        expect(parseHistoryCap("100")).toBe(100);
    });

    it("rejects anything else", () => {
        for (const v of ["abc", "2.5", "-1", "101", ""]) {
            expect(parseHistoryCap(v)).toBeNull();
        }
    });
});

describe("firstLine", () => {
    it("returns a message's first line", () => {
        expect(firstLine("docs: x\n\nbody")).toBe("docs: x");
        expect(firstLine("one\r\ntwo")).toBe("one");
        expect(firstLine("")).toBe("");
    });
});
