// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    fileSlug,
    goFold,
    nonNil,
    uniqueFold,
} from "../../src/gaps/helpers.ts";
import { isNotExist } from "../../src/ports.ts";
import { MemDocFs } from "../support/mem-doc-fs.ts";

describe("syncDir (the DocFs method replacing Go's helper)", () => {
    // go: Test_syncDir
    it("syncs a directory", async () => {
        const fs = new MemDocFs().mkdirp("/g");

        await fs.syncDir("/g");

        expect(fs.synced).toEqual(["/g"]);
    });

    // go: Test_syncDir_error_missing_dir
    it("fails on a missing directory", async () => {
        const have = await new MemDocFs().syncDir("/g/absent").then(
            () => undefined,
            (e: unknown) => e,
        );

        expect(isNotExist(have)).toBe(true);
    });
});

// go: Test_slug_tabular
describe("fileSlug", () => {
    it.each([
        ["words", "EPUB download: token TTL", 60, "epub-download-token-ttl"],
        ["non ascii", "Größe ändern", 60, "gr-e-ndern"],
        ["edges", "  --a--  ", 60, "a"],
        ["none", "¿¡!?", 60, ""],
        ["cut", "abc def", 4, "abc"],
        ["cut exact", "abc def", 5, "abc-d"],
        ["kelvin sign lowers to ascii", "K", 60, "k"],
    ])("%s", (_, text, limit, want) => {
        expect(fileSlug(text, limit)).toBe(want);
    });
});

// go: Test_nonNil
describe("nonNil", () => {
    it("returns an empty array for nil and a copy otherwise", () => {
        expect(nonNil(null)).toEqual([]);
        expect(nonNil(undefined)).toEqual([]);
        expect(nonNil(["a"])).toEqual(["a"]);
    });
});

// go: Test_uniqueFold_tabular
describe("uniqueFold", () => {
    it.each([
        ["nil", null, []],
        ["as is", ["Anna M", "Bob"], ["Anna M", "Bob"]],
        ["trimmed", [" Anna M\t"], ["Anna M"]],
        ["blank dropped", ["", " ", "Bob"], ["Bob"]],
        [
            "first spelling kept",
            ["anna m", "Bob", "ANNA M", " Anna m "],
            ["anna m", "Bob"],
        ],
        ["unicode case", ["Łukasz", "łukasz"], ["Łukasz"]],
        ["sigma forms", ["Σ", "σ", "ς"], ["Σ"]],
        [
            "dotted and dotless i stay apart",
            ["ı", "i", "I", "İ"],
            ["ı", "i", "İ"],
        ],
    ])("%s", (_, input, want) => {
        expect(uniqueFold(input)).toEqual(want);
    });

    it("folds titlecase and sharp s like Go", () => {
        expect(goFold("ǅ")).toBe(goFold("ǆ"));
        expect(goFold("ẞ")).toBe(goFold("ß"));
        expect(goFold("ß")).not.toBe(goFold("SS"));
    });
});
