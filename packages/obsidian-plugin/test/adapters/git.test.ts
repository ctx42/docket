// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The git adapter and the core GitRepo against the real git binary, in a
// throwaway repository: the commit flow's guarantees only hold for real git.

import { execFileSync } from "node:child_process";
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    addIgnoreEntry,
    DEFAULT_IGNORES,
    defaultIgnoreBlock,
    type GitChange,
    GitNotFoundError,
    GitRepo,
    ignoreEntries,
} from "@docket/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/fs-node.ts";
import { NodeGitExec } from "../../src/adapters/git.ts";

const hasGit = (() => {
    try {
        execFileSync("git", ["--version"]);
        return true;
    } catch {
        return false;
    }
})();

describe.skipIf(!hasGit)("GitRepo over NodeGitExec", () => {
    let root = "";
    let repo: GitRepo;
    const git = (...args: string[]): string =>
        execFileSync("git", args, { cwd: root, encoding: "utf8" });
    const put = async (path: string, text: string): Promise<void> => {
        await mkdir(join(root, path, ".."), { recursive: true });
        await writeFile(join(root, path), text);
    };
    const commitAll = (msg: string): void => {
        git("add", "-A");
        git("commit", "-qm", msg);
    };
    const find = (cs: GitChange[], path: string): GitChange => {
        const c = cs.find((x) => x.path === path);
        if (c === undefined) throw new Error(`no change for ${path}`);
        return c;
    };
    const subjects = (): string[] =>
        git("log", "--format=%s")
            .split("\n")
            .filter((s) => s !== "");

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "docket-git-"));
        repo = new GitRepo(
            new NodeGitExec(() => "", root),
            new NodeFileSystem(),
        );
    });
    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    /** ready initializes the repository with one commit holding `files`. */
    async function ready(files: Record<string, string>): Promise<void> {
        await repo.init();
        git("config", "user.email", "t@example.com");
        git("config", "user.name", "t");
        git("config", "commit.gpgsign", "false");
        for (const [p, t] of Object.entries(files)) await put(p, t);
        commitAll("init");
    }

    it("reports no-repo, then initializes with the default block and no commit", async () => {
        expect(await repo.state()).toEqual({ kind: "no-repo" });

        await repo.init();
        await put(".gitignore", defaultIgnoreBlock(""));

        expect(await repo.state()).toEqual({ kind: "ready" });
        const text = await readFile(join(root, ".gitignore"), "utf8");
        expect(ignoreEntries(text)).toEqual([...DEFAULT_IGNORES]);
        expect(await repo.log({ skip: 0, limit: 10 })).toEqual([]);
    });

    it("refuses a vault below the repository root", async () => {
        await repo.init();
        await mkdir(join(root, "vault"));
        const inner = new GitRepo(
            new NodeGitExec(() => "", join(root, "vault")),
        );

        expect(await inner.state()).toEqual({ kind: "nested" });
    });

    it("reports a missing binary", async () => {
        const bad = new GitRepo(new NodeGitExec(() => "/no/such/git", root));

        expect(await bad.state()).toEqual({
            kind: "no-git",
            path: "/no/such/git",
        });
    });

    it("lists edits, hides ignored files, and shows staged ones as staged", async () => {
        await ready({
            "a.md": "a\n",
            "b.md": "b\n",
            ".gitignore": "secret.md\n",
        });
        await put("a.md", "a2\n");
        await put("b.md", "b2\n");
        await put("secret.md", "x\n");
        git("add", "b.md");

        const have = await repo.status();

        expect(have.map((c) => c.path).sort()).toEqual(["a.md", "b.md"]);
        expect(find(have, "a.md").staged).toBe(false);
        expect(find(have, "b.md").staged).toBe(true);
    });

    it("commits whole files, leaving unselected and other staged files alone", async () => {
        await ready({
            "ENG/a.md": "1\n2\n",
            "ENG/b.md": "b\n",
            "OPS/c.md": "c\n",
        });
        await put("ENG/a.md", "1x\n2x\n");
        git("add", "ENG/a.md");
        await put("ENG/a.md", "1x\n2y\n"); // one hunk staged, the other not
        await put("ENG/b.md", "b2\n"); // left unchecked
        await put("OPS/c.md", "c2\n");
        git("add", "OPS/c.md"); // staged elsewhere, not in the group
        const cs = await repo.status();

        await repo.commit([find(cs, "ENG/a.md")], "docs: a");

        expect(git("show", "HEAD:ENG/a.md")).toBe("1x\n2y\n");
        expect(git("show", "--name-only", "--format=", "HEAD").trim()).toBe(
            "ENG/a.md",
        );
        const after = await repo.status();
        expect(after.map((c) => c.path).sort()).toEqual([
            "ENG/b.md",
            "OPS/c.md",
        ]);
        expect(find(after, "OPS/c.md").staged).toBe(true);
    });

    it("commits a moved page so --follow finds its history", async () => {
        await ready({ "A/p.md": "page\n" });
        await mkdir(join(root, "B"));
        await rename(join(root, "A/p.md"), join(root, "B/p.md"));
        const cs = await repo.status();
        await repo.commit(cs, "docs: move");

        expect(await repo.status()).toEqual([]);
        const log = await repo.log({ path: "B/p.md", skip: 0, limit: 10 });
        expect(log.map((e) => e.subject)).toEqual(["docs: move", "init"]);
        expect(log.map((e) => e.path)).toEqual(["B/p.md", "A/p.md"]);
    });

    it("reads a file at a commit under the path it had there", async () => {
        await ready({ "A/p.md": "1\n2\n3\n" });
        await mkdir(join(root, "B"));
        await rename(join(root, "A/p.md"), join(root, "B/p.md"));
        await put("B/p.md", "1\n2\n3\n4\n");
        commitAll("docs: move");
        const [, init] = await repo.log({ path: "B/p.md", skip: 0, limit: 10 });

        expect(init?.path).toBe("A/p.md");
        expect(await repo.textAt(init?.hash ?? "", "A/p.md")).toBe("1\n2\n3\n");
        expect(await repo.textAt(init?.hash ?? "", "B/p.md")).toBe("");
        await expect(repo.textAt("0".repeat(40), "A/p.md")).rejects.toThrow();
    });

    it("commits a new untracked page", async () => {
        await ready({ "a.md": "a\n" });
        await put("n.md", "n\n");

        await repo.commit(await repo.status(), "docs: add");

        expect(git("show", "HEAD:n.md")).toBe("n\n");
        expect(await repo.status()).toEqual([]);
    });

    it("ignores a tracked folder and commits the removals", async () => {
        await ready({ "ENG/a.md": "a\n", "ENG/b.md": "b\n", "x.md": "x\n" });

        expect((await repo.trackedUnder("ENG")).sort()).toEqual([
            "ENG/a.md",
            "ENG/b.md",
        ]);
        await put(".gitignore", addIgnoreEntry("", "/ENG/"));
        await repo.untrack("ENG");
        const cs = (await repo.status()).filter((c) => c.path !== ".gitignore");
        expect(cs.every((c) => c.kind === "D" && c.staged)).toBe(true);

        await repo.commit(cs, "docs: untrack");

        expect(git("ls-files")).toBe("x.md\n");
        expect(await readFile(join(root, "ENG/a.md"), "utf8")).toBe("a\n");
    });

    it.skipIf(process.platform === "win32")(
        "makes no commit and throws git's error when a hook rejects",
        async () => {
            await ready({ "A/a.md": "a\n", "c.md": "c\n" });
            const hook = join(root, ".git/hooks/pre-commit");
            await writeFile(hook, '#!/bin/sh\necho "no" >&2\nexit 1\n');
            await chmod(hook, 0o755);
            for (const p of ["A/a.md", "c.md"]) await put(p, "2\n");
            const cs = await repo.status();

            const have = repo.commit(cs, "docs: x");

            await expect(have).rejects.toThrow("no");
            expect(subjects()).toEqual(["init"]);
            const left = (await repo.status()).map((c) => c.path).sort();
            expect(left).toEqual(["A/a.md", "c.md"]);
        },
    );

    it("pages the vault history", async () => {
        await ready({ "a.md": "0\n" });
        for (let i = 1; i <= 3; i++) {
            await put("a.md", `${i}\n`);
            await put(`f${i}.md`, "x\n");
            commitAll(`c${i}`);
        }

        const first = await repo.log({ skip: 0, limit: 2 });
        const next = await repo.log({ skip: 2, limit: 2 });

        expect(first.map((e) => e.subject)).toEqual(["c3", "c2"]);
        expect(next.map((e) => e.subject)).toEqual(["c1", "init"]);
    });

    it("compares against HEAD, all-new when untracked, nothing when ignored", async () => {
        await ready({ "a.md": "a\n", ".gitignore": "ig.md\n" });
        await put("n.md", "n\n");
        await put("ig.md", "i\n");

        expect(await repo.baseText("a.md")).toBe("a\n");
        expect(await repo.baseText("n.md")).toBe("");
        expect(await repo.baseText("ig.md")).toBeUndefined();
    });
});

describe("NodeGitExec", () => {
    it("falls back to Git for Windows, keeping the first error", async () => {
        const exec = new NodeGitExec(() => "", "/no/such/dir", "win32");

        const have = exec.run(["--version"]);

        await expect(have).rejects.toBeInstanceOf(GitNotFoundError);
        await expect(have).rejects.toThrow("Git not found at git");
    });

    it("does not fall back off Windows", async () => {
        const exec = new NodeGitExec(() => "", "/no/such/dir", "linux");

        await expect(exec.run(["--version"])).rejects.toBeInstanceOf(
            GitNotFoundError,
        );
    });
});
