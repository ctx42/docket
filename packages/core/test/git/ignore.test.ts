// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    addIgnoreEntry,
    DEFAULT_IGNORES,
    defaultIgnoreBlock,
    ignoreEntries,
    ignorePattern,
} from "../../src/git/ignore.ts";

const BLOCK = "# docket:begin\n/a.md\n# docket:end\n";

describe("ignoreEntries", () => {
    it("reads the block's entries", () => {
        expect(ignoreEntries(`node_modules\n${BLOCK}*.log\n`)).toEqual([
            "/a.md",
        ]);
    });

    it("returns null without a block", () => {
        expect(ignoreEntries("*.log\n")).toBeNull();
    });
});

describe("defaultIgnoreBlock", () => {
    it("writes exactly the default entries on first setup", () => {
        const have = defaultIgnoreBlock("");

        expect(ignoreEntries(have)).toEqual([...DEFAULT_IGNORES]);
        expect(have).toBe(
            "# docket:begin\n.obsidian/workspace*.json\n.obsidian/cache\n.trash/\n.adf_cache/\n# docket:end\n",
        );
    });

    it("keeps an existing block", () => {
        expect(defaultIgnoreBlock(BLOCK)).toBe(BLOCK);
    });
});

describe("addIgnoreEntry", () => {
    it("keeps hand-written rules above and below the block", () => {
        const text = `# mine\n*.log\n\n${BLOCK}\n# after\nbuild/\n`;

        const have = addIgnoreEntry(text, "/ENG/");

        expect(have).toBe(
            "# mine\n*.log\n\n# docket:begin\n/a.md\n/ENG/\n# docket:end\n\n# after\nbuild/\n",
        );
    });

    it("appends a default block to a file without one", () => {
        const have = addIgnoreEntry("*.log", "/x.md");

        expect(have).toBe(
            `*.log\n\n# docket:begin\n${DEFAULT_IGNORES.join("\n")}\n/x.md\n# docket:end\n`,
        );
    });

    it("leaves the text alone when the entry is present", () => {
        expect(addIgnoreEntry(BLOCK, "/a.md")).toBe(BLOCK);
    });

    it("keeps CRLF line endings", () => {
        const have = addIgnoreEntry(
            "x\r\n# docket:begin\r\n# docket:end\r\n",
            "/y",
        );

        expect(have).toBe("x\r\n# docket:begin\r\n/y\r\n# docket:end\r\n");
    });
});

describe("ignorePattern", () => {
    it("anchors files and folders to the vault root", () => {
        expect(ignorePattern("ENG/a.md", false)).toBe("/ENG/a.md");
        expect(ignorePattern("ENG", true)).toBe("/ENG/");
    });

    it("escapes wildcards and a trailing space", () => {
        expect(ignorePattern("a*[b]?.md ", false)).toBe("/a\\*\\[b]\\?.md\\ ");
    });
});
