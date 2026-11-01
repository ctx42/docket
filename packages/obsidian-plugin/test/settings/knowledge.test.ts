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
    it("appends the folder to an existing list", () => {
        const fm: Record<string, unknown> = { sources: ["conflu", "kb"] };

        const have = addSource(fm, "kb-anna");

        expect(have).toBe(true);
        expect(fm["sources"]).toEqual(["conflu", "kb", "kb-anna"]);
    });

    it("leaves a list that already has it", () => {
        const fm: Record<string, unknown> = { sources: ["kb-anna"] };

        expect(addSource(fm, "kb-anna")).toBe(false);
        expect(fm["sources"]).toEqual(["kb-anna"]);
    });

    it("starts a list when there is none", () => {
        const fm: Record<string, unknown> = {};

        expect(addSource(fm, "kb")).toBe(true);
        expect(fm["sources"]).toEqual(["kb"]);
    });

    it("turns a single string into a list", () => {
        const fm: Record<string, unknown> = { sources: "conflu" };

        expect(addSource(fm, "kb")).toBe(true);
        expect(fm["sources"]).toEqual(["conflu", "kb"]);
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
