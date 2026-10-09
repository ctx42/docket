// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The docket items of Obsidian's context menus — one note, several notes, a
// folder — shared by the workspace menus (main.ts) and the panel's own menus, so
// every place offers the same actions under the same names. DOM + obsidian
// glue; which actions a note gets is note-actions.ts.

import {
    type Menu,
    Notice,
    type TAbstractFile,
    TFile,
    type TFolder,
} from "obsidian";
import type docketPlugin from "../main.ts";
import {
    canPublish,
    type NoteAction,
    noteActions,
    noteLink,
} from "./note-actions.ts";
import { toDest } from "./operations.ts";

/** SECTION groups docket's items so Obsidian draws them as one menu section. */
const SECTION = "docket";

/** NOTE_ITEMS are each note action's menu title, icon, and warning styling. */
const NOTE_ITEMS: Record<NoteAction, [string, string, boolean]> = {
    pull: ["Pull from Confluence", "arrow-down", false],
    push: ["Push to Confluence…", "arrow-up", false],
    discard: ["Discard local changes…", "rotate-ccw", true],
};

/** frontmatter returns a file's cached frontmatter, or undefined. */
export function frontmatter(plugin: docketPlugin, file: TFile): unknown {
    return plugin.app.metadataCache.getFileCache(file)?.frontmatter;
}

/** runNoteAction runs one note action on `file` through the controller. */
export function runNoteAction(
    plugin: docketPlugin,
    action: NoteAction,
    file: TFile,
): Promise<void> {
    const dests = [toDest(file.path)];
    const c = plugin.controller;
    if (action === "pull") return c.pull({ kind: "notes", dests });
    if (action === "push") return c.push({ kind: "notes", dests });
    return c.discard(dests);
}

/** openInConfluence opens a URL in the system browser. */
export function openInConfluence(url: string): void {
    window.open(url, "_blank");
}

/** copyLink copies a URL to the clipboard, confirming with a notice. */
export function copyLink(url: string): void {
    navigator.clipboard.writeText(url).then(
        () => new Notice("docket: Confluence link copied"),
        (err: unknown) =>
            new Notice(
                `docket: copy failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
    );
}

/**
 * addNoteItems adds the docket section for one note: its sync actions and
 * publish (greyed out while a run is in flight), then open / copy its
 * Confluence link. It
 * returns whether it added anything. `skip` leaves out actions the caller
 * already shows as buttons.
 */
export function addNoteItems(
    menu: Menu,
    plugin: docketPlugin,
    file: TFile,
    skip: NoteAction[] = [],
): boolean {
    const fm = frontmatter(plugin, file);
    const actions = noteActions(fm).filter((a) => !skip.includes(a));
    const busy = plugin.controller.busy;
    for (const a of actions) {
        const [title, icon, warning] = NOTE_ITEMS[a];
        menu.addItem((item) => {
            item.setSection(SECTION)
                .setTitle(title)
                .setIcon(icon)
                .setDisabled(busy)
                .onClick(() => void runNoteAction(plugin, a, file));
            if (warning) item.setWarning(true);
        });
    }
    const publishable = canPublish(fm);
    if (publishable) {
        menu.addItem((item) =>
            item
                .setSection(SECTION)
                .setTitle("Publish to Confluence…")
                .setIcon("globe")
                .setDisabled(busy)
                .onClick(
                    () => void plugin.controller.publish(toDest(file.path)),
                ),
        );
    }
    const url = noteLink(fm);
    if (url !== "") {
        menu.addItem((item) =>
            item
                .setSection(SECTION)
                .setTitle("Open in Confluence")
                .setIcon("external-link")
                .onClick(() => openInConfluence(url)),
        );
        menu.addItem((item) =>
            item
                .setSection(SECTION)
                .setTitle("Copy Confluence link")
                .setIcon("link")
                .onClick(() => copyLink(url)),
        );
    }
    return actions.length > 0 || publishable || url !== "";
}

/** syncedUnder returns the notes under `folder` that offer `action`. */
export function syncedUnder(
    plugin: docketPlugin,
    folder: TFolder,
    action: NoteAction,
): TFile[] {
    const prefix = folder.isRoot() ? "" : `${folder.path}/`;
    return plugin.app.vault
        .getMarkdownFiles()
        .filter(
            (f) =>
                f.path.startsWith(prefix) &&
                noteActions(frontmatter(plugin, f)).includes(action),
        );
}

/** addFolderItems adds "Pull folder" / "Push folder…" for a folder of synced notes. */
export function addFolderItems(
    menu: Menu,
    plugin: docketPlugin,
    folder: TFolder,
): void {
    const pulls = syncedUnder(plugin, folder, "pull");
    if (pulls.length === 0) return;
    const busy = plugin.controller.busy;
    menu.addItem((item) =>
        item
            .setSection(SECTION)
            .setTitle(`Pull folder from Confluence (${pulls.length})`)
            .setIcon("arrow-down")
            .setDisabled(busy)
            .onClick(
                () =>
                    void plugin.controller.pull({
                        kind: "notes",
                        dests: pulls.map((f) => toDest(f.path)),
                    }),
            ),
    );
    menu.addItem((item) =>
        item
            .setSection(SECTION)
            .setTitle("Push folder to Confluence…")
            .setIcon("arrow-up")
            .setDisabled(busy)
            .onClick(
                () =>
                    void plugin.controller.push({
                        kind: "folder",
                        path: folder.isRoot() ? "." : folder.path,
                    }),
            ),
    );
}

/** addFilesItems adds pull / push for a multi-selection holding synced notes. */
export function addFilesItems(
    menu: Menu,
    plugin: docketPlugin,
    files: TAbstractFile[],
): void {
    const notes = files.filter((f): f is TFile => f instanceof TFile);
    const offering = (a: NoteAction): string[] =>
        notes
            .filter((f) => noteActions(frontmatter(plugin, f)).includes(a))
            .map((f) => toDest(f.path));
    const pulls = offering("pull");
    const pushes = offering("push");
    const busy = plugin.controller.busy;
    if (pulls.length > 0) {
        menu.addItem((item) =>
            item
                .setSection(SECTION)
                .setTitle(`Pull ${pulls.length} from Confluence`)
                .setIcon("arrow-down")
                .setDisabled(busy)
                .onClick(
                    () =>
                        void plugin.controller.pull({
                            kind: "notes",
                            dests: pulls,
                        }),
                ),
        );
    }
    if (pushes.length > 0) {
        menu.addItem((item) =>
            item
                .setSection(SECTION)
                .setTitle(`Push ${pushes.length} to Confluence…`)
                .setIcon("arrow-up")
                .setDisabled(busy)
                .onClick(
                    () =>
                        void plugin.controller.push({
                            kind: "notes",
                            dests: pushes,
                        }),
                ),
        );
    }
}
