// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { GitError, GitNotFoundError, GitRepo } from "../../src/git/repo.ts";
import { StubGitExec } from "../support/git-stub.ts";

describe("GitRepo.state", () => {
    it("is ready at the repository root", async () => {
        const git = new StubGitExec().on("rev-parse --show-prefix", {
            stdout: "\n",
        });

        expect(await new GitRepo(git).state()).toEqual({ kind: "ready" });
    });

    it("is nested below the repository root", async () => {
        const git = new StubGitExec().on("rev-parse --show-prefix", {
            stdout: "vault/\n",
        });

        expect(await new GitRepo(git).state()).toEqual({ kind: "nested" });
    });

    it("is no-repo outside any repository", async () => {
        const git = new StubGitExec().on("rev-parse", {
            code: 128,
            stderr: "fatal: not a git repository (or any of the parent directories): .git",
        });

        expect(await new GitRepo(git).state()).toEqual({ kind: "no-repo" });
    });

    it("is no-git when the binary is missing", async () => {
        const git = new StubGitExec().on(
            "rev-parse",
            new GitNotFoundError("/x/git"),
        );

        expect(await new GitRepo(git).state()).toEqual({
            kind: "no-git",
            path: "/x/git",
        });
    });
});

describe("GitRepo.status", () => {
    it("hashes untracked files only when a tracked one went missing", async () => {
        const h = "a".repeat(40);
        const git = new StubGitExec()
            .on("--no-optional-locks status", {
                stdout: `1 .D N... 100644 100644 000000 ${h} ${h} A/p.md\0? B/q.md\0`,
            })
            .on("hash-object", { stdout: `${h}\n` });

        const have = await new GitRepo(git).status();

        expect(have).toEqual([
            {
                path: "B/q.md",
                from: "A/p.md",
                kind: "R",
                staged: false,
                untracking: false,
            },
        ]);
        expect(git.calls[1]?.options?.input).toBe("B/q.md\n");
    });
});

describe("GitRepo.commit", () => {
    it("commits through a temporary index and resets the real one", async () => {
        const git = new StubGitExec().on("rev-parse --absolute-git-dir", {
            stdout: "/v/.git\n",
        });

        await new GitRepo(git).commit(
            [
                {
                    path: "B/p.md",
                    from: "A/p.md",
                    kind: "R",
                    staged: false,
                    untracking: false,
                },
                {
                    path: "ig.md",
                    from: "",
                    kind: "D",
                    staged: true,
                    untracking: true,
                },
            ],
            "docs: x",
        );

        expect(git.cmds()).toEqual([
            "rev-parse --absolute-git-dir",
            "rev-parse -q --verify HEAD",
            "read-tree HEAD",
            "add -A --pathspec-from-file=- --pathspec-file-nul",
            "rm -q --cached --ignore-unmatch --pathspec-from-file=- --pathspec-file-nul",
            "commit -q -F -",
            "reset -q --pathspec-from-file=- --pathspec-file-nul",
        ]);
        const env = { GIT_INDEX_FILE: "/v/.git/docket-index" };
        expect(git.calls[3]?.options).toEqual({ env, input: "A/p.md\0B/p.md" });
        expect(git.calls[4]?.options).toEqual({ env, input: "ig.md" });
        expect(git.calls[5]?.options).toEqual({ env, input: "docs: x" });
        expect(git.calls[6]?.options).toEqual({
            input: "A/p.md\0B/p.md\0ig.md",
        });
    });

    it("reports a rejected commit and leaves the real index alone", async () => {
        const git = new StubGitExec()
            .on("rev-parse --absolute-git-dir", { stdout: "/v/.git\n" })
            .on("commit", { code: 1, stderr: "hook said no\n" });

        const have = new GitRepo(git).commit(
            [
                {
                    path: "a.md",
                    from: "",
                    kind: "M",
                    staged: false,
                    untracking: false,
                },
            ],
            "m",
        );

        await expect(have).rejects.toThrow(
            new GitError(["commit"], {
                code: 1,
                stdout: "",
                stderr: "hook said no",
            }).message,
        );
        expect(git.cmds().some((c) => c.startsWith("reset"))).toBe(false);
    });

    it("starts from an empty tree before the first commit", async () => {
        const git = new StubGitExec().on("rev-parse -q --verify HEAD", {
            code: 1,
        });

        await new GitRepo(git).commit(
            [
                {
                    path: "a.md",
                    from: "",
                    kind: "A",
                    staged: false,
                    untracking: false,
                },
            ],
            "m",
        );

        expect(git.cmds()).toContain("read-tree --empty");
    });
});

