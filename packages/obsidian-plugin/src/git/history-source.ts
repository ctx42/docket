// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Whose history the History tab lists: a whole repository (Vault or
// Confluence mode), or the active note's in the repository owning it (Note
// mode). For a move not yet committed, Note mode asks for the old path, whose
// history `git log --follow` continues. Obsidian-free, so it unit-tests.

import type { GitController } from "./controller.ts";
import type { GitRepos } from "./repos.ts";

/** HistoryMode is whose history the tab shows. */
export type HistoryMode = "note" | "vault" | "sync";

/** HistorySource is the repository to read and the path to follow, if any. */
export interface HistorySource {
    git: GitController;
    /** The note path to follow; null lists the whole repository. */
    path: string | null;
}

/**
 * historySource returns what `mode` lists given the active note's path, or
 * null in Note mode without an open note.
 */
export function historySource(
    repos: GitRepos,
    mode: HistoryMode,
    active: string | null,
): HistorySource | null {
    if (mode === "vault") return { git: repos.vault, path: null };
    if (mode === "sync") return { git: repos.sync, path: null };
    if (active === null) return null;
    const git = repos.forPath(active);
    const moved = git.changes.find((c) => c.path === active && c.from !== "");
    return { git, path: moved?.from ?? active };
}
