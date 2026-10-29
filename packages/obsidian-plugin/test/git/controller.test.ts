// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { GitRepo } from "@docket/core";
import { describe, expect, it } from "vitest";
import { StubGitExec } from "../../../core/test/support/git-stub.ts";
import {
    type ControllerDeps,
    GitController,
} from "../../src/git/controller.ts";

/** MemFiles is an in-memory vault: files by path, plus a set of folders. */
class MemFiles {
    readonly files = new Map<string, string>();
    readonly folders = new Set<string>();

    isFolder(path: string): Promise<boolean> {
        return Promise.resolve(this.folders.has(path));
    }

    read(path: string): Promise<string | null> {
        return Promise.resolve(this.files.get(path) ?? null);
    }

    write(path: string, text: string): Promise<void> {
        this.files.set(path, text);
        return Promise.resolve();
    }
}

/** controller builds a controller rooted at `root` over `git` and `files`. */
function controller(
    root: string | null,
    git: StubGitExec,
    files = new MemFiles(),
    extra: Partial<ControllerDeps> = {},
): GitController {
    return new GitController({
        root: () => root,
        open: (r) => new GitRepo(git, undefined, r),
        files,
        notify: () => {},
        record: () => {},
        ...extra,
    });
}

describe("GitController.refresh", () => {
    it("reports no-folder for a missing folder and runs no git", async () => {
        const git = new StubGitExec();
        const c = controller("confluence", git);

        await c.refresh();

        expect(c.state).toEqual({ kind: "no-folder" });
        expect(git.cmds()).toEqual([]);
    });

    it("reports no-folder without a folder set", async () => {
        const git = new StubGitExec();
        const c = controller(null, git);

        await c.refresh();

        expect(c.state).toEqual({ kind: "no-folder" });
        expect(git.cmds()).toEqual([]);
    });

    it("reads the state of an existing folder", async () => {
        const git = new StubGitExec().on("rev-parse --show-prefix", {
            stdout: "\n",
        });
        const files = new MemFiles();
        files.folders.add("confluence");
        const c = controller("confluence", git, files);

        await c.refresh();

        expect(c.state).toEqual({ kind: "ready" });
        expect(git.cmds()[0]).toBe("rev-parse --show-prefix");
    });

    it("never checks the vault root's folder", async () => {
        const git = new StubGitExec().on("rev-parse --show-prefix", {
            stdout: "\n",
        });
        const c = controller("", git);

        await c.refresh();

        expect(c.state).toEqual({ kind: "ready" });
    });

    it("is unavailable without a disk vault", async () => {
        const c = new GitController({
            root: () => "",
            files: new MemFiles(),
            notify: () => {},
            record: () => {},
        });

        await c.refresh();

        expect(c.state).toEqual({ kind: "unavailable" });
    });
});

describe("GitController remote operations", () => {
    const ready = (): StubGitExec =>
        new StubGitExec()
            .on("rev-parse --show-prefix", { stdout: "\n" })
            .on("rev-parse -q --verify REBASE_HEAD", { code: 1 })
            .on("rev-list", { stdout: "1\t2\n" });

    it("reads the ahead and behind counts on refresh", async () => {
        const c = controller("", ready());

        await c.refresh();

        expect(c.counts).toEqual({ ahead: 1, behind: 2 });
    });

    it("records a pull's conflict and clears it after a clean pull", async () => {
        const git = ready()
            .on("pull", { code: 1, stderr: "error: could not apply x\n" })
            .on("rev-parse -q --verify REBASE_HEAD", { stdout: "x\n" })
            .on("diff --name-only -z --diff-filter=U", { stdout: "a.md\0" });
        const c = controller("", git);

        await c.pull();

        expect(c.remote).toEqual({
            kind: "conflict",
            message: "could not apply x",
            files: ["a.md"],
        });

        git.on("pull", { code: 0 }).on("rev-parse -q --verify REBASE_HEAD", {
            code: 1,
        });
        git.on("diff --name-only -z --diff-filter=U", { stdout: "" });
        await c.pull();

        expect(c.remote).toBeNull();
    });

    it("records a failed push with git's message", async () => {
        const git = ready().on("push", {
            code: 1,
            stderr: "error: failed to push some refs\n",
        });
        const c = controller("", git);

        await c.push();

        expect(c.remote).toEqual({
            kind: "failed",
            message: "failed to push some refs",
        });
    });

    it("never commits", async () => {
        const git = ready();
        const c = controller("", git);

        await c.pull();
        await c.push();

        expect(git.cmds().some((cmd) => cmd.startsWith("commit"))).toBe(false);
    });
});