describe("GitRepo.log", () => {
    it("follows one file's renames", async () => {
        const git = new StubGitExec().on("log", {
            stdout: "h2\x1f2\x1fmove\0\nB/p.md\0h1\x1f1\x1fadd\0\nA/p.md\0",
        });

        const have = await new GitRepo(git).log({
            path: "B/p.md",
            skip: 100,
            limit: 101,
        });

        expect(git.calls[0]?.args.slice(-6)).toEqual([
            "--max-count=101",
            "--skip=100",
            "--name-only",
            "--follow",
            "--",
            "B/p.md",
        ]);
        expect(have.map((e) => e.path)).toEqual(["B/p.md", "A/p.md"]);
    });

    it("lists the whole vault without paths", async () => {
        const git = new StubGitExec().on("log", {
            stdout: "h1\x1f1\x1fadd\0",
        });

        const have = await new GitRepo(git).log({ skip: 0, limit: 10 });

        expect(git.calls[0]?.args).not.toContain("--name-only");
        expect(have).toEqual([{ hash: "h1", at: 1000, subject: "add" }]);
    });

    it("is empty before the first commit", async () => {
        const git = new StubGitExec().on("log", {
            code: 128,
            stderr: "fatal: your current branch 'main' does not have any commits yet",
        });

        expect(await new GitRepo(git).log({ skip: 0, limit: 10 })).toEqual([]);
    });
});

describe("GitRepo.baseText", () => {
    it("is HEAD's text, empty for an untracked file, absent for an ignored one", async () => {
        const git = new StubGitExec()
            .on("show HEAD:a.md", { stdout: "hi\n" })
            .on("show HEAD:", { code: 128 })
            .on("check-ignore -q -- ig.md", { code: 0 })
            .on("check-ignore", { code: 1 });
        const repo = new GitRepo(git);

        expect(await repo.baseText("a.md")).toBe("hi\n");
        expect(await repo.baseText("new.md")).toBe("");
        expect(await repo.baseText("ig.md")).toBeUndefined();
    });
});

describe("GitRepo.textAt", () => {
    it("is the commit's text, empty for a path the commit lacks", async () => {
        const git = new StubGitExec()
            .on("show h1:a.md", { stdout: "old\n" })
            .on("show h1:", { code: 128 });
        const repo = new GitRepo(git);

        expect(await repo.textAt("h1", "a.md")).toBe("old\n");
        expect(await repo.textAt("h1", "gone.md")).toBe("");
        expect(git.cmds()).toContain("cat-file -e h1^{commit}");
    });

    it("throws for an unknown commit", async () => {
        const git = new StubGitExec()
            .on("show", {
                code: 128,
                stderr: "fatal: invalid object name 'x'.",
            })
            .on("cat-file", { code: 128 });

        const have = new GitRepo(git).textAt("x", "a.md");

        await expect(have).rejects.toThrow("invalid object name 'x'.");
    });
});

