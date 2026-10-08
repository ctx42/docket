// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The panel's Sync tab: the first-run setup step, or the vault-wide toolbar,
// the active note's card, the live progress, the changes from the last status
// check (sync-changes.ts) and the last run (sync-run.ts). DOM shell; the logic
// is note-state.ts, review.ts, summary.ts and panel-model.ts.

import { hasConflictMarkers, posixClean } from "@docket/core";
import { Menu, setIcon, type TFile } from "obsidian";
import type docketPlugin from "../main.ts";
import { confluenceTitles, editLocation } from "../settings/location-modal.ts";
import { putLocation } from "../settings/locations.ts";
import { addNoteItems, frontmatter, runNoteAction } from "./menus.ts";
import { type NoteAction, noteLink } from "./note-actions.ts";
import { type NoteStateKind, noteState } from "./note-state.ts";
import { toDest } from "./operations.ts";
import { cardButtons, cardDetail, setupStep } from "./panel-model.ts";
import { ChangesList } from "./sync-changes.ts";
import { RunLog } from "./sync-run.ts";

/** STATE_ICON is the card's icon for each note state. */
const STATE_ICON: Record<NoteStateKind, string> = {
    unsynced: "circle-dashed",
    new: "file-plus",
    conflict: "alert-triangle",
    edited: "pencil",
    incoming: "arrow-down",
    diverged: "git-merge",
    refused: "ban",
    unchecked: "alert-circle",
    ignored: "eye-off",
    synced: "check",
    unknown: "circle",
};

/** ACTION_BUTTON is the card's button text for each note action. */
const ACTION_BUTTON: Record<NoteAction, string> = {
    pull: "Pull",
    push: "Push…",
    discard: "Discard…",
};

/** SyncHost is what the tab needs from the panel that holds it. */
export interface SyncHost {
    /** schedule coalesces a re-render into the next frame. */
    schedule(): void;
    /** rerender redraws the panel at once. */
    rerender(): void;
    /** moreItems adds the panel's "more" actions to `menu`. */
    moreItems(menu: Menu): void;
}

export class SyncTab {
    /** showIgnored adds the ignored notes to the changes list. */
    showIgnored = false;
    private readonly changes: ChangesList;
    private readonly runLog: RunLog;
    /** Conflict-marker checks per note path, keyed by the mtime they read. */
    private readonly conflicts = new Map<
        string,
        { mtime: number; has: boolean }
    >();

    constructor(
        private readonly plugin: docketPlugin,
        private readonly host: SyncHost,
    ) {
        this.changes = new ChangesList(plugin, () => host.rerender());
        this.runLog = new RunLog(plugin);
    }

    /** render draws the tab into `root`. */
    render(root: HTMLElement): void {
        if (this.renderSetup(root)) return;
        this.renderToolbar(root);
        this.renderCard(root);
        this.runLog.renderProgress(root);
        this.changes.render(root, this.showIgnored);
        this.runLog.renderLastRun(root);
    }

    /**
     * renderToolbar draws the vault-wide actions as a nav-header button row, the
     * way the file explorer does: a docked view's own header (where `addAction`
     * puts its buttons) is hidden in the sidebars.
     */
    private renderToolbar(root: HTMLElement): void {
        const c = this.plugin.controller;
        const bar = root
            .createDiv({ cls: "nav-header docket-toolbar" })
            .createDiv({ cls: "nav-buttons-container" });
        const button = (
            icon: string,
            label: string,
            onClick: (e: MouseEvent) => void,
            sync = true,
        ): void => {
            const btn = bar.createDiv({
                cls: "clickable-icon nav-action-button",
                attr: { "aria-label": label },
            });
            setIcon(btn, icon);
            if (sync && c.busy) btn.addClass("is-disabled");
            btn.onclick = onClick;
        };
        button(
            "arrow-down",
            "Pull whole vault",
            () => void c.pull({ kind: "vault" }),
        );
        button(
            "arrow-up",
            "Push whole vault…",
            () => void c.push({ kind: "vault" }),
        );
        button("refresh-cw", "Check status", () => void c.checkStatus());
        button(
            "more-horizontal",
            "More options",
            (e) => {
                const menu = new Menu();
                this.host.moreItems(menu);
                menu.showAtMouseEvent(e);
            },
            false,
        );
    }

