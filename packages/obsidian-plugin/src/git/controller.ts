// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The plugin's git controller: it owns the vault repository's state, the change
// list, and every git operation, so the Git and History tabs, the context menu,
// and the editor change bars share one view of the repository. `git status` is
// the change list's only source; vault events, the panel opening, a finished
// sync run, and a finished git operation merely trigger a refresh. Operations
// run one at a time, so a refresh never races a commit for the index lock.
// Obsidian glue; the logic lives in core's `git/` modules.

import {
    defaultIgnoreBlock,
    type GitChange,
    GitRepo,
    type LogEntry,
    type LogQuery,
    type RepoState,
} from "@docket/core";
import { type App, FileSystemAdapter, Notice } from "obsidian";
import { NodeFileSystem } from "../adapters/fs-node.ts";
import { NodeGitExec } from "../adapters/git.ts";

/** REFRESH_DEBOUNCE_MS coalesces a burst of vault events into one status. */
export const REFRESH_DEBOUNCE_MS = 1000;

/** GITIGNORE is the vault-root ignore file docket keeps its block in. */
export const GITIGNORE = ".gitignore";

/** RepoView is the controller's state, or `unavailable` without a disk vault. */
export type RepoView =
    | RepoState
    | { kind: "unavailable" }
    | { kind: "unknown" };

export class GitController {
    private readonly repo: GitRepo | null;
    private repoState: RepoView = { kind: "unknown" };
    private changeList: GitChange[] = [];
    private refreshError = "";
    private busyFlag = false;
    private lastCommitError = "";
    private readonly listeners = new Set<() => void>();
    private readonly watchers = new Set<() => void>();
    private readonly committed = new Set<() => void>();
    private chain: Promise<unknown> = Promise.resolve();
    private timer: number | null = null;

    /**
     * `gitPath` returns this device's git path setting, read on every call;
     * `record` keeps each successfully committed message.
     */
    constructor(
        private readonly app: App,
        gitPath: () => string,
        private readonly record: (message: string) => void,
    ) {
        const adapter = app.vault.adapter;
        this.repo =
            adapter instanceof FileSystemAdapter
                ? new GitRepo(
                      new NodeGitExec(gitPath, adapter.getBasePath()),
                      new NodeFileSystem(),
                  )
                : null;
        if (this.repo === null) this.repoState = { kind: "unavailable" };
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

    /** busy reports whether a commit, ignore, or initialize is in flight. */
    get busy(): boolean {
        return this.busyFlag;
    }

    /** commitError is the error the last commit failed with, or `""`. */
    get commitError(): string {
        return this.lastCommitError;
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
        const repo = this.repo;
        if (repo === null) return;
        try {
            this.repoState = await repo.state();
            this.changeList =
                this.repoState.kind === "ready" ? await repo.status() : [];
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
            await this.writeIgnore(defaultIgnoreBlock(await this.readIgnore()));
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
            this.record(msg);
            made = true;
        });
        if (made) for (const fn of this.committed) fn();
        return made;
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
        if (this.repo === null || !this.ready)
            return Promise.resolve(undefined);
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
            new Notice("docket: wait for the git operation to finish");
            return;
        }
        this.busyFlag = true;
        this.emit();
        try {
            await this.queue(() => op(this.need()));
        } catch (err) {
            new Notice(`docket: ${message(err)}`);
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

    /** need returns the repository, throwing for a vault without a disk path. */
    private need(): GitRepo {
        if (this.repo === null) throw new Error("git needs a vault on disk");
        return this.repo;
    }

    private async readIgnore(): Promise<string> {
        const a = this.app.vault.adapter;
        return (await a.exists(GITIGNORE)) ? a.read(GITIGNORE) : "";
    }

    private async writeIgnore(text: string): Promise<void> {
        await this.app.vault.adapter.write(GITIGNORE, text);
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
