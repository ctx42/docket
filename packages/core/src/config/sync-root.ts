// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The sync folder: the one top-level vault folder docket pulls pages into and
// pushes them from. Without one, docket refuses to pull or push in the plugin
// and in the command-line tool alike, with the same message; it never moves
// files to make one.

import { posixClean } from "../util/path.ts";

/** NO_SYNC_FOLDER is why pull and push refuse to run without a sync folder. */
export const NO_SYNC_FOLDER =
    "no sync folder is set, so docket does not pull or push. Choose one in " +
    "the docket panel. A vault that already holds synced pages needs them " +
    'moved by hand into a top-level folder named by "syncRoot" in the ' +
    "plugin's data.json.";

/** NoSyncFolderError is a pull or push refused for want of a sync folder. */
export class NoSyncFolderError extends Error {
    constructor() {
        super(NO_SYNC_FOLDER);
        this.name = "NoSyncFolderError";
    }
}

/**
 * syncFolder returns the sync folder's cleaned vault path, or `""` when none
 * is set: an empty root and the whole vault (`.`) both count as none.
 */
export function syncFolder(syncRoot: string): string {
    const p = posixClean(syncRoot.trim() || ".");
    return p === "." ? "" : p;
}

/** assertSyncFolder throws {@link NoSyncFolderError} when no sync folder is set. */
export function assertSyncFolder(syncRoot: string): void {
    if (syncFolder(syncRoot) === "") throw new NoSyncFolderError();
}

/**
 * syncFolderProblem checks a sync folder name typed at setup and returns what
 * is wrong with it, or `""` for a usable one: a top-level folder Obsidian
 * shows, named without `/`.
 */
export function syncFolderProblem(name: string): string {
    const n = name.trim();
    if (n === "" || n === ".") return "Enter a folder name.";
    if (/[/\\]/.test(n)) return "Use a top-level folder: a name without /.";
    if (n === "..") return '".." cannot be a folder name.';
    if (n.startsWith(".")) {
        return 'A folder starting with "." is hidden from Obsidian.';
    }
    return "";
}
