// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The plugin's git controller: it owns one repository's state, its change list,
// and every git operation on it, so the Git and History tabs, the context menu,
// and the editor change bars share one view of the repository. The repository
// is rooted in a vault folder — the vault root, or the sync folder (see
// repos.ts) — and the controller speaks vault paths only. `git status` is the
// change list's only source; vault events, the panel opening, a finished sync
// run, and a finished git operation merely trigger a refresh. Operations run
// one at a time, so a refresh never races a commit for the index lock. The
// Obsidian side is injected (see {@link ControllerDeps}); the logic lives in
// core's `git/` modules.

import {
    type AheadBehind,
    DEFAULT_IGNORES,
    defaultIgnoreBlock,
    type GitChange,
    type GitRepo,
    type LogEntry,
    type LogQuery,
    type RepoState,
} from "@docket/core";

/** REFRESH_DEBOUNCE_MS coalesces a burst of vault events into one status. */
export const REFRESH_DEBOUNCE_MS = 1000;

/** GITIGNORE is the repository-root ignore file docket keeps its block in. */
export const GITIGNORE = ".gitignore";

/** RepoView is the controller's state, or `unavailable` without a disk vault. */
export type RepoView =
    | RepoState
    /** No folder is set, or the set one does not exist. */
    | { kind: "no-folder" }
    | { kind: "unavailable" }
    | { kind: "unknown" };

/**
 * RemoteOutcome is how the last pull or push went wrong: it failed with git's
 * message, its rebase conflicted and was aborted, or re-applying the local
 * changes after it conflicted (they stay in the stash).
 */
export type RemoteOutcome =
    | { kind: "failed"; message: string }
    | { kind: "conflict"; message: string; files: string[] }
    | { kind: "stash-conflict"; files: string[] };

/** VaultFiles is the vault file access a controller needs, by vault path. */
export interface VaultFiles {
    /** isFolder reports whether a folder exists at `path`. */
    isFolder(path: string): Promise<boolean>;
    /** read returns a file's text, or null when it does not exist. */
    read(path: string): Promise<string | null>;
    write(path: string, text: string): Promise<void>;
}

/** ControllerDeps is what a {@link GitController} is built from. */
export interface ControllerDeps {
    /**
     * root returns the repository folder's vault path, `""` for the vault
     * root, or null when no folder is set; read on every refresh.
     */
    root: () => string | null;
    /** open returns the repository rooted at a vault folder; absent without a disk vault. */
    open?: (root: string) => GitRepo;
    files: VaultFiles;
    /** notify shows a failure to the user. */
    notify: (text: string) => void;
    /** record keeps each successfully committed message. */
    record: (message: string) => void;
    /** The entries a newly written ignore block starts with. */
    ignores?: readonly string[];
}

export class GitController {
    /** The repository last opened, and the root it was opened at. */
    private opened: { root: string; repo: GitRepo } | null = null;
    private repoState: RepoView = { kind: "unknown" };
    private changeList: GitChange[] = [];
    private refreshError = "";
    private busyFlag = false;
    private lastCommitError = "";
    private lastRemote: RemoteOutcome | null = null;
    private aheadBehind: AheadBehind | null = null;
    private readonly listeners = new Set<() => void>();
    private readonly watchers = new Set<() => void>();
    private readonly committed = new Set<() => void>();
    private chain: Promise<unknown> = Promise.resolve();
    private timer: number | null = null;

    constructor(private readonly deps: ControllerDeps) {
        if (deps.open === undefined) this.repoState = { kind: "unavailable" };
    }

    /** ignores are the entries a newly written ignore block starts with. */
    get ignores(): readonly string[] {
        return this.deps.ignores ?? DEFAULT_IGNORES;
    }

    /** root is the repository folder's vault path, or null when none is set. */
    get root(): string | null {
        return this.deps.root();
    }

    /**
     * subscribe calls `fn` on every change and returns its unsubscriber. The
     * first subscriber (the panel opening) triggers a refresh.
     */
    subscribe(fn: () => void): () => void {
        this.listeners.add(fn);
        if (this.listeners.size === 1) void this.refresh();
        return () => this.listeners.delete(fn);
    }

