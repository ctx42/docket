// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Knowledge bases: top-level vault folders next to the Confluence sync folder
// that the doc server serves — git repositories docket clones there, or local
// folders with no upstream. This module
// holds the entry as settings store it, reading the owner and repository name
// from a clone URL, proposing a folder name, checking an entry, and cleaning
// the list read from a file. Pure, so it unit-tests.

import { syncFolderProblem } from "./sync-root.ts";

/**
 * KnowledgeBaseKind is where a knowledge base comes from: a git repository
 * docket clones (`git`), or a vault folder with no upstream (`folder`).
 */
export type KnowledgeBaseKind = "git" | "folder";

/** KnowledgeBase is one knowledge base folder in the vault. */
export interface KnowledgeBase {
    kind: KnowledgeBaseKind;
    /** The top-level vault folder. */
    name: string;
    /** A git entry's clone URL, usually SSH (`git@host:owner/repo.git`); `""` for a folder. */
    url: string;
    /** A git entry's branch, `""` for the remote's default; `""` for a folder. */
    branch: string;
}

/** RepoOfUrl is the owner and repository name a clone URL names. */
export interface RepoOfUrl {
    /** The path segment before the repository; `""` when there is none. */
    owner: string;
    repo: string;
}

/** URL_SCHEME matches a URL with a scheme, e.g. `ssh://` or `https://`. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** SCP_LIKE matches git's `[user@]host:path` form. */
const SCP_LIKE = /^(?:[^/@]+@)?[^/:]+:(.*)$/;

/**
 * repoOfUrl reads the owner and repository name from a clone URL — SSH
 * (`git@host:owner/repo.git`, `ssh://host/owner/repo.git`), HTTPS, or a local
 * path — dropping a trailing `/` and `.git`. It is null when the URL names no
 * repository.
 */
export function repoOfUrl(url: string): RepoOfUrl | null {
    const s = url.trim();
    if (s === "") return null;
    let path = s;
    if (URL_SCHEME.test(s)) {
        const rest = s.replace(URL_SCHEME, "").replace(/[?#].*$/, "");
        const slash = rest.indexOf("/");
        path = slash < 0 ? "" : rest.slice(slash);
    } else {
        const scp = SCP_LIKE.exec(s);
        if (scp !== null) path = scp[1] ?? "";
    }
    const segs = path.split("/").filter((seg) => seg !== "");
    const last = (segs[segs.length - 1] ?? "").replace(/\.git$/, "");
    if (last === "") return null;
    return { owner: segs[segs.length - 2] ?? "", repo: last };
}

/** UNSAFE matches characters a vault folder name cannot carry. */
const UNSAFE = /[\\/:*?"<>|#^[\]\s]/g;

/** cleanName makes `s` usable as a top-level vault folder name. */
function cleanName(s: string): string {
    return s.replace(UNSAFE, "-").replace(/^[.-]+/, "");
}

/**
 * proposeName proposes the vault folder for a knowledge base cloned from
 * `url`: the repository name, else `<repo>-<owner>`, else that with `-2`,
 * `-3`, … — the first one not in `taken`. It is `""` when the URL names no
 * repository.
 */
export function proposeName(url: string, taken: ReadonlySet<string>): string {
    const r = repoOfUrl(url);
    if (r === null) return "";
    const base = cleanName(r.repo);
    if (base === "") return "";
    if (!taken.has(base)) return base;
    const owner = cleanName(r.owner);
    const named = owner === "" ? base : `${base}-${owner}`;
    if (!taken.has(named)) return named;
    for (let n = 2; ; n++) {
        const next = `${named}-${n}`;
        if (!taken.has(next)) return next;
    }
}

/**
 * knowledgeBaseProblem returns why `kb` cannot be saved next to the entries in
 * `all` (which may hold `kb` itself), or `""` when it can: a git entry's
 * missing URL, a folder name that is not a usable top-level folder, the
 * Confluence sync folder `syncFolder`, or a name another entry already uses.
 */
export function knowledgeBaseProblem(
    kb: KnowledgeBase,
    all: readonly KnowledgeBase[],
    syncFolder: string,
): string {
    if (kb.kind === "git" && kb.url.trim() === "") return "Enter the SSH URL.";
    const problem = syncFolderProblem(kb.name);
    if (problem !== "") return problem;
    if (kb.name === syncFolder) {
        return `${kb.name} is the Confluence sync folder.`;
    }
    if (all.some((o) => o !== kb && o.name === kb.name)) {
        return `${kb.name} is already a knowledge base.`;
    }
    return "";
}

/**
 * readKnowledgeBases cleans a list read from `data.json` or `.docket.yaml`.
 * An entry without `kind` is a git entry. It keeps git entries with a string
 * name and URL (a missing or non-string branch becomes `""`), and folder
 * entries with a string name (their URL and branch become `""`); it drops
 * everything else, an unknown kind included.
 */
export function readKnowledgeBases(v: unknown): KnowledgeBase[] {
    if (!Array.isArray(v)) return [];
    const out: KnowledgeBase[] = [];
    for (const e of v) {
        if (typeof e !== "object" || e === null) continue;
        const {
            kind = "git",
            name,
            url,
            branch,
        } = e as Record<string, unknown>;
        if (typeof name !== "string") continue;
        if (kind === "folder") {
            out.push({ kind, name, url: "", branch: "" });
        } else if (kind === "git" && typeof url === "string") {
            const b = typeof branch === "string" ? branch : "";
            out.push({ kind, name, url, branch: b });
        }
    }
    return out;
}
