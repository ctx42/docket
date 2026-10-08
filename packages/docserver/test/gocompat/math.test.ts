// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { goLog } from "../../src/gocompat/math.ts";
import { readGolden } from "../support/golden.ts";

/** [x, math.Log(x)] pairs computed by Go on amd64. */
const golden = readGolden<[number, number][]>(
    new URL("testdata/log.golden.json", import.meta.url),
);

describe("goLog", () => {
    it("equals Go's math.Log bit for bit", () => {
        const misses = golden.filter(([x, want]) => !Object.is(goLog(x), want));

        expect(misses).toEqual([]);
        expect(golden.length).toBeGreaterThan(2000);
    });

    it("handles special values like Go", () => {
        expect(goLog(Number.NaN)).toBeNaN();
        expect(goLog(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
        expect(goLog(-1)).toBeNaN();
        expect(goLog(0)).toBe(Number.NEGATIVE_INFINITY);
        expect(goLog(1)).toBe(0);
    });
});
