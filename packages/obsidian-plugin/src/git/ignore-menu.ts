// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The "Ignore in Git" item of a file's or folder's context menu (Obsidian's
// `file-menu`, shown by the file explorer and a note's tab alike). It adds the
// path to docket's block in `.gitignore`; for a path git already tracks it first
// lists the tracked files and, on confirm, untracks them so their removals show
// staged in the Git tab. Cancel changes nothing.

import { addIgnoreEntry, ignorePattern } from "@docket/core";
import { type Menu, type TAbstractFile, TFolder } from "obsidian";
import type docketPlugin from "../main.ts";
import { confirmModal } from "../ui/confirm.ts";
import { GITIGNORE } from "./controller.ts";

/** MAX_LISTED caps the tracked files the confirmation lists by name. */
const MAX_LISTED = 50;

/** addIgnoreItem adds "Ignore in Git" for `file` when the vault is a repository. */
export function addIgnoreItem(
    menu: Menu,
    plugin: docketPlugin,
    file: TAbstractFile,
): void {
    const git = plugin.git;
    if (!git.ready) return;
    const folder = file instanceof TFolder;
    if ((folder && file.isRoot()) || file.path === GITIGNORE) return;
    menu.addItem((item) =>
        item
            .setSection("docket")
            .setTitle("Ignore in Git")
            .setIcon("eye-off")
            .setDisabled(git.busy)
            .onClick(() => void ignorePath(plugin, file.path, folder)),
    );
}

/** ignorePath ignores `path`, confirming first when git tracks files under it. */
export async function ignorePath(
    plugin: docketPlugin,
    path: string,
    folder: boolean,
): Promise<void> {
    const git = plugin.git;
    const tracked = await git.trackedUnder(path);
    if (tracked.length > 0) {
        const shown = tracked.slice(0, MAX_LISTED);
        if (tracked.length > MAX_LISTED) {
            shown.push(`…and ${tracked.length - MAX_LISTED} more`);
        }
        const yes = await confirmModal(
            plugin.app,
            "Stop tracking in Git?",
            "Git tracks these files. They stay on disk; docket stops tracking them and stages their removal for your next commit:",
            shown,
            "Ignore",
        );
        if (!yes) return;
    }
    await git.ignore(
        (text) => addIgnoreEntry(text, ignorePattern(path, folder)),
        tracked.length > 0 ? path : "",
    );
}
