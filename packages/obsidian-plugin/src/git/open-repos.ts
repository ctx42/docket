// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Builds the vault's two repository controllers (repos.ts) over Obsidian: git
// runs in the vault folder on disk, files go through the vault adapter, and
// failures show as notices. Obsidian glue only.

import { join } from "node:path";
import { GitRepo, SYNC_IGNORES } from "@docket/core";
import { type App, FileSystemAdapter, Notice } from "obsidian";
import { NodeFileSystem } from "../adapters/fs-node.ts";
import { NodeGitExec } from "../adapters/git.ts";
import { GitController } from "./controller.ts";
import type { RepoId } from "./history.ts";
import { GitRepos, type RepoFiles } from "./repos.ts";

/** RepoHooks is what the controllers read from and report to the plugin. */
export interface RepoHooks {
    /** gitPath returns this device's git path setting, read on every call. */
    gitPath: () => string;
    /** syncFolder returns the sync folder's vault path, `""` when none is set. */
    syncFolder: () => string;
    /** record keeps a message committed to `repo`. */
    record: (repo: RepoId, message: string) => void;
}

/** openRepos builds the vault and sync controllers for `app`'s vault. */
export function openRepos(app: App, hooks: RepoHooks): GitRepos {
    const adapter = app.vault.adapter;
    const base =
        adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
    const open =
        base === null
            ? undefined
            : (root: string): GitRepo =>
                  new GitRepo(
                      new NodeGitExec(hooks.gitPath, join(base, root)),
                      new NodeFileSystem(),
                      root,
                  );
    const files: RepoFiles = {
        isFolder: async (p) => (await adapter.stat(p))?.type === "folder",
        read: async (p) => ((await adapter.exists(p)) ? adapter.read(p) : null),
        write: (p, text) => adapter.write(p, text),
        mkdir: (p) => adapter.mkdir(p),
    };
    const notify = (text: string): void => {
        new Notice(text);
    };
    const controller = (
        repo: RepoId,
        root: () => string | null,
    ): GitController =>
        new GitController({
            root,
            ...(open === undefined ? {} : { open }),
            files,
            notify,
            record: (m) => hooks.record(repo, m),
            ...(repo === "sync" ? { ignores: SYNC_IGNORES } : {}),
        });
    return new GitRepos(
        controller("vault", () => ""),
        controller("sync", () => {
            const folder = hooks.syncFolder();
            return folder === "" ? null : folder;
        }),
        files,
    );
}
