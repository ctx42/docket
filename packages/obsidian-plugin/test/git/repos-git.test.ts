// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The two repositories against the real git binary, in a throwaway vault:
// setup, Initialize, and commits must land in the right repository.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GitRepo, ignoreEntries, SYNC_IGNORES } from "@docket/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/fs-node.ts";
import { NodeGitExec } from "../../src/adapters/git.ts";
import { GitController } from "../../src/git/controller.ts";
import { GitRepos, type RepoFiles } from "../../src/git/repos.ts";

const hasGit = (() => {
    try {
        execFileSync("git", ["--version"]);
        return true;
    } catch {
        return false;
    }
})();

/** diskFiles is {@link RepoFiles} over a vault folder on disk. */
function diskFiles(vault: string): RepoFiles {
    return {
        isFolder: async (p) =>
            (await stat(join(vault, p)).catch(() => null))?.isDirectory() ??
            false,
        read: async (p) =>
            existsSync(join(vault, p))
                ? readFile(join(vault, p), "utf8")
                : null,
        write: async (p, text) => {
            await mkdir(dirname(join(vault, p)), { recursive: true });
            await writeFile(join(vault, p), text);
        },
        mkdir: async (p) => {
            await mkdir(join(vault, p), { recursive: true });
        },
    };
}

