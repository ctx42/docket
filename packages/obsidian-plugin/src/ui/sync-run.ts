// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The Sync tab's run sections: the progress bar while a run is in flight, and
// the last run's summary, error and its notes as a folder tree, each note
// linked to its file. DOM shell; the run model is run-state.ts, summary.ts and
// run-tree.ts, the render decisions panel-model.ts.

import { setIcon, TFile } from "obsidian";
import type docketPlugin from "../main.ts";
import { destOf, progressPercent } from "./panel-model.ts";
import type { RunState } from "./run-state.ts";
import {
    type EntryKind,
    type RunEntry,
    type RunFolder,
    RunFolds,
    runTree,
    SMALL_RUN,
} from "./run-tree.ts";
import { summaryParts } from "./summary.ts";

/** ENTRY_ICON is a run-tree note's icon for what the run did to it. */
const ENTRY_ICON: Record<EntryKind, string> = {
    added: "plus",
    updated: "dot",
    moved: "arrow-right",
    deleted: "minus",
    conflict: "alert-triangle",
    warn: "alert-triangle",
    err: "alert-triangle",
    unchanged: "dot",
    skipped: "dot",
};

export class RunLog {
    /** The folders the user opened or closed in the current run's tree. */
    private folds = new RunFolds();
    /** The run the folds belong to; a new run starts with fresh folds. */
    private foldRun: RunState | null = null;

    constructor(
        private readonly plugin: docketPlugin,
        private readonly rerender: () => void,
    ) {}

    /** renderProgress draws the bar while something is in flight. */
    renderProgress(root: HTMLElement): void {
        const c = this.plugin.controller;
        if (!c.busy) return;
        const run = c.run;
        const live =
            run !== null &&
            (run.phase === "discovering" || run.phase === "processing");
        const prog = root.createDiv({ cls: "docket-progress" });
        const track = prog.createDiv({ cls: "docket-bar" });
        const fill = track.createDiv({ cls: "docket-bar-fill" });
        const cap = prog.createDiv({ cls: "docket-caption" });
        if (!live || run.phase === "discovering") {
            track.addClass("is-indeterminate");
            const what = live
                ? `Finding pages… ${run.found} found`
                : "Checking with Confluence…";
            cap.createSpan({ cls: "docket-caption-name", text: what });
            return;
        }
        const pct = progressPercent(run.pos, run.total);
        fill.style.setProperty("--docket-progress", `${pct}%`);
        cap.createSpan({
            cls: "docket-caption-count",
            text: `${run.pos}/${run.total}`,
        });
        cap.createSpan({ cls: "docket-caption-name", text: run.current });
    }

    /** renderLastRun draws the last run's summary, error, and folder tree. */
    renderLastRun(root: HTMLElement): void {
        const run = this.plugin.controller.run;
        if (run === null) return;
        const done = run.phase === "done" || run.phase === "error";
        if (run !== this.foldRun) {
            this.foldRun = run;
            this.folds = new RunFolds();
        }
        const section = root.createDiv({ cls: "docket-section" });
        const head = section.createDiv({ cls: "docket-section-head" });
        head.createSpan({
            cls: "docket-section-title",
            text: done ? "Last run" : "Running",
        });
        if (done) {
            const parts = head.createSpan({ cls: "docket-summary" });
            const list = summaryParts(run);
            if (list.length === 0)
                parts.createSpan({
                    cls: "docket-muted",
                    text: "nothing to do",
                });
            for (const p of list) {
                parts.createSpan({
                    cls: `docket-part is-${p.kind}`,
                    text: `${p.count} ${p.label}`,
                });
            }
        }
        if (run.phase === "error") {
            const banner = section.createDiv({ cls: "docket-error" });
            setIcon(
                banner.createSpan({ cls: "docket-error-icon" }),
                "alert-triangle",
            );
            banner.createSpan({
                cls: "docket-error-text",
                text: run.errorText || "the run failed",
            });
        }
        const tree = runTree(run.rows);
        const small = tree.root.total <= SMALL_RUN;
        if (tree.root.folders.length > 0) {
            this.foldButtons(head, tree.root, "Expand all", "Collapse all");
        }
        if (tree.root.total > 0) {
            this.renderContents(
                section.createDiv({ cls: "docket-run-tree" }),
                tree.root,
                small,
            );
        }
        if (tree.loose.length > 0) {
            const notes = section.createDiv({ cls: "docket-run-notes" });
            for (const row of tree.loose) {
                notes.createDiv({
                    cls: `docket-log-row is-${row.kind}`,
                    text: row.text,
                });
            }
        }
    }

