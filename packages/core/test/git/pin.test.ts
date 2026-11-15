// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
    fastForwardTo,
    fetchRemote,
    headCommit,
    isAncestor,
    remoteCommit,
    updatePreview,
} from "../../src/git/pin.ts";
import { BATCH_ENV, RemoteError } from "../../src/git/remote.ts";
import { StubGitExec } from "../support/git-stub.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("fetchRemote", () => {
    it("fetches origin without prompts", async () => {
        const git = new StubGitExec();

        await fetchRemote(git, "kb");

        expect(git.calls[0]?.cmd).toBe("-C kb fetch --quiet origin");
        expect(git.calls[0]?.options?.env).toEqual(BATCH_ENV);
    });

    it("throws a RemoteError naming the problem", async () => {
        const git = new StubGitExec().on("-C kb fetch", {
            code: 128,
            stderr: "ssh: Could not resolve hostname h: Name or service not known",
        });

        const have = await fetchRemote(git, "kb").catch((e) => e);

        expect(have).toBeInstanceOf(RemoteError);
        expect((have as RemoteError).problem).toBe("network");
    });
});

describe("headCommit and remoteCommit", () => {
    it("read the commit HEAD and the remote branch point at", async () => {
        const git = new StubGitExec()
            .on("-C kb rev-parse --verify -q HEAD", { stdout: `${A}\n` })
            .on("-C kb rev-parse --verify -q refs/remotes/origin/main", {
                stdout: `${B}\n`,
            });

        expect(await headCommit(git, "kb")).toBe(A);
        expect(await remoteCommit(git, "kb", "main")).toBe(B);
    });

    it("are empty when the ref does not exist", async () => {
        const git = new StubGitExec().on("-C kb rev-parse", { code: 1 });

        expect(await headCommit(git, "kb")).toBe("");
        expect(await remoteCommit(git, "kb", "main")).toBe("");
    });
});

describe("updatePreview", () => {
    it("counts commits and sorts the changed paths", async () => {
        const git = new StubGitExec()
            .on("-C kb rev-list --count", { stdout: "4\n" })
            .on("-C kb diff", {
                stdout: "M\0alarms.md\0A\0hydrants.md\0D\0old.md\0M\0data.md\0T\0x.md\0",
            });

        const have = await updatePreview(git, "kb", A, B);

        expect(git.cmds()).toEqual([
            `-C kb rev-list --count ${A}..${B}`,
            `-C kb diff --name-status -z --no-renames ${A} ${B} --`,
        ]);
        expect(have).toEqual({
            commits: 4,
            changed: ["alarms.md", "data.md", "x.md"],
            added: ["hydrants.md"],
            removed: ["old.md"],
        });
    });

    it("is empty when both commits are the same", async () => {
        const git = new StubGitExec();

        const have = await updatePreview(git, "kb", A, A);

        expect(have).toEqual({
            commits: 0,
            changed: [],
            added: [],
            removed: [],
        });
        expect(git.calls).toEqual([]);
    });
});

describe("fastForwardTo and isAncestor", () => {
    it("fast-forward only, keeping uncommitted edits", async () => {
        const git = new StubGitExec();

        await fastForwardTo(git, "kb", B);

        expect(git.calls[0]?.cmd).toBe(`-C kb merge --ff-only --quiet ${B}`);
    });

    it("throw git's message when the merge cannot fast-forward", async () => {
        const git = new StubGitExec().on("-C kb merge", {
            code: 128,
            stderr: "fatal: Not possible to fast-forward, aborting.",
        });

        await expect(fastForwardTo(git, "kb", B)).rejects.toThrow(
            "Not possible to fast-forward",
        );
    });

    it("tell whether one commit is an ancestor of another", async () => {
        const git = new StubGitExec()
            .on(`-C kb merge-base --is-ancestor ${A} ${B}`, { code: 0 })
            .on(`-C kb merge-base --is-ancestor ${B} ${A}`, { code: 1 });

        expect(await isAncestor(git, "kb", A, B)).toBe(true);
        expect(await isAncestor(git, "kb", B, A)).toBe(false);
    });

    it("refuse a commit that is not a full hash", async () => {
        await expect(
            fastForwardTo(new StubGitExec(), "kb", "--x"),
        ).rejects.toThrow("not a commit");
    });
});
