// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { type RemoteBody, splitFrontmatter } from "@docket/core";
import { describe, expect, it } from "vitest";
import { confluenceBase, remoteFor } from "../../src/ui/remote-diff.ts";
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
