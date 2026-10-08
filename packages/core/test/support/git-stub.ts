// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// A programmable stub GitExec for core git tests: canned outputs registered by
// command prefix, and every invocation recorded for asserting what was run.

import type { GitExec, GitOutput, GitRunOptions } from "../../src/ports/git.ts";

/** GitCall is one recorded invocation, with GitRepo's fixed options stripped. */
export interface GitCall {
    /** The arguments joined by spaces, e.g. `status --porcelain=v2 -z`. */
    cmd: string;
    args: string[];
    options: GitRunOptions | undefined;
}

/** FIXED are the options GitRepo puts before every command. */
const FIXED = ["-c", "core.quotepath=off", "--literal-pathspecs"];

/** A {@link GitExec} that replays outputs registered by command prefix. */
export class StubGitExec implements GitExec {
    private readonly routes: [string, Partial<GitOutput> | Error][] = [];
    /** Every invocation received, in order. */
    readonly calls: GitCall[] = [];

    /**
     * on registers the output (or thrown error) for commands starting with
     * `prefix`; the longest matching prefix wins. Unmatched commands succeed
     * with no output. Returns `this` for chaining.
     */
    on(prefix: string, out: Partial<GitOutput> | Error): this {
        this.routes.push([prefix, out]);
        return this;
    }

    run(args: string[], options?: GitRunOptions): Promise<GitOutput> {
        const rest = FIXED.every((a, i) => args[i] === a)
            ? args.slice(FIXED.length)
            : args;
        const cmd = rest.join(" ");
        this.calls.push({ cmd, args: rest, options });
        let best: [string, Partial<GitOutput> | Error] | undefined;
        for (const r of this.routes) {
            if (cmd.startsWith(r[0]) && r[0].length >= (best?.[0].length ?? -1))
                best = r;
        }
        const out = best?.[1] ?? {};
        if (out instanceof Error) return Promise.reject(out);
        return Promise.resolve({
            code: out.code ?? 0,
            stdout: out.stdout ?? "",
            stderr: out.stderr ?? "",
        });
    }

    /** cmds returns the recorded commands, in order. */
    cmds(): string[] {
        return this.calls.map((c) => c.cmd);
    }
}
