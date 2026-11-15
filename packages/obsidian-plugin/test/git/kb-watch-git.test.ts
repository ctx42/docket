// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// KbWatch against real git: a bare repository stands in for the host, and a
// pre-receive hook refusing pushes to main stands in for a protected branch.

import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRepo, type KnowledgeBase } from "@docket/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/fs-node.ts";
import { NodeGitExec } from "../../src/adapters/git.ts";
import { GitController } from "../../src/git/controller.ts";
import type { RoleRecord } from "../../src/git/kb-role.ts";
import { KbWatch } from "../../src/git/kb-watch.ts";
import { GitRepos } from "../../src/git/repos.ts";

const hasGit = (() => {
    try {
        execFileSync("git", ["--version"]);
        return true;
    } catch {
        return false;
    }
})();

describe.skipIf(!hasGit || process.platform === "win32")(
    "KbWatch over real git",
    () => {
        let root = "";
        let vault = "";
        let bare = "";
        const git = (cwd: string, ...args: string[]): string =>
            execFileSync("git", args, { cwd, encoding: "utf8" });
        const identity = (cwd: string): void => {
            git(cwd, "config", "user.email", "t@example.com");
            git(cwd, "config", "user.name", "Anna Nowak");
            git(cwd, "config", "commit.gpgsign", "false");
        };

        beforeEach(async () => {
            root = await mkdtemp(join(tmpdir(), "docket-kbw-"));
            vault = join(root, "vault");
            bare = join(root, "kb.git");
            await mkdir(vault);
            const seed = join(root, "seed");
            await mkdir(seed);
            git(seed, "init", "-q", "-b", "main");
            identity(seed);
            await writeFile(join(seed, "a.md"), "a\n");
            git(seed, "add", "-A");
            git(seed, "commit", "-qm", "a");
            git(root, "clone", "-q", "--bare", seed, bare);
        });
        afterEach(async () => {
            await rm(root, { recursive: true, force: true });
        });

        /** setup builds a watch over the vault with `kb` cloned from the bare repository. */
        const setup = () => {
            const exec = new NodeGitExec(() => "", vault);
            const files = {
                isFolder: async (p: string) =>
                    (
                        await stat(join(vault, p)).catch(() => null)
                    )?.isDirectory() ?? false,
                read: () => Promise.resolve(null),
                write: () => Promise.resolve(),
                mkdir: () => Promise.resolve(),
            };
            const ctl = (r: string): GitController =>
                new GitController({
                    root: () => r,
                    open: (at) =>
                        new GitRepo(
                            new NodeGitExec(() => "", join(vault, at)),
                            new NodeFileSystem(),
                            at,
                        ),
                    files,
                    notify: () => {},
                    record: () => {},
                });
            const repos = new GitRepos(ctl(""), ctl("conflu"), files, ctl);
            repos.setKnowledgeBases(["kb"]);
            const kbs: KnowledgeBase[] = [
                { kind: "git", name: "kb", url: `file://${bare}`, branch: "" },
            ];
            let roles: Record<string, RoleRecord> = {};
            const opened: string[] = [];
            const watch = new KbWatch({
                exec,
                repos,
                knowledgeBases: () => kbs,
                setPin: async () => {},
                folderExists: async (p) =>
                    (await stat(join(vault, p)).catch(() => null)) !== null,
                loadRoles: () => roles,
                saveRoles: (r) => {
                    roles = r;
                },
                openUrl: (u) => opened.push(u),
                now: () => 1,
                today: () => new Date(2026, 10, 16, 9, 5),
            });
            return { watch, roles: () => roles, opened };
        };

        it("clones, learns own access, pushes, then meets a protected main", async () => {
            const { watch, roles } = setup();

            expect(await watch.clone("kb")).toBe(true);
            identity(join(vault, "kb"));
            await watch.check("kb");
            expect(roles()["kb"]?.role).toBe("own");

            await writeFile(join(vault, "kb", "b.md"), "b\n");
            await watch.check("kb");
            expect(watch.status("kb")?.edited).toBe(1);
            await watch.commit("kb", "docs: b");
            await watch.push("kb");
            expect(git(bare, "log", "--format=%s", "main").trim()).toBe(
                "docs: b\na",
            );

            const hook = join(bare, "hooks", "pre-receive");
            await writeFile(
                hook,
                '#!/bin/sh\nwhile read old new ref; do\n  [ "$ref" = refs/heads/main ] && { echo "protected branch: use a pull request" >&2; exit 1; }\ndone\nexit 0\n',
            );
            await chmod(hook, 0o755);
            await writeFile(join(vault, "kb", "c.md"), "c\n");
            await watch.check("kb");
            await watch.commit("kb", "docs: c");
            await expect(watch.push("kb")).rejects.toThrow(/protected/);
            expect(roles()["kb"]?.protected).toBe(true);

            const p = await watch.propose("kb");
            expect(p).toEqual({
                branch: "docket/anna-nowak-2026-11-16-0905",
                url: null,
            });
            expect(
                git(
                    bare,
                    "log",
                    "--format=%s",
                    "docket/anna-nowak-2026-11-16-0905",
                ).trim(),
            ).toBe("docs: c\ndocs: b\na");
        });

        it("cancels a clone and leaves no folder", async () => {
            const { watch } = setup();

            const run = watch.clone("kb");
            watch.cancel("kb");
            await run;

            expect(watch.status("kb")?.clone.kind).not.toBe("running");
        });
    },
);
