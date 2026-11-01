// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
    type KnowledgeBase,
    knowledgeBaseProblem,
    proposeName,
    readKnowledgeBases,
    repoOfUrl,
} from "../../src/config/knowledge.ts";

/** kb builds a knowledge base entry. */
function kb(name: string, url = `git@ex.org:me/${name}.git`): KnowledgeBase {
    return { kind: "git", name, url, branch: "" };
}

/** dir builds a local folder knowledge base entry. */
function dir(name: string): KnowledgeBase {
    return { kind: "folder", name, url: "", branch: "" };
}

describe("repoOfUrl", () => {
    it.each([
        ["git@bitbucket.org:anna/kb.git", "anna", "kb"],
        ["ssh://git@host.example:7999/proj/kb-team.git", "proj", "kb-team"],
        ["https://github.com/acme/kb", "acme", "kb"],
        ["https://github.com/acme/kb.git/", "acme", "kb"],
        ["https://github.com/acme/kb?tab=x#top", "acme", "kb"],
        ["/srv/git/notes.git", "git", "notes"],
        ["git@host:kb.git", "", "kb"],
    ])("%s → %s/%s", (url, owner, repo) => {
        const have = repoOfUrl(url);

        expect(have).toEqual({ owner, repo });
    });

    it.each(["", "   ", "git@host:", "https://github.com/"])(
        "is null for %j",
        (url) => {
            expect(repoOfUrl(url)).toBeNull();
        },
    );
});

describe("proposeName", () => {
    it("is the repository name when that folder is free", () => {
        const have = proposeName("git@bitbucket.org:anna/kb.git", new Set());

        expect(have).toBe("kb");
    });

    it("adds the owner when the name is taken", () => {
        const have = proposeName(
            "git@bitbucket.org:anna/kb.git",
            new Set(["kb"]),
        );

        expect(have).toBe("kb-anna");
    });

    it("adds a number when that is taken too", () => {
        const have = proposeName(
            "git@bitbucket.org:anna/kb.git",
            new Set(["kb", "kb-anna", "kb-anna-2"]),
        );

        expect(have).toBe("kb-anna-3");
    });

    it("drops a leading dot and unsafe characters", () => {
        const have = proposeName("git@host:me/.my:kb.git", new Set());

        expect(have).toBe("my-kb");
    });

    it("is empty for a URL it cannot read", () => {
        expect(proposeName("nonsense:", new Set())).toBe("");
    });
});

describe("knowledgeBaseProblem", () => {
    it("accepts a free top-level name with a URL", () => {
        const have = knowledgeBaseProblem(kb("kb-anna"), [kb("kb")], "conflu");

        expect(have).toBe("");
    });

    it.each<[string, KnowledgeBase, string]>([
        [
            "a git entry without URL",
            { kind: "git", name: "kb", url: " ", branch: "" },
            "Enter the SSH URL.",
        ],
        ["no name", kb(""), "Enter a folder name."],
        [
            "a nested name",
            kb("a/b"),
            "Use a top-level folder: a name without /.",
        ],
        [
            "a hidden name",
            kb(".kb"),
            'A folder starting with "." is hidden from Obsidian.',
        ],
        [
            "the sync folder",
            kb("conflu"),
            "conflu is the Confluence sync folder.",
        ],
        ["a taken name", kb("kb"), "kb is already a knowledge base."],
    ])("rejects %s", (_, entry, want) => {
        const have = knowledgeBaseProblem(entry, [kb("kb")], "conflu");

        expect(have).toBe(want);
    });

    it("accepts a local folder without URL", () => {
        const have = knowledgeBaseProblem(dir("notes"), [kb("kb")], "conflu");

        expect(have).toBe("");
    });

    it("rejects a local folder whose name is taken", () => {
        const have = knowledgeBaseProblem(dir("kb"), [kb("kb")], "conflu");

        expect(have).toBe("kb is already a knowledge base.");
    });

    it("lets an entry keep its own name when it is in the list", () => {
        const own = kb("kb");

        const have = knowledgeBaseProblem(own, [own], "conflu");

        expect(have).toBe("");
    });
});

describe("readKnowledgeBases", () => {
    it("keeps well-formed entries, the branch defaulting to ''", () => {
        const have = readKnowledgeBases([
            { name: "kb", url: "git@h:me/kb.git", branch: "main" },
            { name: "kb2", url: "git@h:me/kb2.git" },
        ]);

        expect(have).toEqual([
            { kind: "git", name: "kb", url: "git@h:me/kb.git", branch: "main" },
            { kind: "git", name: "kb2", url: "git@h:me/kb2.git", branch: "" },
        ]);
    });

    it("reads a local folder, dropping any URL and branch", () => {
        const have = readKnowledgeBases([
            { kind: "folder", name: "notes" },
            { kind: "folder", name: "old", url: "u", branch: "b" },
        ]);

        expect(have).toEqual([dir("notes"), dir("old")]);
    });

    it("reads an explicit git kind", () => {
        const have = readKnowledgeBases([
            { kind: "git", name: "kb", url: "u" },
        ]);

        expect(have).toEqual([kb("kb", "u")]);
    });

    it("drops malformed entries", () => {
        const have = readKnowledgeBases([
            null,
            "kb",
            { name: "kb" },
            { name: 1, url: "u" },
            { kind: "git", name: "nourl" },
            { kind: "folder" },
            { kind: "svn", name: "x", url: "u" },
            { name: "ok", url: "u", branch: 3 },
        ]);

        expect(have).toEqual([kb("ok", "u")]);
    });

    it("is empty for anything but a list", () => {
        expect(readKnowledgeBases({ name: "kb" })).toEqual([]);
        expect(readKnowledgeBases(undefined)).toEqual([]);
    });
});
