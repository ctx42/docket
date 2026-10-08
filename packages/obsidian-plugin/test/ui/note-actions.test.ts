// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { noteActions, noteLink } from "../../src/ui/note-actions.ts";

describe("noteActions", () => {
    it("offers pull, push, and discard on a pulled note", () => {
        const fm = { docket_page_id: "42", docket_mode: "pull" };

        const have = noteActions(fm);

        expect(have).toEqual(["pull", "push", "discard"]);
    });

    it("hides push on an ignore-push note", () => {
        const fm = { docket_page_id: "42", docket_mode: "ignore-push" };

        const have = noteActions(fm);

        expect(have).toEqual(["pull", "discard"]);
    });

    it("hides push on a legacy docket-plugin: ignore-push note", () => {
        const fm = { page_id: "42", "docket-plugin": "ignore-push" };

        const have = noteActions(fm);

        expect(have).toEqual(["pull", "discard"]);
    });

    it.each([
        ["no frontmatter", undefined],
        ["a never-pushed note", { title: "New" }],
        ["an empty page id", { docket_page_id: "" }],
        ["a local note", { docket_page_id: "42", docket_local: true }],
        ["a legacy local note", { page_id: "42", cf_local: true }],
    ])("offers nothing on %s", (_, fm) => {
        const have = noteActions(fm);

        expect(have).toEqual([]);
    });
});

describe("noteLink", () => {
    it("returns the page URL of a synced note", () => {
        const fm = { url: "https://ex.atlassian.net/wiki/spaces/S/pages/1" };

        const have = noteLink(fm);

        expect(have).toBe("https://ex.atlassian.net/wiki/spaces/S/pages/1");
    });

    it.each([
        ["no frontmatter", undefined],
        ["no url", { title: "T" }],
        ["a non-string url", { url: 42 }],
        ["a non-http url", { url: "javascript:alert(1)" }],
    ])("returns empty for %s", (_, fm) => {
        const have = noteLink(fm);

        expect(have).toBe("");
    });
});
