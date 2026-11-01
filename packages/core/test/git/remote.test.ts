// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
    BATCH_ENV,
    cloneInfo,
    cloneRepo,
    lsRemote,
    pullFastForward,
    RemoteError,
    remoteProblem,
} from "../../src/git/remote.ts";
import { GitError, GitNotFoundError } from "../../src/git/repo.ts";
import { StubGitExec } from "../support/git-stub.ts";

const URL = "git@bitbucket.org:anna/kb.git";

describe("remoteProblem", () => {
    it.each([
        ["git@bitbucket.org: Permission denied (publickey).", "auth"],
        ["fatal: Authentication failed for 'https://h/x'", "auth"],
        ["fatal: could not read Username for 'https://h'", "auth"],
        ["Host key verification failed.", "host-key"],
        ["ERROR: Repository not found.", "not-found"],
        ["fatal: 'x' does not appear to be a git repository", "not-found"],
        [
            "ssh: Could not resolve hostname h: Name or service not known",
            "network",
        ],
        ["ssh: connect to host h port 22: Connection timed out", "network"],
        ["fatal: Not possible to fast-forward, aborting.", "other"],
    ])("%s → %s", (stderr, want) => {
        expect(remoteProblem(stderr)).toBe(want);
    });
});

describe("lsRemote", () => {
    it("lists the branches and the default one", async () => {
        const git = new StubGitExec().on(`ls-remote --symref ${URL}`, {
            stdout:
                "ref: refs/heads/main\tHEAD\n" +
                "abc\tHEAD\n" +
                "abc\trefs/heads/main\n" +
                "def\trefs/heads/draft\n" +
                "123\trefs/tags/v1\n",
        });

        const have = await lsRemote(git, URL);

        expect(have).toEqual({ head: "main", branches: ["draft", "main"] });
    });

    it("runs without prompts", async () => {
        const git = new StubGitExec();

        await lsRemote(git, URL);

        expect(git.calls[0]?.options?.env).toEqual(BATCH_ENV);
    });

    it("throws a RemoteError naming the problem", async () => {
        const git = new StubGitExec().on("ls-remote", {
            code: 128,
            stderr: "git@bitbucket.org: Permission denied (publickey).\nfatal: Could not read from remote repository.",
        });

        const have = await lsRemote(git, URL).catch((e: unknown) => e);

        expect(have).toBeInstanceOf(RemoteError);
        expect((have as RemoteError).problem).toBe("auth");
    });

    it("refuses a URL that looks like an option", async () => {
        const git = new StubGitExec();

        await expect(lsRemote(git, "--upload-pack=x")).rejects.toThrow(
            "not a clone URL",
        );
        expect(git.calls).toHaveLength(0);
    });

    it("passes a missing git binary through", async () => {
        const git = new StubGitExec().on(
            "ls-remote",
            new GitNotFoundError("git"),
        );

        await expect(lsRemote(git, URL)).rejects.toBeInstanceOf(
            GitNotFoundError,
        );
    });
});

describe("cloneRepo", () => {
    it("clones the branch into the folder", async () => {
        const git = new StubGitExec();

        await cloneRepo(git, URL, "kb-anna", "draft");

        expect(git.calls.map((c) => c.cmd)).toEqual([
            `clone --branch draft -- ${URL} kb-anna`,
        ]);
        expect(git.calls[0]?.options?.env).toEqual(BATCH_ENV);
    });

    it("clones the default branch for ''", async () => {
        const git = new StubGitExec();

        await cloneRepo(git, URL, "kb-anna", "");

        expect(git.calls[0]?.cmd).toBe(`clone -- ${URL} kb-anna`);
    });

    it("throws a RemoteError when the clone fails", async () => {
        const git = new StubGitExec().on("clone", {
            code: 128,
            stderr: "ERROR: Repository not found.",
        });

        const have = await cloneRepo(git, URL, "kb", "").catch((e) => e);

        expect((have as RemoteError).problem).toBe("not-found");
        expect((have as RemoteError).message).toBe(
            "ERROR: Repository not found.",
        );
    });

    it("refuses a URL that looks like an option", async () => {
        const git = new StubGitExec();

        await expect(cloneRepo(git, "-x", "kb", "")).rejects.toThrow(
            "not a clone URL",
        );
    });
});

describe("pullFastForward", () => {
    it("pulls in the folder, fast-forward only", async () => {
        const git = new StubGitExec();

        await pullFastForward(git, "kb-anna");

        expect(git.calls.map((c) => c.cmd)).toEqual([
            "-C kb-anna pull --ff-only",
        ]);
        expect(git.calls[0]?.options?.env).toEqual(BATCH_ENV);
    });

    it("throws a RemoteError when the pull fails", async () => {
        const git = new StubGitExec().on("-C kb pull", {
            code: 128,
            stderr: "fatal: Not possible to fast-forward, aborting.",
        });

        const have = await pullFastForward(git, "kb").catch((e) => e);

        expect((have as RemoteError).problem).toBe("other");
    });
});

describe("cloneInfo", () => {
    it("reads origin's URL and the checked-out branch", async () => {
        const git = new StubGitExec()
            .on("-C kb remote get-url origin", { stdout: `${URL}\n` })
            .on("-C kb remote", { stdout: "backup\norigin\n" })
            .on("-C kb symbolic-ref --short -q HEAD", { stdout: "main\n" });

        const have = await cloneInfo(git, "kb");

        expect(have).toEqual({ url: URL, branch: "main" });
    });

    it("falls back to the first remote without origin", async () => {
        const git = new StubGitExec()
            .on("-C kb remote get-url backup", { stdout: "git@h:me/kb.git\n" })
            .on("-C kb remote", { stdout: "backup\n" });

        const have = await cloneInfo(git, "kb");

        expect(have.url).toBe("git@h:me/kb.git");
    });

    it("has an empty URL without remotes, an empty branch when detached", async () => {
        const git = new StubGitExec().on("-C kb symbolic-ref", { code: 1 });

        const have = await cloneInfo(git, "kb");

        expect(have).toEqual({ url: "", branch: "" });
    });

    it("throws a GitError for a folder that is no repository", async () => {
        const git = new StubGitExec().on("-C kb remote", {
            code: 128,
            stderr: "fatal: not a git repository",
        });

        await expect(cloneInfo(git, "kb")).rejects.toBeInstanceOf(GitError);
    });
});
