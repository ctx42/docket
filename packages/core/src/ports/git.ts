// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The system `git` binary as a port. The core builds every git command line
// (see `git/repo.ts`); a host adapter only spawns the binary in the repository
// directory and hands back what it printed. Local operations only — nothing in
// the core ever asks for push, pull, fetch, or remote.

/** GitOutput is one finished git invocation. */
export interface GitOutput {
    /** The exit code; 0 is success. */
    code: number;
    stdout: string;
    stderr: string;
}

/** GitRunOptions are the per-invocation extras a command may need. */
export interface GitRunOptions {
    /** Text written to git's stdin, which is then closed. */
    input?: string;
    /** Variables added to the inherited environment (e.g. `GIT_INDEX_FILE`). */
    env?: Record<string, string>;
}

/** GitExec runs the system git binary in the repository directory. */
export interface GitExec {
    /**
     * run executes `git <args>` and resolves with its exit code and output,
     * whatever the code. It rejects with `GitNotFoundError` when the binary
     * cannot be started.
     */
    run(args: string[], options?: GitRunOptions): Promise<GitOutput>;
}
