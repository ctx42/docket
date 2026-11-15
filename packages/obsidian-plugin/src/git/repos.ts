// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The vault's git repositories: the **vault** repository at the vault root,
// which holds the user's own notes, the **sync** repository in the sync
// folder, which holds the pages docket syncs with Confluence, and one
// repository per git **knowledge base**, cloned into its own top-level folder.
// The vault repository ignores the sync and knowledge-base folders, so every
// vault path belongs to exactly one of them; {@link GitRepos.forPath} picks
// it. Every plugin feature reaches git through this router.
//
// Repositories are created only by the first-run sync-folder step
// ({@link GitRepos.setupSync}) and the Git tab's Initialize buttons, never on
// plugin load, and nothing here ever commits.

import {
    addIgnoreEntry,
    ignorePattern,
    type KnowledgeBase,
} from "@docket/core";
import {
    GITIGNORE,
    type GitController,
    type VaultFiles,
} from "./controller.ts";
import { kbName, type RepoId } from "./history.ts";

/** RepoFiles is the vault file access the router needs on top of a controller's. */
export interface RepoFiles extends VaultFiles {
    /** mkdir creates a folder and its parents. */
    mkdir(path: string): Promise<void>;
}

export class GitRepos {
    /** The knowledge bases' controllers by folder name. */
    private readonly kbs = new Map<string, GitController>();
    private readonly listeners = new Set<() => void>();

    constructor(
        /** The repository at the vault root. */
        readonly vault: GitController,
        /** The repository in the sync folder. */
        readonly sync: GitController,
        private readonly files: RepoFiles,
        /** Builds the controller of the knowledge base in a vault folder. */
        private readonly openKb: (name: string) => GitController,
    ) {}

    /**
     * setKnowledgeBases makes the git knowledge bases in the vault folders
     * `names` the known ones: it opens a controller for each new one and
     * disposes each dropped one, tells the listeners when the set changed,
     * and returns the new controllers, which have not been read yet.
     */
    setKnowledgeBases(names: readonly string[]): GitController[] {
        const want = new Set(names);
        let changed = false;
        for (const [name, git] of this.kbs) {
            if (want.has(name)) continue;
            git.dispose();
            this.kbs.delete(name);
            changed = true;
        }
        const added: GitController[] = [];
        for (const name of want) {
            if (this.kbs.has(name)) continue;
            const git = this.openKb(name);
            this.kbs.set(name, git);
            added.push(git);
            changed = true;
        }
        if (changed) for (const fn of this.listeners) fn();
        return added;
    }

    /** onChange calls `fn` whenever the set of knowledge bases changes. */
    onChange(fn: () => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    /**
     * each runs `setup` for every controller now and every one added later,
     * and the cleanup it returns when that controller is dropped or `each` is
     * stopped. It returns the stop function.
     */
    each(setup: (git: GitController) => () => void): () => void {
        const live = new Map<GitController, () => void>();
        const sync = (): void => {
            const now = new Set(this.all());
            for (const [git, cleanup] of live) {
                if (now.has(git)) continue;
                cleanup();
                live.delete(git);
            }
            for (const git of now) {
                if (!live.has(git)) live.set(git, setup(git));
            }
        };
        sync();
        const off = this.onChange(sync);
        return () => {
            off();
            for (const cleanup of live.values()) cleanup();
            live.clear();
        };
    }

    /** kbNames lists the knowledge bases' folder names, sorted. */
    kbNames(): string[] {
        return [...this.kbs.keys()].sort();
    }

    /** kb returns the controller of the knowledge base in folder `name`. */
    kb(name: string): GitController | undefined {
        return this.kbs.get(name);
    }

    /** get returns the controller with id `id`; undefined for an unknown base. */
    get(id: RepoId): GitController | undefined {
        if (id === "vault") return this.vault;
        if (id === "sync") return this.sync;
        return this.kbs.get(kbName(id) ?? "");
    }

    /**
     * forPath returns the controller owning a vault path: a knowledge base's
     * for its folder and anything under it, the sync one for the sync folder
     * and anything under it, else the vault one.
     */
    forPath(path: string): GitController {
        for (const [name, git] of this.kbs) {
            if (under(path, name)) return git;
        }
        const root = this.sync.root;
        if (root === null || root === "") return this.vault;
        return under(path, root) ? this.sync : this.vault;
    }

    /** all lists every controller: vault, sync, then the knowledge bases by name. */
    all(): GitController[] {
        return [
            this.vault,
            this.sync,
            ...this.kbNames().map((n) => this.kbs.get(n) as GitController),
        ];
    }

    /** refresh re-reads every repository. */
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

    /** dispose cancels every controller's pending refresh. */
    dispose(): void {
        for (const c of this.all()) c.dispose();
    }
}

/**
 * gitKbNames names the vault folders of the git knowledge bases among `kbs`;
 * a local-folder knowledge base stays in the vault repository.
 */
export function gitKbNames(kbs: readonly KnowledgeBase[]): string[] {
    return kbs.filter((kb) => kb.kind === "git").map((kb) => kb.name);
}

/** under reports whether a vault path is the folder `root` or inside it. */
function under(path: string, root: string): boolean {
    return path === root || path.startsWith(`${root}/`);
}

/** relative is a vault path relative to the root of the repository `git`. */
function relative(git: GitController, path: string): string {
    const root = git.root ?? "";
    if (root === "") return path;
    return path === root ? "" : path.slice(root.length + 1);
}
