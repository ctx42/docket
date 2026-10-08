// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The core GitExec port over `node:child_process`: spawns the system git binary
// in the vault root. The binary path is read on every call, so a changed setting
// takes effect without a reload. On Windows the default `git` falls back to the
// Git for Windows install location when it is not on PATH.

import { execFile } from "node:child_process";
import process from "node:process";
import {
    type GitExec,
    GitNotFoundError,
    type GitOutput,
    type GitRunOptions,
} from "@docket/core";

/** DEFAULT_GIT is the git path setting's default: whatever PATH finds. */
export const DEFAULT_GIT = "git";

/** WINDOWS_GIT is where Git for Windows installs its command wrapper. */
export const WINDOWS_GIT = "C:\\Program Files\\Git\\cmd\\git.exe";

/** MAX_BUFFER bounds one command's output (a large note's HEAD version). */
const MAX_BUFFER = 256 * 1024 * 1024;

/** NodeGitExec implements the core {@link GitExec} with `execFile`. */
export class NodeGitExec implements GitExec {
    /**
     * `binary` returns the configured git path (`""` means {@link DEFAULT_GIT});
     * `cwd` is the vault root every command runs in.
     */
    constructor(
        private readonly binary: () => string,
        private readonly cwd: string,
        private readonly platform: string = process.platform,
    ) {}

    async run(args: string[], options?: GitRunOptions): Promise<GitOutput> {
        const path = this.binary().trim() || DEFAULT_GIT;
        try {
            return await this.spawn(path, args, options);
        } catch (err) {
            if (!(err instanceof GitNotFoundError)) throw err;
            if (this.platform !== "win32" || path !== DEFAULT_GIT) throw err;
            try {
                return await this.spawn(WINDOWS_GIT, args, options);
            } catch {
                throw err;
            }
        }
    }

    /** spawn runs one git binary, mapping a missing binary to GitNotFoundError. */
    private spawn(
        path: string,
        args: string[],
        options: GitRunOptions | undefined,
    ): Promise<GitOutput> {
        return new Promise((resolve, reject) => {
            const child = execFile(
                path,
                args,
                {
                    cwd: this.cwd,
                    env: { ...process.env, ...options?.env },
                    maxBuffer: MAX_BUFFER,
                    windowsHide: true,
                    encoding: "utf8",
                },
                (err, stdout, stderr) => {
                    if (err === null) {
                        resolve({ code: 0, stdout, stderr });
                        return;
                    }
                    const code = (err as { code?: unknown }).code;
                    if (code === "ENOENT" || code === "EACCES") {
                        reject(new GitNotFoundError(path));
                        return;
                    }
                    if (typeof code === "number") {
                        resolve({ code, stdout, stderr });
                        return;
                    }
                    reject(err);
                },
            );
            child.stdin?.on("error", () => undefined); // git may exit before reading
            child.stdin?.end(options?.input ?? "");
        });
    }
}