    /**
     * watch calls `fn` on every change, like {@link subscribe}, but as a
     * background observer: it neither triggers a refresh nor enables the
     * vault-event refreshes a panel does.
     */
    watch(fn: () => void): () => void {
        this.watchers.add(fn);
        return () => this.watchers.delete(fn);
    }

    /** onCommitted calls `fn` after every commit (HEAD moved). */
    onCommitted(fn: () => void): () => void {
        this.committed.add(fn);
        return () => this.committed.delete(fn);
    }

    get state(): RepoView {
        return this.repoState;
    }

    get ready(): boolean {
        return this.repoState.kind === "ready";
    }

    /** changes is the last `git status`, HEAD → working tree. */
    get changes(): GitChange[] {
        return this.changeList;
    }

    /** error is the last refresh's failure, or `""`. */
    get error(): string {
        return this.refreshError;
    }

    /** busy reports whether a git operation (commit, pull, push, ignore, initialize) is in flight. */
    get busy(): boolean {
        return this.busyFlag;
    }

    /** commitError is the error the last commit failed with, or `""`. */
    get commitError(): string {
        return this.lastCommitError;
    }

    /** remote is how the last pull or push went wrong, or null. */
    get remote(): RemoteOutcome | null {
        return this.lastRemote;
    }

    /** counts are the commits ahead of and behind the upstream, or null. */
    get counts(): AheadBehind | null {
        return this.aheadBehind;
    }

