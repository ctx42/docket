// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { logTime } from "@docket/core";
import { describe, expect, it } from "vitest";
import { HEAD, popupTitle, sameSource } from "../../src/git/signs/base.ts";

describe("popupTitle", () => {
    it("titles HEAD and Confluence hunks", () => {
        expect(popupTitle(HEAD, "change")).toBe(
            "Changed since the last commit",
        );
        expect(popupTitle({ kind: "confluence" }, "add")).toBe(
            "Not on Confluence",
        );
    });

    it("titles a commit's hunks with its time", () => {
        const at = new Date(2026, 8, 12, 14, 3).getTime();
        const src = { kind: "commit", at } as const;

        expect(popupTitle(src, "add")).toBe("Added since 12/09/26 14:03");
        expect(popupTitle(src, "delete")).toBe(`Deleted since ${logTime(at)}`);
        expect(popupTitle(src, "change")).toBe(`Changed since ${logTime(at)}`);
    });
});

describe("sameSource", () => {
    it("tells bases apart, commits by time", () => {
        expect(sameSource(HEAD, { kind: "head" })).toBe(true);
        expect(sameSource(HEAD, { kind: "confluence" })).toBe(false);
        expect(
            sameSource({ kind: "commit", at: 1 }, { kind: "commit", at: 1 }),
        ).toBe(true);
        expect(
            sameSource({ kind: "commit", at: 1 }, { kind: "commit", at: 2 }),
        ).toBe(false);
        expect(sameSource(HEAD, { kind: "commit", at: 1 })).toBe(false);
    });
});
