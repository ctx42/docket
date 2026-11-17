// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
    canPublish,
    canReply,
    noteActions,
    noteLink,
    replyTarget,
} from "../../src/ui/note-actions.ts";

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

describe("canPublish", () => {
    it("offers publish on a note with a page id", () => {
        const fm = { docket_page_id: "42", docket_mode: "ignore-push" };

        const have = canPublish(fm);

        expect(have).toBe(true);
    });

    it.each([
        ["no frontmatter", undefined],
        ["a never-pushed note", { title: "New" }],
        ["a local note", { docket_page_id: "42", docket_local: true }],
    ])("does not offer publish on %s", (_, fm) => {
        const have = canPublish(fm);

        expect(have).toBe(false);
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

describe("replyTarget", () => {
    const fm = { docket_page_id: "42" };
    const note = [
        "---",
        'docket_page_id: "42"',
        "---",
        "",
        "Text.",
        "",
        "> [!comment] id:C1 · @Jane Doe · 2026-11-10T09:12:44Z · open",
        "> Which devices?",
    ].join("\n");

    it("offers the thread under the cursor", () => {
        const have = replyTarget(true, fm, note, 7);

        expect(have).toEqual({
            id: "C1",
            author: "Jane Doe",
            text: "Which devices?",
        });
    });

    it.each([
        ["comments off", false, fm, 7],
        ["a line outside a callout", true, fm, 4],
        ["no frontmatter", true, undefined, 7],
        ["a never-pushed note", true, { title: "New" }, 7],
        ["a local note", true, { docket_page_id: "42", docket_local: true }, 7],
    ])("offers nothing on %s", (_name, on, meta, line) => {
        const have = replyTarget(on, meta, note, line);

        expect(have).toBeNull();
    });
});

describe("canReply", () => {
    it("allows replies on a synced note with comments on", () => {
        expect(canReply(true, { docket_page_id: "42" })).toBe(true);
    });

    it.each([
        ["comments off", false, { docket_page_id: "42" }],
        ["no frontmatter", true, undefined],
        ["a never-pushed note", true, { title: "New" }],
        ["a local note", true, { docket_page_id: "42", docket_local: true }],
    ])("refuses %s", (_name, on, fm) => {
        expect(canReply(on, fm)).toBe(false);
    });
});
