// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The "Ignore in Git" item of a file's or folder's context menu (Obsidian's
// `file-menu`, shown by the file explorer and a note's tab alike). It adds the
// path to docket's block in the `.gitignore` of the repository owning it (see
// `GitRepos.ignore`); for a path git already tracks it first lists the tracked
// files and, on confirm, untracks them so their removals show staged in the Git
// tab. Cancel changes nothing.

import { type Menu, type TAbstractFile, TFolder } from "obsidian";
import type docketPlugin from "../main.ts";
import { confirmModal } from "../ui/confirm.ts";

/** MAX_LISTED caps the tracked files the confirmation lists by name. */
const MAX_LISTED = 50;

/**
 * addIgnoreItem adds "Ignore in Git" for `file` when the repository owning it
 * is ready; never for the vault root, the sync folder, or a `.gitignore`.
 */
export function addIgnoreItem(
    menu: Menu,
    plugin: docketPlugin,
    file: TAbstractFile,
): void {
    const repos = plugin.repos;
    const git = repos.forPath(file.path);
    if (!git.ready || !repos.ignorable(file.path)) return;
    const folder = file instanceof TFolder;
    menu.addItem((item) =>
        item
            .setSection("docket")
            .setTitle("Ignore in Git")
            .setIcon("eye-off")
            .setDisabled(git.busy)
            .onClick(
                () =>
                    void repos.ignore(file.path, folder, (tracked) =>
                        confirmUntrack(plugin, tracked),
                    ),
            ),
    );
}

/** confirmUntrack asks before docket stops tracking `tracked`. */
function confirmUntrack(
    plugin: docketPlugin,
    tracked: string[],
): Promise<boolean> {
    const shown = tracked.slice(0, MAX_LISTED);
    if (tracked.length > MAX_LISTED) {
        shown.push(`…and ${tracked.length - MAX_LISTED} more`);
    }
    return confirmModal(
        plugin.app,
        "Stop tracking in Git?",
        "Git tracks these files. They stay on disk; docket stops tracking them and stages their removal for your next commit:",
        shown,
        "Ignore",
    );
}
