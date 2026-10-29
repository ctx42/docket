// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The vault's git repository, driven through the {@link GitExec} port. Local
// operations only: there is no push, pull, fetch, remote, branch, or credential
// handling here, and no sync code path calls into this module — pull and push
// leave their file changes for the user to commit.
//
// A commit takes whole working-tree files and leaves the rest of the index
// alone. `git commit --only` would do that for tracked paths, but it refuses an
// untracked one (a new page, a moved page's new path) and re-adds a file the
// index dropped with `git rm --cached`. So commit does what `--only` does
// internally, by hand: build a temporary index from HEAD, apply the group's
// paths to it, commit from it, then bring the real index's entries for those
// paths up to the new HEAD.
//
// A repository may be rooted in a vault folder rather than the vault root. Its
// `prefix` is that folder; GitRepo adds it to every path it returns and strips
// it from every path it takes, so callers work with vault paths only.

import type { FileSystem } from "../ports/fs.ts";
import type { GitExec, GitOutput, GitRunOptions } from "../ports/git.ts";
import { LOG_FORMAT, type LogEntry, parseLog } from "./log.ts";
import {
    type GitChange,
    moveCandidates,
    pairMoves,
    parseStatus,
} from "./status.ts";

/** GitNotFoundError is thrown when the git binary cannot be started. */
export class GitNotFoundError extends Error {
    constructor(readonly path: string) {
        super(`Git not found at ${path}`);
        this.name = "GitNotFoundError";
    }
}

/** GitError is a git command that exited non-zero; its message is git's. */
export class GitError extends Error {
    constructor(
        readonly args: string[],
        readonly output: GitOutput,
    ) {
        const text = (output.stderr.trim() || output.stdout.trim()).replace(
            /^(error|fatal): /,
            "",
        );
        super(text || `git ${args[0] ?? ""} failed (exit ${output.code})`);
        this.name = "GitError";
    }
}

/**
 * RepoState is whether the repository's folder can be used as a repository,
 * and why not.
 */
export type RepoState =
    | { kind: "ready" }
    /**
     * The folder is not inside any repository, or (for a vault folder) only
     * inside the vault's own.
     */
    | { kind: "no-repo" }
    /** The folder lies inside a repository rooted above the vault. */
    | { kind: "nested" }
    /** The git binary is not at the configured path. */
    | { kind: "no-git"; path: string }
    /** git ran but failed for another reason (e.g. an unsafe directory). */
    | { kind: "error"; message: string };

/** LogQuery selects a page of history: newest first, optionally one file's. */
export interface LogQuery {
    /** A vault path whose history (across renames) to list; all commits when absent. */
    path?: string;
    skip: number;
    limit: number;
}

/** TEMP_INDEX is the temporary index file commit builds, in the git directory. */
const TEMP_INDEX = "docket-index";

/** GitRepo runs the repository operations docket needs. */
export class GitRepo {
    /** The repository root's vault path with a trailing `/`; `""` at the root. */
    private readonly prefix: string;

    /**
     * `fs` removes commit's temporary index afterwards; without it the file is
     * left in the git directory and overwritten by the next commit. `prefix` is
     * the vault folder the repository is rooted in, `""` for the vault root;
     * `exec` must run git there.
     */
    constructor(
        private readonly exec: GitExec,
        private readonly fs?: FileSystem,
        prefix = "",
    ) {
        const p = prefix.replace(/^\/+|\/+$/g, "");
        this.prefix = p === "" ? "" : `${p}/`;
    }

    /** vault turns a repository path into a vault path. */
    private vault(path: string): string {
        return this.prefix + path;
    }

    /**
     * local turns a vault path into a repository path: `.` for the root
     * folder. It throws for a path outside the repository's folder.
     */
    private local(path: string): string {
        if (this.prefix === "") return path;
        if (`${path}/` === this.prefix) return ".";
        if (!path.startsWith(this.prefix)) {
            throw new Error(
                `path "${path}" is outside the repository at ${this.prefix}`,
            );
        }
        return path.slice(this.prefix.length);
    }

    /** run runs git with output-stable options; paths are never wildcards. */
    private run(args: string[], options?: GitRunOptions): Promise<GitOutput> {
        return this.exec.run(
            ["-c", "core.quotepath=off", "--literal-pathspecs", ...args],
            options,
        );
    }

    /** ok is {@link run} that throws {@link GitError} on a non-zero exit. */
    private async ok(args: string[], options?: GitRunOptions): Promise<string> {
        const out = await this.run(args, options);
        if (out.code !== 0) throw new GitError(args, out);
        return out.stdout;
    }

    /** state reports whether the folder is a usable repository root. */
    async state(): Promise<RepoState> {
        let out: GitOutput;
        try {
            out = await this.run(["rev-parse", "--show-prefix"]);
        } catch (err) {
            if (err instanceof GitNotFoundError) {
                return { kind: "no-git", path: err.path };
            }
            throw err;
        }
        if (out.code !== 0) {
            if (/not a git repository/i.test(out.stderr)) {
                return { kind: "no-repo" };
            }
            return {
                kind: "error",
                message: new GitError(["rev-parse"], out).message,
            };
        }
        const at = out.stdout.trim();
        if (at === "") return { kind: "ready" };
        // A vault folder inside the vault's repository has none of its own.
        return at === this.prefix ? { kind: "no-repo" } : { kind: "nested" };
    }

