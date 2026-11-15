// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// A pinned knowledge base: the clone stays at the commit the vault's settings
// pin, and an update shows what it would change before anyone accepts it.
// Each function runs git in the clone's folder `dir`, relative to the vault.

import type { GitExec } from "../ports/git.ts";
import { BATCH_ENV, RemoteError } from "./remote.ts";
import { GitError } from "./repo.ts";

/** HASH matches a full commit hash. */
const HASH = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** fetchRemote fetches `origin`; it throws a {@link RemoteError} on failure. */
export async function fetchRemote(exec: GitExec, dir: string): Promise<void> {
    const args = ["-C", dir, "fetch", "--quiet", "origin"];
    const out = await exec.run(args, { env: { ...BATCH_ENV } });
    if (out.code !== 0) throw new RemoteError(args, out);
}

/** headCommit is the commit HEAD points at, `""` before the first one. */
export function headCommit(exec: GitExec, dir: string): Promise<string> {
    return revParse(exec, dir, "HEAD");
}

/**
 * remoteCommit is where the last fetch saw `origin`'s `branch`, `""` when it
 * is unknown.
 */
export function remoteCommit(
    exec: GitExec,
    dir: string,
    branch: string,
): Promise<string> {
    return revParse(exec, dir, `refs/remotes/origin/${branch}`);
}

/** Update is what moving a clone from one commit to another would change. */
export interface Update {
    /** How many commits the move takes in. */
    commits: number;
    changed: string[];
    added: string[];
    removed: string[];
}

/**
 * updatePreview lists what moving the clone in `dir` from commit `from` to
 * `to` would change: its commits and the paths changed, added, and removed.
 */
export async function updatePreview(
    exec: GitExec,
    dir: string,
    from: string,
    to: string,
): Promise<Update> {
    const out: Update = { commits: 0, changed: [], added: [], removed: [] };
    if (from === to) return out;
    const count = await ok(exec, [
        "-C",
        dir,
        "rev-list",
        "--count",
        `${commit(from)}..${commit(to)}`,
    ]);
    out.commits = Number(count.trim()) || 0;
    const diff = await ok(exec, [
        "-C",
        dir,
        "diff",
        "--name-status",
        "-z",
        "--no-renames",
        from,
        to,
        "--",
    ]);
    const parts = diff.split("\0");
    for (let i = 0; i + 1 < parts.length; i += 2) {
        const status = parts[i] as string;
        const path = parts[i + 1] as string;
        if (status === "A") out.added.push(path);
        else if (status === "D") out.removed.push(path);
        else if (status !== "") out.changed.push(path);
    }
    for (const list of [out.changed, out.added, out.removed]) list.sort();
    return out;
}

/**
 * fastForwardTo moves the clone's branch forward to `target`; git refuses
 * when that is no fast-forward or would overwrite uncommitted edits.
 */
export async function fastForwardTo(
    exec: GitExec,
    dir: string,
    target: string,
): Promise<void> {
    await ok(exec, [
        "-C",
        dir,
        "merge",
        "--ff-only",
        "--quiet",
        commit(target),
    ]);
}

/** isAncestor reports whether commit `a` is `b` or one of its ancestors. */
export async function isAncestor(
    exec: GitExec,
    dir: string,
    a: string,
    b: string,
): Promise<boolean> {
    const out = await exec.run([
        "-C",
        dir,
        "merge-base",
        "--is-ancestor",
        commit(a),
        commit(b),
    ]);
    return out.code === 0;
}

/** revParse resolves a ref to its commit, `""` when it does not exist. */
async function revParse(
    exec: GitExec,
    dir: string,
    ref: string,
): Promise<string> {
    const out = await exec.run(["-C", dir, "rev-parse", "--verify", "-q", ref]);
    return out.code === 0 ? out.stdout.trim() : "";
}

/** commit returns a full commit hash, or throws for anything else. */
function commit(hash: string): string {
    if (!HASH.test(hash)) throw new Error(`"${hash}" is not a commit`);
    return hash;
}

/** ok runs git and returns stdout, or throws a {@link GitError}. */
async function ok(exec: GitExec, args: string[]): Promise<string> {
    const out = await exec.run(args);
    if (out.code !== 0) throw new GitError(args, out);
    return out.stdout;
}
