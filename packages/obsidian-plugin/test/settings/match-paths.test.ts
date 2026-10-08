// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { matchPaths } from "../../src/settings/locations.ts";

const paths = ["wiki", "wiki/Eng", "wiki/Eng/Notes.md", "other", "wikis"];

describe("matchPaths", () => {
    it("returns paths under the base, relative to it, shortest first", () => {
        const have = matchPaths(paths, "wiki", "");

        expect(have).toEqual(["Eng", "Eng/Notes.md"]);
    });

    it("matches the query case-insensitively", () => {
        const have = matchPaths(paths, "", "NOTES");

        expect(have).toEqual(["wiki/Eng/Notes.md"]);
    });

    it("treats . as the vault root", () => {
        const have = matchPaths(paths, ".", "o");

        expect(have).toEqual(["other", "wiki/Eng/Notes.md"]);
    });
});
