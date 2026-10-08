// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { type RemoteBody, splitFrontmatter } from "@docket/core";
import { describe, expect, it } from "vitest";
import {
    confluenceBase,
    RemoteDiffState,
    remoteFor,
} from "../../src/ui/remote-diff.ts";
import type { ChangeGroupId } from "../../src/ui/review.ts";

describe("remoteFor", () => {
    const bodies = new Map<string, RemoteBody>([
        ["a.md", { body: "x" }],
        ["b.md", { error: "page 1: HTTP 404" }],
    ]);

    it("offers a diff only in the outgoing, incoming, and diverged groups", () => {
        const ids: ChangeGroupId[] = [
            "conflicts",
            "outgoing",
            "new",
            "incoming",
            "diverged",
            "problems",
            "ignored",
        ];

        const have = ids.filter((id) => remoteFor(bodies, id, "a.md"));

        expect(have).toEqual(["outgoing", "incoming", "diverged"]);
    });

    it("returns the reason a note has no body", () => {
        const have = remoteFor(bodies, "incoming", "b.md");

        expect(have).toEqual({ error: "page 1: HTTP 404" });
    });

    it("returns null for a note the check recorded nothing for", () => {
        expect(remoteFor(bodies, "incoming", "c.md")).toBeNull();
        expect(remoteFor(undefined, "incoming", "a.md")).toBeNull();
    });
});

describe("confluenceBase", () => {
    it("keeps the note's frontmatter and trailing newlines around the body", () => {
        const doc = "---\ntitle: T\ndocket_page_version: 3\n---\n\nlocal\n";

        const have = confluenceBase(doc, "remote\n\nmore");

        expect(have).toBe(
            "---\ntitle: T\ndocket_page_version: 3\n---\n\nremote\n\nmore\n",
        );
    });

    it("rebuilds an unedited note byte for byte from its own body", () => {
        const docs = [
            "---\ntitle: T\n---\n\nbody\n",
            "---\ntitle: T\n---\nbody",
            "---\na: 1\nb: 2\n---\n\n\npara one\n\npara two\n\n",
        ];

        for (const doc of docs) {
            const have = confluenceBase(doc, splitFrontmatter(doc).body);

            expect(have).toBe(doc);
        }
    });

    it("treats a note without frontmatter as all body", () => {
        expect(confluenceBase("local\n\n", "remote")).toBe("remote\n\n");
    });

    it("treats an unterminated frontmatter as body", () => {
        expect(confluenceBase("---\nx: 1\nlocal", "remote")).toBe("remote");
    });

    it("keeps a note with an empty body to its frontmatter", () => {
        const have = confluenceBase("---\nx: 1\n---\n\n", "remote");

        expect(have).toBe("---\nx: 1\n---\n\nremote");
    });
});

describe("RemoteDiffState", () => {
    it("offers the icon for the note opened from its row, diff off", () => {
        const s = new RemoteDiffState();

        expect(s.open("a.md")).toBe(true);

        expect(s.opened).toBe("a.md");
        expect(s.confluencePath).toBeNull();
    });

    it("toggles the opened note between git and Confluence", () => {
        const s = new RemoteDiffState();
        s.open("a.md");

        expect(s.toggle("a.md")).toBe(true);
        expect(s.confluencePath).toBe("a.md");
        expect(s.toggle("a.md")).toBe(true);
        expect(s.confluencePath).toBeNull();
    });

    it("ignores a toggle for any note but the opened one", () => {
        const s = new RemoteDiffState();
        s.open("a.md");

        expect(s.toggle("b.md")).toBe(false);
        expect(s.confluencePath).toBeNull();
    });

    it("keeps the opened note while it stays active", () => {
        const s = new RemoteDiffState();
        s.open("a.md");
        s.toggle("a.md");

        expect(s.focus("a.md")).toBe(false);
        expect(s.confluencePath).toBe("a.md");
    });

    it("forgets the opened note once another note is active", () => {
        const s = new RemoteDiffState();
        s.open("a.md");
        s.toggle("a.md");

        expect(s.focus("b.md")).toBe(true);

        expect(s.opened).toBeNull();
        expect(s.confluencePath).toBeNull();
        // Coming back (Back/Forward) does not bring the icon back.
        expect(s.focus("a.md")).toBe(false);
        expect(s.opened).toBeNull();
    });

    it("forgets the opened note when no note is active", () => {
        const s = new RemoteDiffState();
        s.open("a.md");

        expect(s.focus(null)).toBe(true);
        expect(s.opened).toBeNull();
    });

    it("re-opening a note from its row turns its diff off", () => {
        const s = new RemoteDiffState();
        s.open("a.md");
        s.toggle("a.md");

        expect(s.open("a.md")).toBe(true);
        expect(s.confluencePath).toBeNull();
        expect(s.open("a.md")).toBe(false);
    });

    it("drops back to git when the note loses its remote body", () => {
        const s = new RemoteDiffState();
        s.open("a.md");
        s.toggle("a.md");

        expect(s.reconcile(() => true)).toBe(false);
        expect(s.confluencePath).toBe("a.md");
        expect(s.reconcile(() => false)).toBe(true);

        expect(s.confluencePath).toBeNull();
        expect(s.opened).toBe("a.md");
    });

    it("reconciles nothing while the diff is off", () => {
        const s = new RemoteDiffState();
        s.open("a.md");

        expect(s.reconcile(() => false)).toBe(false);
    });
});
