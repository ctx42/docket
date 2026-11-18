// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { cleanFolder, inFolder } from "../../src/util/paths.ts";

describe("cleanFolder", () => {
    it.each([
        ["plain", "kb", "kb"],
        ["trailing slash", "kb/sub/", "kb/sub"],
        ["leading dot", "./kb", "kb"],
        ["spaces", "  kb  ", "kb"],
        ["empty", "", ""],
        ["blank", "   ", ""],
        ["dot", ".", ""],
    ])("%s", (_, in_, want) => {
        expect(cleanFolder(in_)).toBe(want);
    });
});

describe("inFolder", () => {
    it.each([
        ["inside", "kb/a.md", "kb", true],
        ["nested", "kb/sub/a.md", "kb/sub/", true],
        ["sibling prefix", "kbx/a.md", "kb", false],
        ["other", "doc/a.md", "kb", false],
        ["no folder keeps all", "doc/a.md", "", true],
    ])("%s", (_, path, folder, want) => {
        expect(inFolder(path, folder)).toBe(want);
    });
});
