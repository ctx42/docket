// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { GitRepo, type KnowledgeBase } from "@docket/core";
import { describe, expect, it } from "vitest";
import { StubGitExec } from "../../../core/test/support/git-stub.ts";
import { GitController } from "../../src/git/controller.ts";
import type { RoleRecord } from "../../src/git/kb-role.ts";
import { KbWatch, type KbWatchDeps } from "../../src/git/kb-watch.ts";
import { GitRepos } from "../../src/git/repos.ts";

const HEAD = "a".repeat(40);
const UP = "b".repeat(40);
const URL = "git@github.com:acme/kb.git";

/** ready answers the commands a ready, clean clone in `kb` gets. */
function ready(git: StubGitExec): StubGitExec {
    return git
        .on("rev-parse --show-prefix", { stdout: "\n" })
        .on("symbolic-ref", { stdout: "main\n" })
        .on("rev-list --left-right", { stdout: "0\t0\n" })
        .on("-C kb rev-parse --verify -q HEAD", { stdout: `${HEAD}\n` })
        .on("-C kb rev-parse --verify -q refs/remotes/origin/main", {
            stdout: `${UP}\n`,
        });
}

/** setup builds a watch over one git knowledge base `kb` and its stubs. */
function setup(
    git: StubGitExec,
    kb: Partial<KnowledgeBase> = {},
    folder = true,
) {
    const files = {
        isFolder: () => Promise.resolve(true),
        read: () => Promise.resolve(null),
        write: () => Promise.resolve(),
        mkdir: () => Promise.resolve(),
    };
    const ctl = (root: string): GitController =>
        new GitController({
            root: () => root,
            open: (r) => new GitRepo(git, undefined, r),
            files,
            notify: () => {},
            record: () => {},
        });
    const repos = new GitRepos(ctl(""), ctl("conflu"), files, ctl);
    repos.setKnowledgeBases(["kb"]);
    const kbs: KnowledgeBase[] = [
        { kind: "git", name: "kb", url: URL, branch: "", ...kb },
    ];
    let roles: Record<string, RoleRecord> = {};
    const opened: string[] = [];
    const clock = { at: 1000 };
    const deps: KbWatchDeps = {
        exec: git,
        repos,
        knowledgeBases: () => kbs,
        setPin: async (name, pin) => {
            const k = kbs.find((x) => x.name === name);
            if (k !== undefined) k.pin = pin;
        },
        folderExists: () => Promise.resolve(folder),
        loadRoles: () => roles,
        saveRoles: (r) => {
            roles = r;
        },
        openUrl: (u) => opened.push(u),
        now: () => clock.at,
        today: () => new Date(2026, 10, 16, 9, 5),
    };
    return {
        watch: new KbWatch(deps),
        kbs,
        opened,
        clock,
        roles: () => roles,
    };
}

describe("KbWatch.check", () => {
    it("records write access as own and reads the counts", async () => {
        const git = ready(new StubGitExec());
        const { watch, roles } = setup(git);

        await watch.check("kb");
        const s = watch.status("kb");

        expect(git.cmds()).toContain("-C kb fetch --quiet origin");
        expect(git.cmds()).toContain(
            "-C kb push --dry-run --porcelain origin HEAD:refs/heads/main",
        );
        expect(s?.role?.role).toBe("own");
        expect(s?.check).toEqual({ kind: "ok" });
        expect(roles()["kb"]?.role).toBe("own");
    });

    it("pins a base first seen read to HEAD and previews the update", async () => {
        const git = ready(new StubGitExec())
            .on("-C kb push --dry-run", {
                code: 128,
                stderr: "ERROR: Permission to acme/kb.git denied to anna.",
            })
            .on("-C kb merge-base --is-ancestor", { code: 0 })
            .on("-C kb rev-list --count", { stdout: "2\n" })
            .on("-C kb diff --name-status", { stdout: "M\0a.md\0" });
        const { watch, kbs } = setup(git);

        await watch.check("kb");
        const s = watch.status("kb");

        expect(kbs[0]?.pin).toBe(HEAD);
        expect(watch.upstream("kb")).toBe(UP);
        expect(s?.role?.role).toBe("read");
        expect(s?.update).toEqual({
            commits: 2,
            changed: ["a.md"],
            added: [],
            removed: [],
        });
    });

    it("keeps the last role when the fetch cannot reach the host", async () => {
        const git = ready(new StubGitExec()).on("-C kb fetch", {
            code: 128,
            stderr: "ssh: Could not resolve hostname github.com: no address",
        });
        const { watch } = setup(git);
        await watch.check("kb");
        git.on("-C kb fetch", {});

        expect(watch.status("kb")?.check.kind).toBe("offline");
        expect(git.cmds().some((c) => c.includes("--dry-run"))).toBe(false);
    });

    it("checks each base again only once its last check is a minute old", async () => {
        const git = ready(new StubGitExec());
        const { watch, clock } = setup(git);
        const fetches = (): number =>
            git.cmds().filter((c) => c.endsWith("fetch --quiet origin")).length;

        await watch.checkAll();
        await watch.checkAll();
        clock.at = 1000 + 60_000;
        await watch.checkAll();
        await watch.check("kb");

        expect(fetches()).toBe(3);
    });

    it("says a missing folder and runs no git for it", async () => {
        const git = new StubGitExec();
        const { watch } = setup(git, {}, false);

        await watch.check("kb");

        expect(watch.status("kb")?.folder).toBe(false);
        expect(git.cmds().filter((c) => c.startsWith("-C kb"))).toEqual([]);
    });
});

