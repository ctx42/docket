// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { DEFAULT_SETTINGS, GitNotFoundError, RemoteError } from "@docket/core";
import { describe, expect, it } from "vitest";
import {
    addSource,
    localFolderChoices,
    localFolderPlan,
    remoteAdvice,
    takenNames,
} from "../../src/settings/knowledge.ts";

describe("addSource", () => {
    const BODY = "\n# Project\n\nHand-written notes.\n";

    it("appends to a block list and keeps every other byte", () => {
        const text = `---\nmcp-server: docs # the name\nsources:\n  - conflu\n  - kb\nkb: kb\n---${BODY}`;

        const have = addSource(text, "kb-anna");

        expect(have).toBe(
            `---\nmcp-server: docs # the name\nsources:\n  - conflu\n  - kb\n  - kb-anna\nkb: kb\n---${BODY}`,
        );
    });

    it("appends to a flow list", () => {
        const have = addSource(
            "---\nsources: [conflu, kb]\nwatch: true\n---\n",
            "kb-anna",
        );

        expect(have).toBe(
            "---\nsources: [conflu, kb, kb-anna]\nwatch: true\n---\n",
        );
    });

    it("turns a single value into a flow list", () => {
        const have = addSource("---\nsources: conflu\n---\n", "kb");

        expect(have).toBe("---\nsources: [conflu, kb]\n---\n");
    });

    it("adds a missing list at the end of the front matter", () => {
        const have = addSource("---\nmcp-server: docs\n---\nBody\n", "kb");

        expect(have).toBe(
            "---\nmcp-server: docs\nsources:\n  - kb\n---\nBody\n",
        );
    });

    it("keeps CRLF line ends", () => {
        const have = addSource(
            "---\r\nsources:\r\n  - conflu\r\n---\r\n",
            "kb",
        );

        expect(have).toBe("---\r\nsources:\r\n  - conflu\r\n  - kb\r\n---\r\n");
    });

    it("is undefined when the folder is listed, quoted or not", () => {
        expect(
            addSource('---\nsources:\n  - "kb"\n---\n', "kb"),
        ).toBeUndefined();
        expect(
            addSource("---\nsources: [conflu, 'kb']\n---\n", "kb"),
        ).toBeUndefined();
        expect(addSource("---\nsources: kb\n---\n", "kb")).toBeUndefined();
    });

    it("error - a note without front matter", () => {
        expect(() => addSource("# Project\n", "kb")).toThrow(
            "the config note has no front matter",
        );
    });
});

describe("takenNames", () => {
    it("holds the top-level vault entries, the sync folder, and every KB", () => {
        const s = {
            ...DEFAULT_SETTINGS,
            syncRoot: "conflu",
            knowledgeBases: [
                { kind: "git" as const, name: "kb-anna", url: "u", branch: "" },
            ],
        };

        const have = takenNames(s, ["kb", "project-config.md"]);

        expect([...have].sort()).toEqual([
            "conflu",
            "kb",
            "kb-anna",
            "project-config.md",
        ]);
    });
});

describe("remoteAdvice", () => {
    /** failed builds a RemoteError for a failed clone with `stderr`. */
    const failed = (stderr: string): RemoteError =>
        new RemoteError(["clone"], { code: 128, stdout: "", stderr });

    it.each([
        [
            "git@h: Permission denied (publickey).",
            "Your SSH key was not accepted",
        ],
        ["Host key verification failed.", "host key"],
        ["ERROR: Repository not found.", "No repository at this URL"],
        ["ssh: Could not resolve hostname h", "cannot be reached"],
    ])("explains %s", (stderr, want) => {
        expect(remoteAdvice(failed(stderr))).toContain(want);
    });

    it("passes any other git message through", () => {
        const have = remoteAdvice(failed("fatal: something odd"));

        expect(have).toBe("something odd");
    });

    it("points at the Git path when git is missing", () => {
        const have = remoteAdvice(new GitNotFoundError("/x/git"));

        expect(have).toContain("Git path");
    });

    it("uses the message of any other error", () => {
        expect(remoteAdvice(new Error("boom"))).toBe("boom");
        expect(remoteAdvice("plain")).toBe("plain");
    });
});

describe("localFolderChoices", () => {
    it("lists free top-level folders, sorted", () => {
        const s = {
            ...DEFAULT_SETTINGS,
            syncRoot: "conflu",
            knowledgeBases: [
                { kind: "git" as const, name: "kb-anna", url: "u", branch: "" },
            ],
        };

        const have = localFolderChoices(
            [
                "srd-work",
                "conflu",
                ".trash",
                "kb-anna",
                "internal",
                "_docket-media",
            ],
            s,
        );

        expect(have).toEqual(["internal", "srd-work"]);
    });
});

describe("localFolderPlan", () => {
    it("keeps a plain folder a local folder", () => {
        expect(localFolderPlan("notes", undefined)).toEqual({ kind: "folder" });
    });

    it("turns a clone with a remote into a git knowledge base", () => {
        const have = localFolderPlan("kb", {
            url: "git@h:me/kb.git",
            branch: "main",
        });

        expect(have).toEqual({
            kind: "git",
            url: "git@h:me/kb.git",
            branch: "main",
        });
    });

    it("refuses a repository without a remote, saying why", () => {
        const have = localFolderPlan("kb", { url: "", branch: "main" });

        expect(have.kind).toBe("refuse");
        expect(have.kind === "refuse" && have.reason).toContain(
            "kb is its own git repository without a remote",
        );
    });
});
