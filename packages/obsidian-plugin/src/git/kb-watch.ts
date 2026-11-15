// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The live state of each git knowledge base behind its settings card: a
// check fetches `origin`, re-reads the clone, asks the server for write
// access, and, for a base this person can only read, pins it to a commit
// (the first check pins HEAD) and lists what an update would change. The
// card's actions run here too: clone with progress, pull, push, commit,
// propose on a new branch, accept an update, and move to the pin. Every git
// command runs in the vault root with the clone's folder as `-C`; the
// knowledge base's controller (repos.ts) does what the Git tab also does.

import {
    cloneRepo,
    fastForwardTo,
    fetchRemote,
    type GitExec,
    gitUserName,
    headCommit,
    isAncestor,
    type KnowledgeBase,
    probeAccess,
    proposeBranchName,
    pullRequestUrl,
    pushBranch,
    pushProblem,
    RemoteError,
    remoteCommit,
    type Update,
    updatePreview,
} from "@docket/core";
import { remoteAdvice } from "../settings/knowledge.ts";
import type { GitController } from "./controller.ts";
import type { CheckState, CloneState, KbStatus } from "./kb-card.ts";
import { afterProbe, afterPush, type RoleRecord } from "./kb-role.ts";
import type { GitRepos } from "./repos.ts";

/** KbWatchDeps is what the watch reads and reports through. */
export interface KbWatchDeps {
    /** Runs git in the vault root. */
    exec: GitExec;
    repos: GitRepos;
    /** The knowledge bases in the settings, read on every call. */
    knowledgeBases: () => readonly KnowledgeBase[];
    /** setPin stores a knowledge base's pin in the shared settings. */
    setPin: (name: string, pin: string) => Promise<void>;
    folderExists: (path: string) => Promise<boolean>;
    loadRoles: () => Record<string, RoleRecord>;
    saveRoles: (roles: Record<string, RoleRecord>) => void;
    /** openUrl opens a web page in the system browser. */
    openUrl: (url: string) => void;
    /** now is the time in epoch milliseconds. */
    now: () => number;
    /** today is the local date and time a proposal branch is named after. */
    today: () => Date;
}

/** Entry is what the watch learned about one knowledge base. */
interface Entry {
    folder: boolean;
    clone: CloneState;
    check: CheckState;
    head: string;
    upstream: string;
    pinAhead: boolean;
    update: Update | null;
    busy: boolean;
    abort: AbortController | null;
    /** When the last check started; undefined before any. */
    checkedAt?: number;
}

/** RECHECK_MS is how old a check must be before checkAll repeats it. */
export const RECHECK_MS = 60_000;

/** Proposal is a pushed proposal branch and its pull-request page, if known. */
export interface Proposal {
    branch: string;
    url: string | null;
}

export class KbWatch {
    private readonly entries = new Map<string, Entry>();
    private readonly listeners = new Set<() => void>();
    private roles: Record<string, RoleRecord> | null = null;

    constructor(private readonly deps: KbWatchDeps) {}