    /**
     * changed schedules a debounced refresh after a vault event; nothing runs
     * while no panel is listening (it refreshes on opening).
     */
    changed(): void {
        if (this.listeners.size === 0) return;
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => {
            this.timer = null;
            void this.refresh();
        }, REFRESH_DEBOUNCE_MS);
    }

    /** dispose cancels a pending refresh. */
    dispose(): void {
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.timer = null;
    }

    /** refresh re-reads the repository state and, when ready, its status. */
    refresh(): Promise<void> {
        return this.queue(() => this.load());
    }

    /** load is {@link refresh}'s body, run inside the queue. */
    private async load(): Promise<void> {
        if (this.deps.open === undefined) return;
        try {
            const repo = await this.current();
            if (repo === null) {
                this.repoState = { kind: "no-folder" };
                this.changeList = [];
                this.aheadBehind = null;
                this.refreshError = "";
                this.emit();
                return;
            }
            this.repoState = await repo.state();
            const ready = this.repoState.kind === "ready";
            this.changeList = ready ? await repo.status() : [];
            this.aheadBehind = ready ? await repo.aheadBehind() : null;
            this.refreshError = "";
        } catch (err) {
            this.refreshError = message(err);
        }
        this.emit();
    }

    /** initialize runs `git init` and writes the default ignore block; no commit. */
    async initialize(): Promise<void> {
        await this.operate(async (repo) => {
            await repo.init();
            await this.writeIgnore(
                defaultIgnoreBlock(await this.readIgnore(), this.ignores),
            );
        });
    }

    /**
     * commit makes one commit of `changes` with `msg` and reports whether it
     * did. A success clears {@link commitError} and records the message; a
     * failure keeps git's error there and records nothing.
     */
    async commit(changes: GitChange[], msg: string): Promise<boolean> {
        let made = false;
        await this.operate(async (repo) => {
            try {
                await repo.commit(changes, msg);
            } catch (err) {
                this.lastCommitError = message(err);
                return;
            }
            this.lastCommitError = "";
            this.deps.record(msg);
            made = true;
        });
        if (made) for (const fn of this.committed) fn();
        return made;
    }

    /**
     * pull rebases the branch onto its upstream, keeping local changes (see
     * core `GitRepo.pull`), and records how it went in {@link remote}.
     */
    async pull(): Promise<void> {
        await this.operate(async (repo) => {
            try {
                const r = await repo.pull();
                this.lastRemote = r.kind === "pulled" ? null : r;
            } catch (err) {
                this.lastRemote = { kind: "failed", message: message(err) };
            }
        });
    }

    /** push pushes the branch to its upstream, recording a failure in {@link remote}. */
    async push(): Promise<void> {
        await this.operate(async (repo) => {
            try {
                await repo.push();
                this.lastRemote = null;
            } catch (err) {
                this.lastRemote = { kind: "failed", message: message(err) };
            }
        });
    }

    /** trackedUnder lists the tracked files at or under a vault path. */
    trackedUnder(path: string): Promise<string[]> {
        return this.queue(() => this.need().trackedUnder(path));
    }

    /**
     * ignore writes `.gitignore` through `edit` and untracks `untrack` (when
     * not empty), so the removals show as staged changes.
     */
    async ignore(
        edit: (text: string) => string,
        untrack: string,
    ): Promise<void> {
        await this.operate(async (repo) => {
            await this.writeIgnore(edit(await this.readIgnore()));
            if (untrack !== "") await repo.untrack(untrack);
        });
    }

    /** log lists a page of history (see core `GitRepo.log`). */
    log(q: LogQuery): Promise<LogEntry[]> {
        return this.queue(() => this.need().log(q));
    }

    /** baseText is the text a note's change bars compare against. */
    baseText(path: string): Promise<string | undefined> {
        if (!this.ready) return Promise.resolve(undefined);
        return this.queue(() => this.need().baseText(path));
    }

    /** textAt is a file's text at a commit (see core `GitRepo.textAt`). */
    textAt(commit: string, path: string): Promise<string> {
        return this.queue(() => this.need().textAt(commit, path));
    }

    /**
     * operate runs a mutating git operation under the busy flag, reporting a
     * failure as a notice, then refreshes the change list.
     */
    private async operate(op: (repo: GitRepo) => Promise<void>): Promise<void> {
        if (this.busyFlag) {
            this.deps.notify("docket: wait for the git operation to finish");
            return;
        }
        this.busyFlag = true;
        this.emit();
        try {
            await this.queue(() => op(this.need()));
        } catch (err) {
            this.deps.notify(`docket: ${message(err)}`);
        }
        this.busyFlag = false;
        await this.refresh();
    }

    /** queue runs `fn` after every operation queued before it. */
    private queue<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.chain.then(fn, fn);
        this.chain = run.catch(() => undefined);
        return run;
    }

    /**
     * current returns the repository at the folder's present root, or null
     * when no folder is set or it does not exist: git cannot run there.
     */
    private async current(): Promise<GitRepo | null> {
        const root = this.deps.root();
        if (root === null) return null;
        if (root !== "" && !(await this.deps.files.isFolder(root))) {
            return null;
        }
        return this.repoAt(root);
    }

    /** repoAt returns the repository rooted at `root`, reopened on a change. */
    private repoAt(root: string): GitRepo {
        const open = this.deps.open;
        if (open === undefined) throw new Error("git needs a vault on disk");
        if (this.opened?.root !== root) {
            this.opened = { root, repo: open(root) };
        }
        return this.opened.repo;
    }

    /** need returns the repository, throwing when git cannot run in it. */
    private need(): GitRepo {
        const root = this.deps.root();
        if (root === null)
            throw new Error("no folder is set for this repository");
        return this.repoAt(root);
    }

    /** ignoreFile is the vault path of the repository's `.gitignore`. */
    private ignoreFile(): string {
        const root = this.deps.root() ?? "";
        return root === "" ? GITIGNORE : `${root}/${GITIGNORE}`;
    }

    private async readIgnore(): Promise<string> {
        return (await this.deps.files.read(this.ignoreFile())) ?? "";
    }

    private async writeIgnore(text: string): Promise<void> {
        await this.deps.files.write(this.ignoreFile(), text);
    }

    private emit(): void {
        for (const fn of this.listeners) fn();
        for (const fn of this.watchers) fn();
    }
}

/** message returns an unknown thrown value's message. */
function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
