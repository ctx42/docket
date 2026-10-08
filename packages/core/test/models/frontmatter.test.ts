// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
    FM,
    fmGet,
    fmKeyPattern,
    fmRaw,
    LEGACY_FM,
} from "../../src/models/frontmatter.ts";

describe("FM", () => {
    it("prefixes every docket-owned key with docket_", () => {
        for (const key of Object.values(FM)) {
            expect(key.startsWith("docket_")).toBe(true);
        }
    });

    it("names a legacy key for every field", () => {
        expect(Object.keys(LEGACY_FM).sort()).toEqual(Object.keys(FM).sort());
    });
});

describe("fmGet", () => {
    it("reads the prefixed key", () => {
        const have = fmGet({ docket_page_id: "1" }, "pageId");

        expect(have).toBe("1");
    });

    it("falls back to the legacy key", () => {
        const have = fmGet({ "docket-plugin": "ignore-push" }, "mode");

        expect(have).toBe("ignore-push");
    });

    it("prefers the prefixed key over the legacy one", () => {
        const have = fmGet({ cf_local: false, docket_local: true }, "local");

        expect(have).toBe(true);
    });

    it("returns undefined when neither key is set", () => {
        expect(fmGet({}, "domain")).toBeUndefined();
    });
});

describe("fmRaw", () => {
    it.each([
        ['docket_page_id: "12"\n', "12"],
        ["docket_page_id: '12'\n", "12"],
        ["docket_page_id: 12\n", "12"],
        ["docket_page_id: 12  \r\n", "12"],
        ['page_id: "12"\n', "12"],
        ['page_id: "11"\ndocket_page_id: "12"\n', "12"],
    ])("reads %j as %j", (fm, want) => {
        const have = fmRaw(fm, "pageId");

        expect(have).toBe(want);
    });

    it("returns undefined when the key is absent", () => {
        expect(fmRaw('id: "12"\n', "pageId")).toBeUndefined();
    });

    it("ignores an indented key", () => {
        expect(fmRaw('x:\n  page_id: "12"\n', "pageId")).toBeUndefined();
    });
});

describe("fmKeyPattern", () => {
    it("matches the prefixed and the legacy key, nothing else", () => {
        const re = new RegExp(`^${fmKeyPattern("mode")}:`);

        expect(re.test("docket_mode: pull")).toBe(true);
        expect(re.test("docket-plugin: pull")).toBe(true);
        expect(re.test("docket_modes: pull")).toBe(false);
    });
});
