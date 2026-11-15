// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Proposing changes to a knowledge base whose branch this person may not push
// to: the commits go to a new branch, and the host's page for opening a pull
// request from it is the link to finish on the web. No host API, no token.

import type { GitExec } from "../ports/git.ts";
import { BATCH_ENV, RemoteError } from "./remote.ts";

/** UNSPLIT maps the letters Unicode does not split into a base and a mark. */
const UNSPLIT: Record<string, string> = { ł: "l", đ: "d", ø: "o", ß: "ss" };

/**
 * proposeBranchName names a proposal branch after the person and the local
 * time `at`: `docket/<name>-YYYY-MM-DD-HHMM`, the name as lowercase ASCII.
 */
export function proposeBranchName(user: string, at: Date): string {
    const slug =
        user
            .normalize("NFD")
            .replace(/\p{M}/gu, "")
            .toLowerCase()
            .replace(/[łđøß]/g, (c) => UNSPLIT[c] ?? c)
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "change";
    const two = (n: number): string => String(n).padStart(2, "0");
    const date = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
    return `docket/${slug}-${date}-${two(at.getHours())}${two(at.getMinutes())}`;
}

/**
 * pullRequestUrl is the page where GitHub, Bitbucket, or GitLab opens a pull
 * request from `branch` into `base` of the repository at clone URL `url`;
 * null for another host or a local path.
 */
export function pullRequestUrl(
    url: string,
    base: string,
    branch: string,
): string | null {
    const at = hostAndPath(url.trim());
    if (at === null) return null;
    const { host, path } = at;
    const repo = `https://${host}/${path}`;
    const q = (pairs: [string, string][]): string =>
        pairs
            .map(
                ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
            )
            .join("&");
    if (host === "github.com") {
        return `${repo}/compare/${base}...${branch}?expand=1`;
    }
    if (host === "bitbucket.org") {
        return `${repo}/pull-requests/new?${q([
            ["source", branch],
            ["dest", base],
        ])}`;
    }
    if (host === "gitlab.com") {
        return `${repo}/-/merge_requests/new?${q([
            ["merge_request[source_branch]", branch],
            ["merge_request[target_branch]", base],
        ])}`;
    }
    return null;
}

/** cloneHost is the host of an SSH or HTTPS clone URL, `""` for a path. */
export function cloneHost(url: string): string {
    return hostAndPath(url.trim())?.host ?? "";
}

/**
 * hostAndPath reads the host and the repository path, without `.git`, from
 * an SSH (`git@host:path`, `ssh://host/path`) or HTTPS clone URL.
 */
function hostAndPath(url: string): { host: string; path: string } | null {
    const scheme =
        /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i;
    const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/;
    const m = scheme.exec(url) ?? scp.exec(url);
    if (m === null) return null;
    const path = (m[2] as string).replace(/\/+$/, "").replace(/\.git$/, "");
    return path === "" ? null : { host: (m[1] as string).toLowerCase(), path };
}

/**
 * pushBranch pushes HEAD of the clone in `dir` to a new `branch` on
 * `origin`; it throws a {@link RemoteError} when the push fails.
 */
export async function pushBranch(
    exec: GitExec,
    dir: string,
    branch: string,
): Promise<void> {
    const args = [
        "-C",
        dir,
        "push",
        "--porcelain",
        "origin",
        `HEAD:refs/heads/${branch}`,
    ];
    const out = await exec.run(args, { env: { ...BATCH_ENV } });
    if (out.code !== 0) throw new RemoteError(args, out);
}

/** gitUserName is git's `user.name` in the clone in `dir`, `""` when unset. */
export async function gitUserName(exec: GitExec, dir: string): Promise<string> {
    const out = await exec.run(["-C", dir, "config", "user.name"]);
    return out.code === 0 ? out.stdout.trim() : "";
}
