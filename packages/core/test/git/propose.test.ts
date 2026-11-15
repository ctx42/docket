// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
    cloneHost,
    gitUserName,
    proposeBranchName,
    pullRequestUrl,
    pushBranch,
} from "../../src/git/propose.ts";
import { BATCH_ENV, RemoteError } from "../../src/git/remote.ts";
import { StubGitExec } from "../support/git-stub.ts";

describe("proposeBranchName", () => {
    it("names the branch after the person and the local time", () => {
        const at = new Date(2026, 10, 16, 9, 5);

        expect(proposeBranchName("Rafał Zając", at)).toBe(
            "docket/rafal-zajac-2026-11-16-0905",
        );
    });

    it("falls back to 'change' without a usable name", () => {
        const at = new Date(2026, 0, 2, 13, 45);

        expect(proposeBranchName("  !! ", at)).toBe(
            "docket/change-2026-01-02-1345",
        );
    });
});

describe("pullRequestUrl", () => {
    const b = "docket/anna-2026-11-16-0905";

    it.each([
        [
            "git@github.com:acme/kb.git",
            "https://github.com/acme/kb/compare/main...docket/anna-2026-11-16-0905?expand=1",
        ],
        [
            "https://github.com/acme/kb",
            "https://github.com/acme/kb/compare/main...docket/anna-2026-11-16-0905?expand=1",
        ],
        [
            "git@bitbucket.org:acme/kb.git",
            "https://bitbucket.org/acme/kb/pull-requests/new?source=docket%2Fanna-2026-11-16-0905&dest=main",
        ],
        [
            "ssh://git@gitlab.com/acme/docs/kb.git",
            "https://gitlab.com/acme/docs/kb/-/merge_requests/new?merge_request%5Bsource_branch%5D=docket%2Fanna-2026-11-16-0905&merge_request%5Btarget_branch%5D=main",
        ],
    ])("%s", (url, want) => {
        expect(pullRequestUrl(url, "main", b)).toBe(want);
    });

    it("is null for a host it does not know", () => {
        expect(pullRequestUrl("git@git.acme.internal:kb.git", "main", b)).toBe(
            null,
        );
        expect(pullRequestUrl("/srv/kb.git", "main", b)).toBe(null);
    });
});

describe("pushBranch and gitUserName", () => {
    it("pushes HEAD to a new branch without prompts", async () => {
        const git = new StubGitExec();

        await pushBranch(git, "kb", "docket/anna-1");

        expect(git.calls[0]?.cmd).toBe(
            "-C kb push --porcelain origin HEAD:refs/heads/docket/anna-1",
        );
        expect(git.calls[0]?.options?.env).toEqual(BATCH_ENV);
    });

    it("throws a RemoteError when the push fails", async () => {
        const git = new StubGitExec().on("-C kb push", {
            code: 128,
            stderr: "ERROR: Permission to acme/kb.git denied to anna.",
        });

        await expect(pushBranch(git, "kb", "docket/anna-1")).rejects.toThrow(
            RemoteError,
        );
    });

    it("reads git's user name, '' when none is set", async () => {
        const named = new StubGitExec().on("-C kb config user.name", {
            stdout: "Anna Nowak\n",
        });
        const unnamed = new StubGitExec().on("-C kb config", { code: 1 });

        expect(await gitUserName(named, "kb")).toBe("Anna Nowak");
        expect(await gitUserName(unnamed, "kb")).toBe("");
    });
});

describe("cloneHost", () => {
    it.each([
        ["git@bitbucket.org:me/kb.git", "bitbucket.org"],
        ["ssh://git@Host.Example:7999/p/kb.git", "host.example"],
        ["https://github.com/acme/kb", "github.com"],
        ["/srv/kb.git", ""],
    ])("%s → %j", (url, want) => {
        expect(cloneHost(url)).toBe(want);
    });
});