    /** renderContents draws a folder's problem notes, sub-folders, then other notes. */
    private renderContents(
        parent: HTMLElement,
        f: RunFolder,
        small: boolean,
    ): void {
        for (const e of f.lead) this.renderEntry(parent, e);
        for (const sub of f.folders) this.renderFolder(parent, sub, small);
        for (const e of f.entries) this.renderEntry(parent, e);
    }

    /**
     * renderFolder draws one folder as a collapsible tree item with its note
     * count and, on hover, the pair that opens or closes everything under it.
     */
    private renderFolder(
        parent: HTMLElement,
        f: RunFolder,
        small: boolean,
    ): void {
        const open = this.folds.isOpen(f, small);
        const item = parent.createDiv({ cls: "tree-item docket-run-folder" });
        const self = item.createDiv({
            cls: "tree-item-self is-clickable mod-collapsible",
        });
        const toggle = self.createDiv({ cls: "tree-item-icon collapse-icon" });
        if (!open) toggle.addClass("is-collapsed");
        setIcon(toggle, "right-triangle");
        self.createDiv({ cls: "tree-item-inner", text: f.name });
        const end = self.createDiv({ cls: "docket-row-end" });
        this.foldButtons(
            end,
            f,
            `Expand all under ${f.name}`,
            `Collapse all under ${f.name}`,
        );
        end.createDiv({ cls: "tree-item-flair", text: String(f.total) });
        self.onclick = () => {
            this.folds.toggle(f, small);
            this.rerender();
        };
        if (!open) return;
        this.renderContents(
            item.createDiv({ cls: "tree-item-children" }),
            f,
            small,
        );
    }

    /**
     * foldButtons appends the hover pair that opens or closes `f` and all
     * under it. UX: never show the pair at rest or hide it with display, which
     * shifts the row; it stays hidden until the row is hovered.
     */
    private foldButtons(
        parent: HTMLElement,
        f: RunFolder,
        expand: string,
        collapse: string,
    ): void {
        const acts = parent.createDiv({ cls: "docket-run-acts" });
        const button = (icon: string, label: string, open: boolean): void => {
            const btn = acts.createDiv({
                cls: "clickable-icon docket-icon-btn",
                attr: { "aria-label": label },
            });
            setIcon(btn, icon);
            btn.onclick = (e) => {
                e.stopPropagation();
                this.folds.setAll(f, open);
                this.rerender();
            };
        };
        button("chevrons-up-down", expand, true);
        button("chevrons-down-up", collapse, false);
    }

    /** renderEntry draws one note: what happened, its detail and version, linked to the file. */
    private renderEntry(parent: HTMLElement, e: RunEntry): void {
        const file =
            e.kind === "deleted"
                ? null
                : this.noteAt(destOf(this.plugin.settings.syncRoot, e.name));
        const self = parent.createDiv({
            cls: `tree-item-self docket-run-entry is-${e.kind}`,
            attr: { "aria-label": e.name, "data-tooltip-position": "left" },
        });
        setIcon(
            self.createDiv({ cls: "tree-item-icon docket-run-icon" }),
            ENTRY_ICON[e.kind],
        );
        const inner = self.createDiv({ cls: "tree-item-inner" });
        inner.createSpan({ cls: "docket-change-name", text: e.label });
        if (e.detail !== "") {
            inner.createSpan({ cls: "docket-change-detail", text: e.detail });
        }
        if (e.version !== null) {
            self.createDiv({ cls: "docket-row-end" }).createDiv({
                cls: "tree-item-flair",
                text: `v${e.version}`,
            });
        }
        if (file === null) return;
        self.addClass("is-clickable");
        self.onclick = () => {
            void this.plugin.app.workspace.getLeaf(false).openFile(file);
        };
    }

    /** noteAt resolves a vault path to its note, or null. */
    private noteAt(path: string): TFile | null {
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile ? file : null;
    }
}
