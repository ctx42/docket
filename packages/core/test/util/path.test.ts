// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    isAbsPosix,
    posixBase,
    posixClean,
    posixDir,
    posixJoin,
    posixRel,
} from "../../src/util/path.ts";

describe("posixRel", () => {
    it("relativises a sub-path against a `.` root without a spurious `..`", () => {
        // Regression: a `.` sync root cleaned to one bogus segment, so every
        // destination came back as `../…` and its cache escaped `.adf_cache`.
        expect(posixRel(".", "initiatives/int248/srd.md")).toBe(
            "initiatives/int248/srd.md",
        );
    });

    it("relativises a sub-path against a named root", () => {
        expect(posixRel("docs", "docs/x.md")).toBe("x.md");
    });

    it("relativises a sub-path against an absolute root", () => {
        expect(posixRel("/v", "/v/initiatives/srd.md")).toBe(
            "initiatives/srd.md",
        );
    });

    it("climbs out with `..` when the target is a sibling", () => {
        expect(posixRel("a/b", "a/c/x.md")).toBe("../c/x.md");
    });

    it("returns `.` for identical paths", () => {
        expect(posixRel(".", ".")).toBe(".");
        expect(posixRel("a/b", "a/b")).toBe(".");
    });
});

describe("Windows drive roots", () => {
    it.each<[string, string, string]>([
        ["clean keeps the drive", posixClean("C:/a/./b//c"), "C:/a/b/c"],
        ["clean stops at the drive root", posixClean("C:/a/../.."), "C:/"],
        ["a bare drive is its root", posixClean("C:"), "C:/"],
        ["join", posixJoin("C:/Vault", "docs/a.md"), "C:/Vault/docs/a.md"],
        ["dir of a top entry", posixDir("C:/a"), "C:/"],
        ["dir", posixDir("C:/a/b.md"), "C:/a"],
        ["base of the root", posixBase("C:/"), "C:/"],
        ["base", posixBase("C:/a/b.md"), "b.md"],
        ["rel", posixRel("C:/Vault", "C:/Vault/docs/a.md"), "docs/a.md"],
        ["rel across drives", posixRel("C:/a", "D:/a"), "../../D:/a"],
        ["POSIX roots unchanged", posixClean("/a/../.."), "/"],
        ["POSIX dir unchanged", posixDir("/a"), "/"],
    ])("%s", (_name, have, want) => {
        // --- Then ---
        expect(have).toBe(want);
    });

    it.each<[string, boolean]>([
        ["C:/Vault", true],
        ["c:", true],
        ["/srv", true],
        ["C:Vault", false],
        ["docs/C:/x", false],
        ["CD:/x", false],
    ])("isAbsPosix(%s)", (p, want) => {
        // --- When ---
        const have = isAbsPosix(p);

        // --- Then ---
        expect(have).toBe(want);
    });
});