    /** init creates a repository in the folder, without a first commit. */
    async init(): Promise<void> {
        await this.ok(["init", "-q"]);
    }

    /** status lists the working tree's changes against HEAD, moves paired up. */
    async status(): Promise<GitChange[]> {
        const out = await this.ok([
            "--no-optional-locks",
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--find-renames",
        ]);
        const entries = parseStatus(out);
        const cands = moveCandidates(entries);
        const ids = new Map<string, string>();
        if (cands.length > 0) {
            const hashes = await this.ok(["hash-object", "--stdin-paths"], {
                input: `${cands.join("\n")}\n`,
            });
            hashes.split("\n").forEach((h, i) => {
                const p = cands[i];
                if (p !== undefined && h !== "") ids.set(p, h.trim());
            });
        }
        return pairMoves(entries, ids).map((c) => ({
            ...c,
            path: this.vault(c.path),
            from: c.from === "" ? "" : this.vault(c.from),
        }));
    }

    /** trackedUnder lists the tracked files at or under `path`. */
    async trackedUnder(path: string): Promise<string[]> {
        const local = this.local(path);
        const out = await this.ok(["ls-files", "-z", "--", local]);
        return out
            .split("\0")
            .filter((p) => p !== "")
            .map((p) => this.vault(p));
    }

    /** untrack drops `path` (recursively) from the index, keeping the files. */
    async untrack(path: string): Promise<void> {
        await this.ok(["rm", "-r", "-q", "--cached", "--", this.local(path)]);
    }

    /**
     * commit records the working-tree state of `changes` — both paths of a
     * rename, and the removal of an untracked one — as one commit with
     * `message`, leaving every other index entry as it was. Hooks run; a
     * rejected commit throws {@link GitError} with git's output and leaves the
     * index untouched.
     */
    async commit(changes: GitChange[], message: string): Promise<void> {
        const gitDir = (await this.ok(["rev-parse", "--absolute-git-dir"]))
            .trim()
            .replace(/\\/g, "/");
        const env = { GIT_INDEX_FILE: `${gitDir}/${TEMP_INDEX}` };
        const head =
            (await this.run(["rev-parse", "-q", "--verify", "HEAD"])).code ===
            0;
        const adds = changes
            .filter((c) => !c.untracking)
            .flatMap((c) => (c.from === "" ? [c.path] : [c.from, c.path]))
            .map((p) => this.local(p));
        const removes = changes
            .filter((c) => c.untracking)
            .map((c) => this.local(c.path));
        const fromFile = ["--pathspec-from-file=-", "--pathspec-file-nul"];
        try {
            await this.ok(
                head ? ["read-tree", "HEAD"] : ["read-tree", "--empty"],
                {
                    env,
                },
            );
            if (adds.length > 0) {
                await this.ok(["add", "-A", ...fromFile], {
                    env,
                    input: adds.join("\0"),
                });
            }
            if (removes.length > 0) {
                await this.ok(
                    ["rm", "-q", "--cached", "--ignore-unmatch", ...fromFile],
                    { env, input: removes.join("\0") },
                );
            }
            await this.ok(["commit", "-q", "-F", "-"], { env, input: message });
        } finally {
            await this.fs?.remove(env.GIT_INDEX_FILE).catch(() => undefined);
        }
        await this.ok(["reset", "-q", ...fromFile], {
            input: [...adds, ...removes].join("\0"),
        });
    }

    /**
     * log lists commits newest first; a path's history follows its renames and
     * gives each commit the path the file had there.
     */
    async log(q: LogQuery): Promise<LogEntry[]> {
        const args = [
            "log",
            "-z",
            `--format=${LOG_FORMAT}`,
            `--max-count=${q.limit}`,
            `--skip=${q.skip}`,
        ];
        if (q.path !== undefined) {
            args.push("--name-only", "--follow", "--", this.local(q.path));
        }
        const out = await this.run(args);
        if (out.code !== 0) {
            // A repository without commits has no history yet.
            if (
                /does not have any commits|unknown revision/i.test(out.stderr)
            ) {
                return [];
            }
            throw new GitError(args, out);
        }
        return parseLog(out.stdout).map((e) =>
            e.path === undefined ? e : { ...e, path: this.vault(e.path) },
        );
    }

    /**
     * baseText is the text a file's edits compare against: its HEAD version;
     * `""` for a file HEAD lacks (all of it is new); undefined for an ignored
     * file, which has no history to compare with.
     */
    async baseText(vaultPath: string): Promise<string | undefined> {
        const path = this.local(vaultPath);
        const out = await this.run(["show", `HEAD:${path}`]);
        if (out.code === 0) return out.stdout;
        // check-ignore takes paths, not pathspecs, and refuses literal magic.
        const ignored = await this.exec.run(["check-ignore", "-q", "--", path]);
        return ignored.code === 0 ? undefined : "";
    }

    /**
     * textAt is a file's text at `commit`, with the path it had there; `""` for
     * a path that commit lacks (all of it is new against it).
     */
    async textAt(commit: string, vaultPath: string): Promise<string> {
        const path = this.local(vaultPath);
        const args = ["show", `${commit}:${path}`];
        const out = await this.run(args);
        if (out.code === 0) return out.stdout;
        // Asked of the commit, not read from git's message: that is localized.
        const known = await this.run(["cat-file", "-e", `${commit}^{commit}`]);
        if (known.code === 0) return "";
        throw new GitError(args, out);
    }
}
