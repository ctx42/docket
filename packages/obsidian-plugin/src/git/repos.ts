// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The vault's two git repositories: the **vault** repository at the vault root,
// which holds the user's own notes, and the **sync** repository in the sync
// folder, which holds the pages docket syncs with Confluence. The vault
// repository ignores the sync folder, so every vault path belongs to exactly
// one of them; {@link GitRepos.forPath} picks it. Every plugin feature reaches
// git through this router.
//
// Repositories are created only by the first-run sync-folder step
// ({@link GitRepos.setupSync}) and the Git tab's Initialize buttons, never on
// plugin load, and nothing here ever commits.

import { addIgnoreEntry, ignorePattern } from "@docket/core";
import {
    GITIGNORE,
    type GitController,
    type VaultFiles,
} from "./controller.ts";

/** RepoFiles is the vault file access the router needs on top of a controller's. */
export interface RepoFiles extends VaultFiles {
    /** mkdir creates a folder and its parents. */
    mkdir(path: string): Promise<void>;
}

export class GitRepos {
    constructor(
        /** The repository at the vault root. */
        readonly vault: GitController,
        /** The repository in the sync folder. */
        readonly sync: GitController,
        private readonly files: RepoFiles,
    ) {}

    /**
     * forPath returns the controller owning a vault path: the sync one for the
     * sync folder and anything under it, else the vault one.
     */
    forPath(path: string): GitController {
        const root = this.sync.root;
        if (root === null || root === "") return this.vault;
        return path === root || path.startsWith(`${root}/`)
            ? this.sync
            : this.vault;
    }

    /** all lists both controllers, the vault one first. */
    all(): GitController[] {
        return [this.vault, this.sync];
    }

    /** refresh re-reads both repositories. */
    async refresh(): Promise<void> {
        await Promise.all(this.all().map((c) => c.refresh()));
    }

    /**
     * ignorable reports whether "Ignore in Git" applies to a vault path: not
     * to the vault root, the sync folder itself, or a repository's
     * `.gitignore`.
     */
    ignorable(path: string): boolean {
        if (path === "" || path === "/") return false;
        const git = this.forPath(path);
        const local = relative(git, path);
        return local !== "" && local !== GITIGNORE;
    }

    /**
     * ignore adds a file or folder to the ignore block of the repository
     * owning it, as a pattern relative to that repository. When git tracks
     * files under the path, `confirm` sees them first; on yes they are
     * untracked too, so their removals show staged. No changes nothing.
     */
    async ignore(
        path: string,
        folder: boolean,
        confirm: (tracked: string[]) => Promise<boolean>,
    ): Promise<void> {
        if (!this.ignorable(path)) return;
        const git = this.forPath(path);
        const tracked = await git.trackedUnder(path);
        if (tracked.length > 0 && !(await confirm(tracked))) return;
        const pattern = ignorePattern(relative(git, path), folder);
        await git.ignore(
            (text) => addIgnoreEntry(text, pattern, git.ignores),
            tracked.length > 0 ? path : "",
        );
    }

    /**
     * setupSync finishes the first-run sync-folder step for the folder already
     * saved as the sync root: it creates the folder and, when git is found,
     * initializes the vault repository unless there is one, then the sync
     * repository (see {@link initializeSync}). Without git it creates the
     * folder only.
     */
    async setupSync(): Promise<void> {
        const root = this.syncRoot();
        if (!(await this.files.isFolder(root))) await this.files.mkdir(root);
        await this.vault.refresh();
        const kind = this.vault.state.kind;
        if (kind === "no-git" || kind === "unavailable") return;
        if (kind === "no-repo") await this.vault.initialize();
        await this.initializeSync();
    }

    /**
     * initializeSync initializes the sync repository with its ignore block,
     * unless the folder is one already, and adds the sync folder to the vault
     * repository's ignore block.
     */
    async initializeSync(): Promise<void> {
        const root = this.syncRoot();
        await this.sync.refresh();
        if (!this.sync.ready) await this.sync.initialize();
        await this.vault.ignore(
            (text) =>
                addIgnoreEntry(
                    text,
                    ignorePattern(root, true),
                    this.vault.ignores,
                ),
            "",
        );
    }

    /** syncRoot is the sync folder's vault path; it throws when none is set. */
    private syncRoot(): string {
        const root = this.sync.root;
        if (root === null || root === "") {
            throw new Error("no sync folder is set");
        }
        return root;
    }

    /** dispose cancels both controllers' pending refreshes. */
    dispose(): void {
        for (const c of this.all()) c.dispose();
    }
}

/** relative is a vault path relative to the root of the repository `git`. */
function relative(git: GitController, path: string): string {
    const root = git.root ?? "";
    if (root === "") return path;
    return path === root ? "" : path.slice(root.length + 1);
}
