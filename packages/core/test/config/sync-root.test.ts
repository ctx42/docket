// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
    assertSyncFolder,
    NO_SYNC_FOLDER,
    NoSyncFolderError,
    syncFolder,
    syncFolderProblem,
} from "../../src/config/sync-root.ts";

describe("syncFolder", () => {
    it("is the cleaned folder", () => {
        expect(syncFolder("confluence/")).toBe("confluence");
        expect(syncFolder(" confluence ")).toBe("confluence");
    });

    it("is empty for an unset or whole-vault root", () => {
        expect(syncFolder("")).toBe("");
        expect(syncFolder(".")).toBe("");
        expect(syncFolder("./")).toBe("");
    });
});

describe("assertSyncFolder", () => {
    it("passes with a sync folder", () => {
        expect(() => assertSyncFolder("confluence")).not.toThrow();
    });

    it("refuses without one", () => {
        expect(() => assertSyncFolder("")).toThrow(NoSyncFolderError);
        expect(() => assertSyncFolder(".")).toThrow(NO_SYNC_FOLDER);
    });
});

describe("syncFolderProblem", () => {
    it("accepts a top-level folder", () => {
        expect(syncFolderProblem("confluence")).toBe("");
        expect(syncFolderProblem(" docs ")).toBe("");
    });

    it("refuses an empty value, a nested folder, and reserved names", () => {
        expect(syncFolderProblem("")).toBe("Enter a folder name.");
        expect(syncFolderProblem("a/b")).toBe(
            "Use a top-level folder: a name without /.",
        );
        expect(syncFolderProblem("a\\b")).toBe(
            "Use a top-level folder: a name without /.",
        );
        expect(syncFolderProblem(".")).toBe("Enter a folder name.");
        expect(syncFolderProblem("..")).toBe('".." cannot be a folder name.');
        expect(syncFolderProblem(".obsidian")).toBe(
            'A folder starting with "." is hidden from Obsidian.',
        );
    });
});
