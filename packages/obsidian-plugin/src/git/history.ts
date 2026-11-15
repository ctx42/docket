// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// This device's commit-message history: the messages it committed, most recent
// first, kept per repository and offered again in that repository's Git tab.
// Pure, so it carries no Obsidian import; settings/store.ts persists it.

/** KbRepoId names a git knowledge base's repository by its vault folder. */
export type KbRepoId = `kb:${string}`;

/**
 * RepoId names one of the vault's repositories (see repos.ts): the vault
 * repository, the sync repository, or a git knowledge base's.
 */
export type RepoId = "vault" | "sync" | KbRepoId;

/** kbRepoId is the id of the knowledge base in vault folder `name`. */
export function kbRepoId(name: string): KbRepoId {
    return `kb:${name}`;
}

/**
 * kbName is a knowledge base id's folder name, or null for any other id, such
 * as vault and sync.
 */
export function kbName(id: string): string | null {
    return id.startsWith("kb:") ? id.slice(3) : null;
}

/** HISTORY_CAP is how many messages a device keeps unless told otherwise. */
export const HISTORY_CAP = 20;

/** HISTORY_CAP_MAX is the largest history cap the setting accepts. */
export const HISTORY_CAP_MAX = 100;

/**
 * recordMessage puts the trimmed `message` first in `list`, drops any older
 * entry equal to it after trimming, and cuts the result to `cap` entries. A
 * blank message leaves the list as it is, cut to `cap`.
 */
export function recordMessage(
    list: readonly string[],
    message: string,
    cap: number,
): string[] {
    const m = message.trim();
    if (m === "") return capHistory(list, cap);
    const rest = list.filter((e) => e.trim() !== m);
    return capHistory([m, ...rest], cap);
}

/** capHistory keeps the `cap` most recent entries of `list`. */
export function capHistory(list: readonly string[], cap: number): string[] {
    return list.slice(0, Math.max(0, cap));
}

/**
 * parseHistoryCap reads a history cap typed into the settings: a whole number
 * from 0 to {@link HISTORY_CAP_MAX}, or null for anything else.
 */
export function parseHistoryCap(text: string): number | null {
    const t = text.trim();
    if (!/^\d+$/.test(t)) return null;
    const n = Number(t);
    return n <= HISTORY_CAP_MAX ? n : null;
}

/** firstLine returns a message's first line, as the history picker shows it. */
export function firstLine(message: string): string {
    return message.split(/\r?\n/, 1)[0] ?? "";
}

/**
 * CommitHistory holds this device's messages for every repository. It loads a
 * repository's list on first use, cut to the cap, and saves a list whenever it
 * changes.
 */
export class CommitHistory {
    private readonly lists = new Map<RepoId, string[]>();

    constructor(
        private readonly load: (repo: RepoId) => string[],
        private readonly save: (repo: RepoId, list: string[]) => void,
        private cap: number,
    ) {}

    /** get returns `repo`'s messages, most recent first. */
    get(repo: RepoId): string[] {
        let list = this.lists.get(repo);
        if (list === undefined) {
            list = capHistory(this.load(repo), this.cap);
            this.lists.set(repo, list);
        }
        return list;
    }

    /** record puts a message first in `repo`'s list and saves it. */
    record(repo: RepoId, message: string): void {
        this.put(repo, recordMessage(this.get(repo), message, this.cap));
    }

    /**
     * setCap changes how many messages each list keeps, trimming and saving
     * every loaded list; the others are cut when they load.
     */
    setCap(cap: number): void {
        this.cap = cap;
        for (const [repo, list] of this.lists) {
            this.put(repo, capHistory(list, cap));
        }
    }

    private put(repo: RepoId, list: string[]): void {
        this.lists.set(repo, list);
        this.save(repo, list);
    }
}