    /**
     * renderSetup draws the first-run state — connect, then add a location —
     * and reports whether it did, in which case no other sync section is drawn.
     */
    private renderSetup(root: HTMLElement): boolean {
        const step = setupStep(this.plugin.settings, this.plugin.token);
        if (step === null) return false;
        const empty = root.createDiv({ cls: "docket-empty" });
        setIcon(empty.createDiv({ cls: "docket-empty-icon" }), step.icon);
        empty.createDiv({ cls: "docket-empty-text", text: step.text });
        const btn = empty.createEl("button", {
            cls: "mod-cta",
            text: step.cta,
        });
        btn.onclick = step.addLocation
            ? () => void this.addLocation()
            : () => this.plugin.openSettings();
        return true;
    }

    /** addLocation opens the add-location dialog and saves what it returns. */
    private async addLocation(): Promise<void> {
        const next = await editLocation(
            this.plugin.app,
            this.plugin.settings,
            null,
            confluenceTitles(this.plugin.settings, this.plugin.token),
        );
        if (next === null) return;
        this.plugin.settings = putLocation(this.plugin.settings, next, null);
        await this.plugin.persistSettings();
    }

    /** activeFile is the active Markdown note, or null. */
    activeFile(): TFile | null {
        const f = this.plugin.app.workspace.getActiveFile();
        return f !== null && f.extension === "md" ? f : null;
    }

    /** renderCard draws the active note's sync state and its actions. */
    private renderCard(root: HTMLElement): void {
        const card = root.createDiv({ cls: "docket-card" });
        const file = this.activeFile();
        if (file === null) {
            card.addClass("is-empty");
            card.createDiv({
                cls: "docket-card-detail",
                text: "Open a note to see its sync state.",
            });
            return;
        }
        const dest = toDest(file.path);
        const root0 = posixClean(this.plugin.settings.syncRoot || ".");
        const state = noteState({
            dest,
            fm: frontmatter(this.plugin, file),
            inSyncRoot: root0 === "." || dest.startsWith(`${root0}/`),
            conflicts: this.hasConflicts(file),
            mtime: file.stat.mtime,
            status: this.plugin.controller.status,
        });
        card.addClass(`is-${state.kind}`);

        const head = card.createDiv({ cls: "docket-card-head" });
        setIcon(
            head.createSpan({ cls: "docket-card-icon" }),
            STATE_ICON[state.kind],
        );
        const titles = head.createDiv({ cls: "docket-card-titles" });
        titles.createDiv({ cls: "docket-card-name", text: file.basename });
        titles.createDiv({ cls: "docket-card-state", text: state.label });
        const detail = cardDetail(state.detail, state.version);
        if (detail !== "") {
            card.createDiv({ cls: "docket-card-detail", text: detail });
        }

        const buttons = cardButtons(state.actions, state.primary);
        const url = noteLink(frontmatter(this.plugin, file));
        if (buttons.length === 0 && url === "" && state.actions.length === 0)
            return;
        const row = card.createDiv({ cls: "docket-card-actions" });
        const busy = this.plugin.controller.busy;
        for (const a of buttons) {
            const btn = row.createEl("button", { text: ACTION_BUTTON[a] });
            if (a === state.primary) btn.addClass("mod-cta");
            btn.disabled = busy;
            btn.onclick = () => void runNoteAction(this.plugin, a, file);
        }
        const more = row.createEl("button", {
            cls: "clickable-icon docket-card-more",
            attr: { "aria-label": "More actions" },
        });
        setIcon(more, "more-horizontal");
        more.onclick = (e) => {
            const menu = new Menu();
            addNoteItems(menu, this.plugin, file, buttons);
            menu.showAtMouseEvent(e);
        };
    }

    /**
     * hasConflicts reports whether `file` carries conflict markers, from a
     * per-mtime cache; a stale entry is refreshed in the background and the card
     * re-rendered once the read lands.
     */
    private hasConflicts(file: TFile): boolean {
        const hit = this.conflicts.get(file.path);
        if (hit !== undefined && hit.mtime === file.stat.mtime) return hit.has;
        const mtime = file.stat.mtime;
        void this.plugin.app.vault.cachedRead(file).then((text) => {
            this.conflicts.set(file.path, {
                mtime,
                has: hasConflictMarkers(text),
            });
            this.host.schedule();
        });
        return hit?.has ?? false;
    }
}
