// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// What a knowledge base's remote lets this person do. A dry-run push asks the
// server for write access without sending anything; it cannot see branch
// rules, which only a real push meets, so a refused push is sorted by
// pushProblem, and "protected" is learned from that.

import type { GitExec } from "../ports/git.ts";
import { BATCH_ENV, remoteProblem } from "./remote.ts";

/**
 * AccessKind is what a dry-run push showed: the server takes pushes
 * (`write`), refuses them (`read`), cannot be reached (`offline`), or
 * failed some other way (`unknown`).
 */
export type AccessKind = "write" | "read" | "offline" | "unknown";

/** Access is a probe's result; `message` is git's error, `""` on write. */
export interface Access {
    kind: AccessKind;
    message: string;
}

/** DENIED matches a server's refusal to take a push from this account. */
const DENIED = [
    /Permission to \S+ denied/i,
    /returned error: 403/i,
    /not allowed to push/i,
    /You do not have (write )?(access|permission)/i,
    /^Unauthorized$/im,
    // Bitbucket Cloud, for an account or an access key that may only read.
    /repository access denied/i,
];

/** REJECTED matches a push refused only because the branch moved on. */
const REJECTED = /\[rejected\]|non-fast-forward|fetch first/i;

/**
 * probeAccess asks the remote `origin` of the clone in `dir` whether it
 * takes a push of HEAD to `branch`, by a dry run that sends nothing. A push
 * refused only for being behind still means write access.
 */
export async function probeAccess(
    exec: GitExec,
    dir: string,
    branch: string,
): Promise<Access> {
    if (branch === "" || branch.startsWith("-")) {
        throw new Error(`"${branch}" is not a branch`);
    }
    const out = await exec.run(
        [
            "-C",
            dir,
            "push",
            "--dry-run",
            "--porcelain",
            "origin",
            `HEAD:refs/heads/${branch}`,
        ],
        { env: { ...BATCH_ENV } },
    );
    if (out.code === 0 || REJECTED.test(out.stdout)) {
        return { kind: "write", message: "" };
    }
    const message = out.stderr.trim();
    if (DENIED.some((re) => re.test(message))) {
        return { kind: "read", message };
    }
    if (remoteProblem(message) === "network") {
        return { kind: "offline", message };
    }
    return { kind: "unknown", message };
}

/**
 * PushProblem is why a real push failed: a branch rule refused it
 * (`protected`), the account may not push (`denied`), the branch moved on
 * (`behind`), the host cannot be reached (`network`), or anything else.
 */
export type PushProblem =
    | "protected"
    | "denied"
    | "behind"
    | "network"
    | "other";

/** PROTECTED matches the texts hosts give for a branch-rule refusal. */
const PROTECTED = [
    /protected branch/i,
    /GH006/,
    /only be modified through pull requests/i,
    /pre-receive hook declined/i,
    /branch permission/i,
];

/** pushProblem reads why a push failed from git's stderr. */
export function pushProblem(stderr: string): PushProblem {
    if (PROTECTED.some((re) => re.test(stderr))) return "protected";
    if (REJECTED.test(stderr)) return "behind";
    if (DENIED.some((re) => re.test(stderr))) return "denied";
    if (remoteProblem(stderr) === "network") return "network";
    return "other";
}