    /** subscribe calls `fn` after every change; it returns the unsubscriber. */
    subscribe(fn: () => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    /** status is what the card of the knowledge base `name` is drawn from. */
    status(name: string): KbStatus | undefined {
        const kb = this.kb(name);
        if (kb === undefined || kb.kind !== "git") return undefined;
        const e = this.entry(name);
        const git = this.deps.repos.kb(name);
        const ready = git?.ready === true;
        const remote = git?.remote ?? null;
        const s: KbStatus = {
            name,
            url: kb.url,
            branch: (ready ? git?.branch : "") || kb.branch || "main",
            folder: e.folder,
            clone: e.clone,
            check: e.check,
            role: this.role(name),
            ahead: git?.counts?.ahead ?? 0,
            behind: git?.counts?.behind ?? 0,
            edited: ready ? (git?.changes.length ?? 0) : 0,
            conflicts: remote?.kind === "stash-conflict" ? remote.files : [],
            head: e.head,
            pinAhead: e.pinAhead,
            update: e.update,
            busy: e.busy,
        };
        if (kb.pin !== undefined) s.pin = kb.pin;
        return s;
    }

    /** upstream is where the last check saw `origin`'s branch, `""` before. */
    upstream(name: string): string {
        return this.entries.get(name)?.upstream ?? "";
    }

    /**
     * checkAll checks every git knowledge base, one after another, except
     * one checked less than {@link RECHECK_MS} ago: the settings tab redraws
     * often, and each check talks to the server.
     */
    async checkAll(): Promise<void> {
        const now = this.deps.now();
        for (const kb of this.deps.knowledgeBases()) {
            if (kb.kind !== "git") continue;
            const at = this.entries.get(kb.name)?.checkedAt;
            if (at !== undefined && now - at < RECHECK_MS) continue;
            await this.check(kb.name);
        }
    }

    /**
     * check fetches the knowledge base `name`, re-reads its clone, asks the
     * server for write access, and for a read base pins it (HEAD, when it
     * has no pin yet) and lists what an update would change.
     */
    async check(name: string): Promise<void> {
        const kb = this.kb(name);
        if (kb === undefined || kb.kind !== "git") return;
        const e = this.entry(name);
        e.checkedAt = this.deps.now();
        e.folder = await this.deps.folderExists(name);
        if (!e.folder) return this.emit();
        e.check = { kind: "checking" };
        this.emit();
        const exec = this.deps.exec;
        const git = this.deps.repos.kb(name);
        try {
            await fetchRemote(exec, name);
        } catch (err) {
            e.check = failed(err);
            await git?.refresh();
            return this.emit();
        }
        await git?.refresh();
        const branch = git?.branch ?? "";
        if (branch === "") {
            e.check = { kind: "error", message: "no branch is checked out" };
            return this.emit();
        }
        const access = await probeAccess(exec, name, branch);
        this.setRole(
            name,
            afterProbe(this.role(name), access, this.deps.now()),
        );
        if (access.kind === "offline" || access.kind === "unknown") {
            e.check =
                access.kind === "offline"
                    ? { kind: "offline", message: access.message }
                    : { kind: "error", message: access.message };
            return this.emit();
        }
        e.head = await headCommit(exec, name);
        e.upstream = await remoteCommit(exec, name, branch);
        e.update = null;
        e.pinAhead = false;
        if (this.role(name)?.role === "read") {
            let pin = kb.pin ?? "";
            if (pin === "" && e.head !== "") {
                pin = e.head;
                await this.deps.setPin(name, pin);
            }
            if (
                pin !== "" &&
                e.upstream !== "" &&
                e.upstream !== pin &&
                (await isAncestor(exec, name, pin, e.upstream))
            ) {
                e.update = await updatePreview(exec, name, pin, e.upstream);
            }
            e.pinAhead =
                pin !== "" &&
                e.head !== pin &&
                (await isAncestor(exec, name, e.head, pin));
        }
        e.check = { kind: "ok" };
        this.emit();
    }

    /** pull pulls the knowledge base with the Git tab's pull, then checks it. */
    async pull(name: string): Promise<void> {
        await this.busy(name, async (git) => {
            await git.pull();
        });
    }

    /**
     * push pushes the branch and learns from the outcome: a branch rule
     * marks it protected, a denial makes the role read. It throws git's
     * message when the push failed.
     */
    async push(name: string): Promise<void> {
        await this.busy(name, async (git) => {
            await git.push();
            const r = git.remote;
            const outcome =
                r === null
                    ? "ok"
                    : r.kind === "failed"
                      ? pushProblem(r.message)
                      : "other";
            this.setRole(
                name,
                afterPush(this.role(name), outcome, this.deps.now()),
            );
            if (r?.kind === "failed") throw new Error(r.message);
        });
    }

    /** commit commits every changed file of the knowledge base with `message`. */
    async commit(name: string, message: string): Promise<void> {
        await this.busy(name, async (git) => {
            if (!(await git.commit(git.changes, message))) {
                throw new Error(git.commitError);
            }
        });
    }

    /**
     * propose pushes HEAD to a new branch named after this person and the
     * time, and opens the host's pull-request page for it when the host is
     * known. A denied push makes the role read and throws.
     */
    async propose(name: string): Promise<Proposal> {
        let out: Proposal = { branch: "", url: null };
        await this.busy(name, async (git) => {
            const exec = this.deps.exec;
            const user = await gitUserName(exec, name);
            const branch = proposeBranchName(user, this.deps.today());
            try {
                await pushBranch(exec, name, branch);
            } catch (err) {
                if (err instanceof RemoteError) {
                    const problem = pushProblem(err.message);
                    this.setRole(
                        name,
                        afterPush(this.role(name), problem, this.deps.now()),
                    );
                    if (problem === "denied") {
                        throw new Error(
                            "you may only read this repository, so it takes no branch from you; ask its owner for write access",
                        );
                    }
                }
                throw err;
            }
            const kb = this.kb(name);
            const url =
                kb === undefined
                    ? null
                    : pullRequestUrl(kb.url, git.branch || "main", branch);
            if (url !== null) this.deps.openUrl(url);
            out = { branch, url };
        });
        return out;
    }

    /** markResolved tells git the conflicts in the vault file `path` are resolved. */
    async markResolved(name: string, path: string): Promise<void> {
        await this.busy(name, async (git) => {
            await git.markResolved([path]);
        });
    }

    /** acceptUpdate moves a read base to `origin`'s branch and pins it there. */
    async acceptUpdate(name: string): Promise<void> {
        const target = this.entry(name).upstream;
        if (target === "") return;
        await this.busy(name, async () => {
            await fastForwardTo(this.deps.exec, name, target);
            await this.deps.setPin(name, target);
        });
    }

    /** movePin moves this device's clone forward to the shared pin. */
    async movePin(name: string): Promise<void> {
        const pin = this.kb(name)?.pin ?? "";
        if (pin === "") return;
        await this.busy(name, async () => {
            await fastForwardTo(this.deps.exec, name, pin);
        });
    }

    /**
     * clone clones the knowledge base into its folder, reporting progress,
     * and resolves whether it succeeded; a cancelled clone leaves no trace,
     * a failed one keeps why.
     */
    async clone(name: string): Promise<boolean> {
        const kb = this.kb(name);
        const e = this.entry(name);
        if (kb === undefined || kb.kind !== "git" || e.abort !== null) {
            return false;
        }
        const abort = new AbortController();
        e.abort = abort;
        e.clone = { kind: "running", text: "Starting the clone…", percent: 0 };
        this.emit();
        try {
            await cloneRepo(this.deps.exec, kb.url, kb.name, kb.branch, {
                signal: abort.signal,
                onProgress: (p) => {
                    e.clone = {
                        kind: "running",
                        text: p.text,
                        percent: p.percent,
                    };
                    this.emit();
                },
            });
            e.clone = { kind: "idle" };
            e.folder = true;
            return true;
        } catch (err) {
            e.clone = abort.signal.aborted
                ? { kind: "idle" }
                : { kind: "failed", message: remoteAdvice(err) };
            return false;
        } finally {
            e.abort = null;
            this.emit();
        }
    }

    /** cancel stops a running clone of the knowledge base `name`. */
    cancel(name: string): void {
        this.entries.get(name)?.abort?.abort();
    }

    /** kb is the knowledge base named `name` in the settings. */
    private kb(name: string): KnowledgeBase | undefined {
        return this.deps.knowledgeBases().find((k) => k.name === name);
    }

    /** entry is what the watch knows about `name`, made on first use. */
    private entry(name: string): Entry {
        let e = this.entries.get(name);
        if (e === undefined) {
            e = {
                folder: true,
                clone: { kind: "idle" },
                check: { kind: "checking" },
                head: "",
                upstream: "",
                pinAhead: false,
                update: null,
                busy: false,
                abort: null,
            };
            this.entries.set(name, e);
        }
        return e;
    }

    /** role is the role last learned for `name` on this device. */
    private role(name: string): RoleRecord | undefined {
        this.roles ??= this.deps.loadRoles();
        return this.roles[name];
    }

    /** setRole records `name`'s role on this device; undefined changes nothing. */
    private setRole(name: string, r: RoleRecord | undefined): void {
        if (r === undefined) return;
        this.roles ??= this.deps.loadRoles();
        this.roles = { ...this.roles, [name]: r };
        this.deps.saveRoles(this.roles);
    }

    /**
     * busy runs `op` on the knowledge base's controller, one operation at a
     * time, and checks the base afterwards; `op`'s error is rethrown.
     */
    private async busy(
        name: string,
        op: (git: GitController) => Promise<void>,
    ): Promise<void> {
        const git = this.deps.repos.kb(name);
        const e = this.entry(name);
        if (git === undefined || e.busy) return;
        e.busy = true;
        this.emit();
        try {
            await op(git);
        } finally {
            e.busy = false;
            await this.check(name);
        }
    }

    private emit(): void {
        for (const fn of this.listeners) fn();
    }
}

/** failed is the check state a failed fetch leaves. */
function failed(err: unknown): CheckState {
    if (err instanceof RemoteError && err.problem === "network") {
        return { kind: "offline", message: err.message };
    }
    return { kind: "error", message: remoteAdvice(err) };
}
