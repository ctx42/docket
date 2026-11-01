// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The git operations that talk to a remote for knowledge bases: listing a
// repository's branches, cloning it into a vault folder, fast-forward pulls,
// and reading where an existing clone came from. They run git without prompts — SSH in batch mode, terminal prompts
// off — so a missing key or an unknown host fails at once instead of waiting
// for input nobody can give, and a failure says which of those it was.

import type { GitExec, GitOutput } from "../ports/git.ts";
import { GitError } from "./repo.ts";

/**
 * BATCH_ENV turns off every git and SSH prompt: SSH uses the agent or an
 * unencrypted key, and fails on a passphrase or an unknown host key.
 */
export const BATCH_ENV: Readonly<Record<string, string>> = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
};

/**
 * RemoteProblem is what kind of failure a remote operation hit: the server
 * refused the login (`auth`), the host key is unknown or changed (`host-key`),
 * the repository does not exist or is hidden (`not-found`), the host cannot
 * be reached (`network`), or anything else (`other`).
 */
export type RemoteProblem =
    | "auth"
    | "host-key"
    | "not-found"
    | "network"
    | "other";

/** PROBLEMS maps stderr patterns to the problem they show, first match wins. */
const PROBLEMS: [RegExp, RemoteProblem][] = [
    [/Host key verification failed/i, "host-key"],
    [/Permission denied \(publickey/i, "auth"],
    [/Authentication failed/i, "auth"],
    [/could not read Username/i, "auth"],
    [/Repository not found/i, "not-found"],
    [/does not appear to be a git repository/i, "not-found"],
    [/Could not resolve hostname/i, "network"],
    [/Connection (timed out|refused)/i, "network"],
    [/Network is unreachable/i, "network"],
];

/** remoteProblem reads which {@link RemoteProblem} git's stderr shows. */
export function remoteProblem(stderr: string): RemoteProblem {
    return PROBLEMS.find(([re]) => re.test(stderr))?.[1] ?? "other";
}

/** RemoteError is a failed remote operation and the kind of problem it hit. */
export class RemoteError extends GitError {
    readonly problem: RemoteProblem;

    constructor(args: string[], output: GitOutput) {
        super(args, output);
        this.name = "RemoteError";
        this.problem = remoteProblem(output.stderr);
    }
}

/** RemoteInfo is what `git ls-remote` tells about a repository. */
export interface RemoteInfo {
    /** The default branch; `""` when the server does not say. */
    head: string;
    /** The branch names, sorted. */
    branches: string[];
}

/**
 * lsRemote lists the branches of the repository at `url` and its default
 * branch. It throws {@link RemoteError} when git fails, and refuses a URL that
 * starts with `-`, which git would read as an option.
 */
export async function lsRemote(
    exec: GitExec,
    url: string,
): Promise<RemoteInfo> {
    const out = await remote(exec, ["ls-remote", "--symref", checkUrl(url)]);
    let head = "";
    const branches: string[] = [];
    for (const line of out.split("\n")) {
        const sym = /^ref: refs\/heads\/(.+)\tHEAD$/.exec(line);
        if (sym !== null) {
            head = sym[1] ?? "";
            continue;
        }
        const ref = /^\S+\trefs\/heads\/(.+)$/.exec(line);
        if (ref !== null) branches.push(ref[1] ?? "");
    }
    return { head, branches: branches.sort() };
}

/**
 * cloneRepo clones `url` into `dir` (relative to where `exec` runs), checking
 * out `branch`, or the default branch for `""`. It throws {@link RemoteError}
 * when git fails.
 */
export async function cloneRepo(
    exec: GitExec,
    url: string,
    dir: string,
    branch: string,
): Promise<void> {
    const pick = branch === "" ? [] : ["--branch", branch];
    await remote(exec, ["clone", ...pick, "--", checkUrl(url), dir]);
}

/**
 * pullFastForward pulls the repository in `dir`, refusing to merge: it fails
 * with {@link RemoteError} when local commits and the remote have split.
 */
export async function pullFastForward(
    exec: GitExec,
    dir: string,
): Promise<void> {
    await remote(exec, ["-C", dir, "pull", "--ff-only"]);
}

/** CloneInfo is what an existing clone says about where it came from. */
export interface CloneInfo {
    /** The URL of `origin`, else of the first remote; `""` without remotes. */
    url: string;
    /** The checked-out branch; `""` on a detached HEAD. */
    branch: string;
}

/**
 * cloneInfo reads the remote URL and the checked-out branch of the clone in
 * `dir`, without network access. It throws {@link GitError} when `dir` is no
 * repository.
 */
export async function cloneInfo(
    exec: GitExec,
    dir: string,
): Promise<CloneInfo> {
    const local = async (args: string[]): Promise<GitOutput> =>
        exec.run(["-C", dir, ...args]);
    const list = await local(["remote"]);
    if (list.code !== 0) throw new GitError(["remote"], list);
    const names = list.stdout.split("\n").filter((n) => n !== "");
    const name = names.includes("origin") ? "origin" : names[0];
    let url = "";
    if (name !== undefined) {
        const out = await local(["remote", "get-url", name]);
        if (out.code === 0) url = out.stdout.trim();
    }
    const head = await local(["symbolic-ref", "--short", "-q", "HEAD"]);
    return { url, branch: head.code === 0 ? head.stdout.trim() : "" };
}

/** remote runs a git command without prompts and returns its stdout. */
async function remote(exec: GitExec, args: string[]): Promise<string> {
    const out = await exec.run(args, { env: { ...BATCH_ENV } });
    if (out.code !== 0) throw new RemoteError(args, out);
    return out.stdout;
}

/** checkUrl returns `url` trimmed, or throws when git would read it as an option. */
function checkUrl(url: string): string {
    const u = url.trim();
    if (u === "" || u.startsWith("-")) {
        throw new Error(`"${url}" is not a clone URL`);
    }
    return u;
}
