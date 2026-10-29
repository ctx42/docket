// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { GitRepo } from "@docket/core";
import { describe, expect, it } from "vitest";
import { StubGitExec } from "../../../core/test/support/git-stub.ts";
import { GitController } from "../../src/git/controller.ts";
import { historySource } from "../../src/git/history-source.ts";
import { GitRepos } from "../../src/git/repos.ts";

/** repos builds both controllers; the sync one reports a pending move. */
async function repos(): Promise<GitRepos> {
    const h = "a".repeat(40);
    const files = {
        isFolder: () => Promise.resolve(true),
        read: () => Promise.resolve(null),
        write: () => Promise.resolve(),
        mkdir: () => Promise.resolve(),
    };
    const ctl = (root: string, status: string): GitController => {
        const git = new StubGitExec()
            .on("rev-parse --show-prefix", { stdout: "\n" })
            .on("--no-optional-locks status", { stdout: status })
            .on("hash-object", { stdout: `${h}\n` });
        return new GitController({
            root: () => root,
            open: (r) => new GitRepo(git, undefined, r),
            files,
            notify: () => {},
            record: () => {},
        });
    };
    const r = new GitRepos(
        ctl("", ""),
        ctl(
            "confluence",
            `1 .D N... 100644 100644 000000 ${h} ${h} old/p.md\0? new/p.md\0`,
        ),
        files,
    );
    await r.refresh();
    return r;
}

describe("historySource", () => {
    it("lists a whole repository in Vault and Confluence mode", async () => {
        const r = await repos();

        expect(historySource(r, "vault", "kb/a.md")).toEqual({
            git: r.vault,
            path: null,
        });
        expect(historySource(r, "sync", "kb/a.md")).toEqual({
            git: r.sync,
            path: null,
        });
    });

    it("reads a note's history from the repository owning it", async () => {
        const r = await repos();

        expect(historySource(r, "note", "kb/a.md")).toEqual({
            git: r.vault,
            path: "kb/a.md",
        });
        expect(historySource(r, "note", "confluence/doc/a.md")).toEqual({
            git: r.sync,
            path: "confluence/doc/a.md",
        });
    });

    it("follows a move not yet committed in the owning repository", async () => {
        const r = await repos();

        expect(historySource(r, "note", "confluence/new/p.md")).toEqual({
            git: r.sync,
            path: "confluence/old/p.md",
        });
    });

    it("has nothing in Note mode without an open note", async () => {
        expect(historySource(await repos(), "note", null)).toBeNull();
    });
});