describe("GitRepo with a prefix", () => {
    /** sub is a repository rooted at the vault's `confluence/` folder. */
    const sub = (git: StubGitExec): GitRepo =>
        new GitRepo(git, undefined, "confluence");

    it("is no-repo when the enclosing repository is the vault's", async () => {
        const git = new StubGitExec().on("rev-parse --show-prefix", {
            stdout: "confluence/\n",
        });

        expect(await sub(git).state()).toEqual({ kind: "no-repo" });
    });

    it("is nested below a repository rooted above the vault", async () => {
        const git = new StubGitExec().on("rev-parse --show-prefix", {
            stdout: "vault/confluence/\n",
        });

        expect(await sub(git).state()).toEqual({ kind: "nested" });
    });

    it("returns status paths as vault paths", async () => {
        const h = "a".repeat(40);
        const git = new StubGitExec()
            .on("--no-optional-locks status", {
                stdout: `1 .D N... 100644 100644 000000 ${h} ${h} A/p.md\0? B/q.md\0? c.md\0`,
            })
            .on("hash-object", { stdout: `${h}\n\n` });

        const have = await sub(git).status();

        expect(have.map((c) => [c.path, c.from])).toEqual([
            ["confluence/B/q.md", "confluence/A/p.md"],
            ["confluence/c.md", ""],
        ]);
    });

    it("commits vault paths as repository paths", async () => {
        const git = new StubGitExec().on("rev-parse --absolute-git-dir", {
            stdout: "/v/confluence/.git\n",
        });

        await sub(git).commit(
            [
                {
                    path: "confluence/B/p.md",
                    from: "confluence/A/p.md",
                    kind: "R",
                    staged: false,
                    untracking: false,
                },
                {
                    path: "confluence/ig.md",
                    from: "",
                    kind: "D",
                    staged: true,
                    untracking: true,
                },
            ],
            "docs: x",
        );

        expect(git.calls[3]?.options?.input).toBe("A/p.md\0B/p.md");
        expect(git.calls[4]?.options?.input).toBe("ig.md");
        expect(git.calls[6]?.options?.input).toBe("A/p.md\0B/p.md\0ig.md");
    });

    it("lists and untracks tracked files by vault path", async () => {
        const git = new StubGitExec().on("ls-files", {
            stdout: "m/a.png\0m/b.png\0",
        });
        const repo = sub(git);

        const have = await repo.trackedUnder("confluence/m");
        await repo.untrack("confluence/m");

        expect(have).toEqual(["confluence/m/a.png", "confluence/m/b.png"]);
        expect(git.cmds()).toEqual([
            "ls-files -z -- m",
            "rm -r -q --cached -- m",
        ]);
    });

    it("takes the repository root as its own folder", async () => {
        const git = new StubGitExec();

        await sub(git).trackedUnder("confluence");

        expect(git.cmds()).toEqual(["ls-files -z -- ."]);
    });

    it("follows a vault path's history and returns vault paths", async () => {
        const git = new StubGitExec().on("log", {
            stdout: "h2\x1f2\x1fmove\0\nB/p.md\0h1\x1f1\x1fadd\0\nA/p.md\0",
        });

        const have = await sub(git).log({
            path: "confluence/B/p.md",
            skip: 0,
            limit: 10,
        });

        expect(git.calls[0]?.args.at(-1)).toBe("B/p.md");
        expect(have.map((e) => e.path)).toEqual([
            "confluence/B/p.md",
            "confluence/A/p.md",
        ]);
    });

    it("reads a vault path's texts at repository paths", async () => {
        const git = new StubGitExec()
            .on("show HEAD:a.md", { stdout: "hi\n" })
            .on("show h1:a.md", { stdout: "old\n" })
            .on("show HEAD:", { code: 128 })
            .on("check-ignore -q -- ig.md", { code: 0 })
            .on("check-ignore", { code: 1 });
        const repo = sub(git);

        expect(await repo.baseText("confluence/a.md")).toBe("hi\n");
        expect(await repo.baseText("confluence/ig.md")).toBeUndefined();
        expect(await repo.textAt("h1", "confluence/a.md")).toBe("old\n");
    });

    it("refuses a path outside its folder", async () => {
        const repo = sub(new StubGitExec());

        await expect(repo.baseText("kb/a.md")).rejects.toThrow(
            'path "kb/a.md" is outside the repository at confluence/',
        );
        await expect(repo.trackedUnder("confluence-x/a.md")).rejects.toThrow(
            "outside the repository",
        );
    });
});
