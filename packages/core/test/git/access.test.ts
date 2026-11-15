// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { probeAccess, pushProblem } from "../../src/git/access.ts";
import { BATCH_ENV } from "../../src/git/remote.ts";
import { StubGitExec } from "../support/git-stub.ts";

describe("probeAccess", () => {
    it("dry-runs a push of HEAD to the branch, without prompts", async () => {
        const git = new StubGitExec();

        const have = await probeAccess(git, "kb", "main");

        expect(have).toEqual({ kind: "write", message: "" });
        expect(git.calls[0]?.cmd).toBe(
            "-C kb push --dry-run --porcelain origin HEAD:refs/heads/main",
        );
        expect(git.calls[0]?.options?.env).toEqual(BATCH_ENV);
    });

    it("reads a refused fast-forward as write access", async () => {
        const git = new StubGitExec().on("-C kb push", {
            code: 1,
            stdout: "To h:x.git\n!\tHEAD:refs/heads/main\t[rejected] (fetch first)\nDone\n",
            stderr: "error: failed to push some refs to 'h:x.git'\n",
        });

        expect((await probeAccess(git, "kb", "main")).kind).toBe("write");
    });

    it.each([
        "ERROR: Permission to anna/kb.git denied to marek.\nfatal: Could not read from remote repository.",
        "remote: Permission to anna/kb.git denied to marek.\nfatal: unable to access 'https://github.com/anna/kb.git/': The requested URL returned error: 403",
        "remote: You are not allowed to push code to this project.",
        "Unauthorized\nfatal: Could not read from remote repository.",
    ])("reads a refusal to write as read access: %j", async (stderr) => {
        const git = new StubGitExec().on("-C kb push", { code: 128, stderr });

        expect((await probeAccess(git, "kb", "main")).kind).toBe("read");
    });

    it("reads an unreachable host as offline", async () => {
        const git = new StubGitExec().on("-C kb push", {
            code: 128,
            stderr: "ssh: Could not resolve hostname bitbucket.org: Name or service not known",
        });

        expect(await probeAccess(git, "kb", "main")).toEqual({
            kind: "offline",
            message:
                "ssh: Could not resolve hostname bitbucket.org: Name or service not known",
        });
    });

    it("reports anything else as unknown, with git's message", async () => {
        const git = new StubGitExec().on("-C kb push", {
            code: 128,
            stderr: "git@h: Permission denied (publickey).",
        });

        expect(await probeAccess(git, "kb", "main")).toEqual({
            kind: "unknown",
            message: "git@h: Permission denied (publickey).",
        });
    });

    it("refuses a branch that looks like an option", async () => {
        await expect(
            probeAccess(new StubGitExec(), "kb", "-x"),
        ).rejects.toThrow("not a branch");
    });
});

describe("pushProblem", () => {
    it.each([
        [
            "remote: error: GH006: Protected branch update failed for refs/heads/main.",
            "protected",
        ],
        [
            "remote: Branch refs/heads/main can only be modified through pull requests.",
            "protected",
        ],
        [
            "remote: GitLab: You are not allowed to push code to protected branches on this project.",
            "protected",
        ],
        [
            "! [remote rejected] main -> main (pre-receive hook declined)",
            "protected",
        ],
        [" ! [rejected]        main -> main (fetch first)", "behind"],
        [" ! [rejected]        main -> main (non-fast-forward)", "behind"],
        ["ERROR: Permission to anna/kb.git denied to marek.", "denied"],
        ["The requested URL returned error: 403", "denied"],
        ["ssh: connect to host h port 22: Connection timed out", "network"],
        ["fatal: something else", "other"],
    ])("%j → %s", (stderr, want) => {
        expect(pushProblem(stderr)).toBe(want);
    });
});