describe("KbWatch actions", () => {
    it("learns a protected branch from a refused push", async () => {
        const git = ready(new StubGitExec()).on("push", {
            code: 1,
            stderr: "remote: error: GH006: Protected branch update failed for refs/heads/main.",
        });
        const { watch, roles } = setup(git);
        await watch.check("kb");
        git.on("-C kb push --dry-run", {});

        await expect(watch.push("kb")).rejects.toThrow("GH006");
        expect(roles()["kb"]).toEqual({
            role: "own",
            protected: true,
            checkedAt: 1000,
        });
    });

    it("proposes on a new branch and opens the pull-request page", async () => {
        const git = ready(new StubGitExec()).on("-C kb config user.name", {
            stdout: "Anna Nowak\n",
        });
        const { watch, opened } = setup(git);
        await watch.check("kb");

        await watch.propose("kb");

        expect(git.cmds()).toContain(
            "-C kb push --porcelain origin HEAD:refs/heads/docket/anna-nowak-2026-11-16-0905",
        );
        expect(opened).toEqual([
            "https://github.com/acme/kb/compare/main...docket/anna-nowak-2026-11-16-0905?expand=1",
        ]);
    });

    it("accepts an update by fast-forwarding and moving the pin", async () => {
        const git = ready(new StubGitExec());
        const { watch, kbs } = setup(git, { pin: HEAD });
        await watch.check("kb");

        await watch.acceptUpdate("kb");

        expect(git.cmds()).toContain(`-C kb merge --ff-only --quiet ${UP}`);
        expect(kbs[0]?.pin).toBe(UP);
    });

    it("marks a conflicting file resolved in the base's clone", async () => {
        const git = ready(new StubGitExec());
        const { watch } = setup(git);

        await watch.markResolved("kb", "kb/a.md");

        expect(git.cmds()).toContain("add -- a.md");
    });

    it("shows clone progress and forgets it when the clone ends", async () => {
        const git = new StubGitExec().on("clone", {
            stderr: "Receiving objects:  50% (1/2)\r",
        });
        const { watch } = setup(git);
        const seen: string[] = [];
        watch.subscribe(() => {
            const c = watch.status("kb")?.clone;
            if (c?.kind === "running") seen.push(c.text);
        });

        await watch.clone("kb");

        expect(seen).toContain("Receiving objects 50%");
        expect(watch.status("kb")?.clone).toEqual({ kind: "idle" });
        expect(git.calls.find((c) => c.cmd.startsWith("clone"))?.cmd).toBe(
            `clone --progress -- ${URL} kb`,
        );
    });

    it("keeps why a clone failed, and nothing after a cancel", async () => {
        const failing = new StubGitExec().on("clone", {
            code: 128,
            stderr: "ERROR: Repository not found.",
        });
        const { watch } = setup(failing);

        await watch.clone("kb");

        expect(watch.status("kb")?.clone.kind).toBe("failed");
        const slow = new StubGitExec();
        const other = setup(slow).watch;
        const run = other.clone("kb");
        other.cancel("kb");
        await run;
        expect(other.status("kb")?.clone).toEqual({ kind: "idle" });
    });
});