describe.skipIf(!hasGit)("GitRepos over real git", () => {
    let vault = "";
    let syncRoot = "";
    let gitPath = "";
    let notices: string[] = [];
    let recorded: string[] = [];

    /** repos builds both controllers over the vault on disk. */
    const repos = (): GitRepos => {
        const files = diskFiles(vault);
        const open = (root: string): GitRepo =>
            new GitRepo(
                new NodeGitExec(() => gitPath, join(vault, root)),
                new NodeFileSystem(),
                root,
            );
        const ctl = (root: () => string | null, id: string): GitController =>
            new GitController({
                root,
                open,
                files,
                notify: (t) => notices.push(t),
                record: (m) => recorded.push(`${id}:${m}`),
                ...(id === "sync" ? { ignores: SYNC_IGNORES } : {}),
            });
        return new GitRepos(
            ctl(() => "", "vault"),
            ctl(() => (syncRoot === "" ? null : syncRoot), "sync"),
            files,
        );
    };
    const git = (cwd: string, ...args: string[]): string =>
        execFileSync("git", args, { cwd, encoding: "utf8" });
    const configure = (cwd: string): void => {
        git(cwd, "config", "user.email", "t@example.com");
        git(cwd, "config", "user.name", "t");
        git(cwd, "config", "commit.gpgsign", "false");
    };
    const subjects = (cwd: string): string[] => {
        try {
            return git(cwd, "log", "--format=%s")
                .split("\n")
                .filter((s) => s !== "");
        } catch {
            return [];
        }
    };

    beforeEach(async () => {
        vault = await mkdtemp(join(tmpdir(), "docket-vault-"));
        syncRoot = "confluence";
        gitPath = "";
        notices = [];
        recorded = [];
    });
    afterEach(async () => {
        await rm(vault, { recursive: true, force: true });
    });

    describe("setupSync", () => {
        it("creates the folder, both repositories, and the vault ignore entry", async () => {
            await repos().setupSync();

            expect(existsSync(join(vault, ".git"))).toBe(true);
            expect(existsSync(join(vault, "confluence/.git"))).toBe(true);
            const vaultIgnore = await readFile(
                join(vault, ".gitignore"),
                "utf8",
            );
            expect(ignoreEntries(vaultIgnore)).toContain("/confluence/");
            const syncIgnore = await readFile(
                join(vault, "confluence/.gitignore"),
                "utf8",
            );
            expect(ignoreEntries(syncIgnore)).toEqual([...SYNC_IGNORES]);
            expect(git(vault, "check-ignore", "confluence/x.md").trim()).toBe(
                "confluence/x.md",
            );
            expect(notices).toEqual([]);
        });

        it("keeps an existing vault repository as it is", async () => {
            git(vault, "init", "-q");
            configure(vault);
            await writeFile(join(vault, "a.md"), "a\n");
            git(vault, "add", "-A");
            git(vault, "commit", "-qm", "first");

            await repos().setupSync();

            expect(subjects(vault)).toEqual(["first"]);
            expect(existsSync(join(vault, "confluence/.git"))).toBe(true);
        });

        it("creates only the folder without git", async () => {
            gitPath = join(vault, "no-such-git");

            await repos().setupSync();

            expect((await stat(join(vault, "confluence"))).isDirectory()).toBe(
                true,
            );
            expect(existsSync(join(vault, ".git"))).toBe(false);
            expect(existsSync(join(vault, "confluence/.git"))).toBe(false);
            expect(notices).toEqual([]);
        });
    });

    describe("vault ignore block", () => {
        it("ignores .obsidian except docket's shared settings", async () => {
            const files = [
                ".obsidian/app.json",
                ".obsidian/workspace.json",
                ".obsidian/plugins/other/main.js",
                ".obsidian/plugins/ctx42-docket/main.js",
                ".obsidian/plugins/ctx42-docket/devices/host.json",
                ".obsidian/plugins/ctx42-docket/data.json",
            ];
            for (const f of files) {
                await mkdir(join(vault, dirname(f)), { recursive: true });
                await writeFile(join(vault, f), "{}");
            }

            await repos().setupSync();

            const shown = git(
                vault,
                "ls-files",
                "--others",
                "--exclude-standard",
            )
                .split("\n")
                .filter((p) => p.startsWith(".obsidian/"));
            expect(shown).toEqual([".obsidian/plugins/ctx42-docket/data.json"]);
        });
    });

    describe("initializeSync", () => {
        it("creates the sync repository and the vault ignore entry", async () => {
            await mkdir(join(vault, "confluence"));
            const r = repos();
            await r.sync.refresh();
            expect(r.sync.state).toEqual({ kind: "no-repo" });

            await r.initializeSync();

            expect(r.sync.state).toEqual({ kind: "ready" });
            const vaultIgnore = await readFile(
                join(vault, ".gitignore"),
                "utf8",
            );
            expect(ignoreEntries(vaultIgnore)).toContain("/confluence/");
        });
    });

    describe("ignore", () => {
        it("writes a sync-folder path into the sync repository's block", async () => {
            const r = repos();
            await r.setupSync();
            configure(join(vault, "confluence"));
            await mkdir(join(vault, "confluence/_docket-media"));
            await writeFile(join(vault, "confluence/_docket-media/a.png"), "x");
            git(join(vault, "confluence"), "add", "-A");
            git(join(vault, "confluence"), "commit", "-qm", "baseline");
            const asked: string[][] = [];

            await r.ignore("confluence/_docket-media", true, (tracked) => {
                asked.push(tracked);
                return Promise.resolve(true);
            });

            const text = await readFile(
                join(vault, "confluence/.gitignore"),
                "utf8",
            );
            expect(ignoreEntries(text)).toEqual([
                ...SYNC_IGNORES,
                "/_docket-media/",
            ]);
            expect(asked).toEqual([["confluence/_docket-media/a.png"]]);
            expect(
                r.sync.changes.map((c) => [c.path, c.kind, c.untracking]),
            ).toContainEqual(["confluence/_docket-media/a.png", "D", true]);
            const vaultText = await readFile(join(vault, ".gitignore"), "utf8");
            expect(ignoreEntries(vaultText)).not.toContain("/_docket-media/");
        });

        it("writes a vault path into the vault repository's block", async () => {
            const r = repos();
            await r.setupSync();
            await writeFile(join(vault, "draft.md"), "x");

            await r.ignore("draft.md", false, () => Promise.resolve(true));

            const text = await readFile(join(vault, ".gitignore"), "utf8");
            expect(ignoreEntries(text)).toContain("/draft.md");
        });

        it("changes nothing when the user cancels", async () => {
            const r = repos();
            await r.setupSync();
            configure(vault);
            await writeFile(join(vault, "a.md"), "x");
            git(vault, "add", "-A");
            git(vault, "commit", "-qm", "baseline");
            const before = await readFile(join(vault, ".gitignore"), "utf8");

            await r.ignore("a.md", false, () => Promise.resolve(false));

            expect(await readFile(join(vault, ".gitignore"), "utf8")).toBe(
                before,
            );
            expect(git(vault, "ls-files", "a.md").trim()).toBe("a.md");
        });
    });

    describe("vault initialize", () => {
        it("creates the vault repository", async () => {
            const r = repos();
            await r.vault.refresh();
            expect(r.vault.state).toEqual({ kind: "no-repo" });

            await r.vault.initialize();

            expect(r.vault.state).toEqual({ kind: "ready" });
        });
    });

    describe("commits", () => {
        it("land only in the repository that made them", async () => {
            const r = repos();
            await r.setupSync();
            configure(vault);
            configure(join(vault, "confluence"));
            await writeFile(join(vault, "kb.md"), "kb\n");
            await writeFile(join(vault, "confluence/page.md"), "page\n");
            await r.refresh();

            const paths = r.sync.changes.map((c) => c.path).sort();
            expect(paths).toEqual([
                "confluence/.gitignore",
                "confluence/page.md",
            ]);
            expect(await r.sync.commit(r.sync.changes, "docs: baseline")).toBe(
                true,
            );

            expect(subjects(join(vault, "confluence"))).toEqual([
                "docs: baseline",
            ]);
            expect(subjects(vault)).toEqual([]);
            expect(r.vault.changes.map((c) => c.path).sort()).toEqual([
                ".gitignore",
                "kb.md",
            ]);
            expect(recorded).toEqual(["sync:docs: baseline"]);
        });

        it("read history and texts by vault path", async () => {
            const r = repos();
            await r.setupSync();
            configure(join(vault, "confluence"));
            await writeFile(join(vault, "confluence/page.md"), "v1\n");
            await r.sync.refresh();
            await r.sync.commit(r.sync.changes, "docs: v1");

            const log = await r.sync.log({
                path: "confluence/page.md",
                skip: 0,
                limit: 10,
            });

            expect(log.map((e) => e.path)).toEqual(["confluence/page.md"]);
            expect(await r.sync.baseText("confluence/page.md")).toBe("v1\n");
            expect(r.forPath("confluence/page.md")).toBe(r.sync);
        });
    });
});
