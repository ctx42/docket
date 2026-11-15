// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The dialogs a git knowledge base's card opens: the commit message for
// Commit & push (or Commit & propose), the review of a pinned base's update,
// and the files a pull left with conflicts. DOM glue.

import { hasConflictMarkers, type Update } from "@docket/core";
import { type App, Modal, Setting, TFile } from "obsidian";
import { firstLine } from "../git/history.ts";

/**
 * commitMessageModal asks for the message of a commit of `files` changed
 * files, offering the recent `history`; it resolves the trimmed message, or
 * null when cancelled.
 */
export function commitMessageModal(
    app: App,
    title: string,
    files: number,
    history: readonly string[],
    confirmText: string,
): Promise<string | null> {
    return new Promise((resolve) => {
        let answered = false;
        const modal = new Modal(app).setTitle(title);
        const el = modal.contentEl;
        el.createEl("p", {
            text: `Commits ${files === 1 ? "the 1 changed file" : `all ${files} changed files`}.`,
        });
        const area = el.createEl("textarea", {
            cls: "docket-git-message docket-kb-message",
            attr: { rows: "4", placeholder: "Commit message" },
        });
        area.value = history[0] ?? "";
        if (history.length > 0) {
            const pick = el.createEl("select", { cls: "dropdown" });
            pick.createEl("option", {
                text: "Recent messages…",
                attr: { value: "", disabled: "", selected: "" },
            });
            history.forEach((m, i) => {
                pick.createEl("option", {
                    text: firstLine(m),
                    value: String(i),
                });
            });
            pick.onchange = () => {
                area.value = history[Number(pick.value)] ?? area.value;
                area.focus();
            };
        }
        let ok: HTMLButtonElement | null = null;
        new Setting(el)
            .addButton((b) =>
                b.setButtonText("Cancel").onClick(() => modal.close()),
            )
            .addButton((b) => {
                ok = b.buttonEl;
                b.setButtonText(confirmText)
                    .setCta()
                    .onClick(() => {
                        const m = area.value.trim();
                        if (m === "") return;
                        answered = true;
                        resolve(m);
                        modal.close();
                    });
            });
        const sync = (): void => {
            if (ok !== null) ok.disabled = area.value.trim() === "";
        };
        area.oninput = sync;
        sync();
        modal.onClose = () => {
            if (!answered) resolve(null);
        };
        modal.open();
        area.focus();
    });
}

/**
 * updateModal lists what moving the pinned knowledge base `name` from `from`
 * to `to` changes, resolving true when the user accepts the update.
 */
export function updateModal(
    app: App,
    name: string,
    update: Update,
    from: string,
    to: string,
): Promise<boolean> {
    return new Promise((resolve) => {
        let answered = false;
        const modal = new Modal(app).setTitle(`Update ${name}`);
        const el = modal.contentEl;
        const n = update.commits;
        el.createEl("p", {
            text: `Moves the pin from ${from.slice(0, 7)} to ${to.slice(0, 7)}: ${n} commit${n === 1 ? "" : "s"}. Nothing changes until you update.`,
        });
        const groups: [string, string, string[]][] = [
            ["Changed", "is-changed", update.changed],
            ["Added", "is-added", update.added],
            ["Removed", "is-removed", update.removed],
        ];
        for (const [label, cls, paths] of groups) {
            if (paths.length === 0) continue;
            el.createEl("h4", { text: `${label} (${paths.length})` });
            const list = el.createEl("ul", {
                cls: `docket-confirm-list docket-kb-update ${cls}`,
            });
            for (const p of paths) list.createEl("li", { text: p });
        }
        new Setting(el)
            .addButton((b) =>
                b.setButtonText("Keep the pin").onClick(() => modal.close()),
            )
            .addButton((b) =>
                b
                    .setButtonText(`Update to ${to.slice(0, 7)}`)
                    .setCta()
                    .onClick(() => {
                        answered = true;
                        resolve(true);
                        modal.close();
                    }),
            );
        modal.onClose = () => {
            if (!answered) resolve(false);
        };
        modal.open();
    });
}

/**
 * resolveModal lists the files a pull left with conflicts in the knowledge
 * base `name`: each opens in the editor, and once its conflict markers are
 * gone `markResolved` tells git. It resolves when the dialog closes.
 */
export function resolveModal(
    app: App,
    name: string,
    files: () => readonly string[],
    markResolved: (path: string) => Promise<void>,
): Promise<void> {
    return new Promise((resolve) => {
        const modal = new Modal(app).setTitle(`Resolve conflicts in ${name}`);
        const el = modal.contentEl;
        el.createEl("p", {
            text: "These files were changed here and upstream. Open each one, keep what you want between the <<<<<<< and >>>>>>> lines, and delete the markers. Your own uncommitted changes are also kept in the git stash.",
        });
        const list = el.createDiv({ cls: "docket-kb-resolve" });
        const draw = async (): Promise<void> => {
            list.empty();
            const paths = files();
            if (paths.length === 0) {
                list.createEl("p", { text: "No conflicts are left." });
                return;
            }
            for (const path of paths) {
                const row = list.createDiv({ cls: "docket-kb-resolve-row" });
                const file = app.vault.getAbstractFileByPath(path);
                const link = row.createEl("a", { text: path, href: "#" });
                link.onclick = (ev) => {
                    ev.preventDefault();
                    if (file instanceof TFile) {
                        void app.workspace.getLeaf("tab").openFile(file);
                    }
                };
                const text =
                    file instanceof TFile ? await app.vault.read(file) : "";
                const open = hasConflictMarkers(text);
                row.createSpan({
                    cls: "docket-muted",
                    text: open ? "still has markers" : "no markers left",
                });
                const b = row.createEl("button", { text: "Mark resolved" });
                b.disabled = open;
                b.onclick = () => {
                    b.disabled = true;
                    void markResolved(path).then(() => draw());
                };
            }
        };
        new Setting(el)
            .addButton((b) =>
                b.setButtonText("Check again").onClick(() => void draw()),
            )
            .addButton((b) =>
                b.setButtonText("Close").onClick(() => modal.close()),
            );
        modal.onClose = () => resolve();
        modal.open();
        void draw();
    });
}
