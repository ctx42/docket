// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { stemWithoutLowerCasing } from "../../src/search/porter.ts";
import { readGolden } from "../support/golden.ts";

/** Pairs of [word, stem] produced by go-porterstemmer (oracle `stem`). */
const golden = readGolden<[string, string][]>(
    new URL("testdata/stems.golden.json", import.meta.url),
);

describe("stemWithoutLowerCasing", () => {
    it("matches go-porterstemmer on every golden word", () => {
        const misses = golden.filter(
            ([w, want]) => stemWithoutLowerCasing(w) !== want,
        );

        expect(misses).toEqual([]);
        expect(golden.length).toBeGreaterThan(23000);
    });

    it.each([
        ["", ""],
        ["ab", "ab"],
        ["caresses", "caress"],
        ["ponies", "poni"],
        ["conflated", "conflat"],
        ["hopping", "hop"],
        ["relational", "relat"],
        ["sensibiliti", "sensibl"],
        ["archaeology", "archaeolog"],
        ["controll", "control"],
        ["RUNNING", "RUNNING"],
        ["ladY", "ladI"],
        ["größe", "größe"],
    ])("stems %j to %j", (word, want) => {
        expect(stemWithoutLowerCasing(word)).toBe(want);
    });
});
