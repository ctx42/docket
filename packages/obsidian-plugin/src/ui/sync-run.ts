// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The Sync tab's run sections: the progress bar while a run is in flight, and
// the last run's summary, error and collapsible log, each page name in it
// linked to its note. DOM shell; the run model is run-state.ts and summary.ts,
// the render decisions panel-model.ts.

import { setIcon, TFile } from "obsidian";
import type docketPlugin from "../main.ts";
import { destOf, logLink, progressPercent } from "./panel-model.ts";
import { type LogRow, type RunState, rowName } from "./run-state.ts";
import { needsAttention, summaryParts } from "./summary.ts";

export class RunLog {
    /** logOpen is the user's choice for the run log, or null to decide per run. */
    private logOpen: boolean | null = null;
    /** The run the log-open default was last decided for. */
    private logRun: RunState | null = null;

    constructor(private readonly plugin: docketPlugin) {}

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

    /** renderLastRun draws the last run's summary, error, and collapsible log. */
    renderLastRun(root: HTMLElement): void {
        const run = this.plugin.controller.run;
        if (run === null) return;
        const done = run.phase === "done" || run.phase === "error";
        if (run !== this.logRun) {
            // A new run: the log opens by itself only when the run needs a look.
            this.logRun = run;
            this.logOpen = null;
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
        if (run.rows.length === 0) return;
        const details = section.createEl("details", { cls: "docket-log-wrap" });
        details.open = this.logOpen ?? (done && needsAttention(run));
        details.createEl("summary", { text: `Details (${run.rows.length})` });
        details.ontoggle = () => {
            this.logOpen = details.open;
        };
        const log = details.createDiv({ cls: "docket-log" });
        for (const row of run.rows) this.renderLogRow(log, row);
    }

    /** renderLogRow draws one log line, its page name linked to the note. */
    private renderLogRow(log: HTMLElement, row: LogRow): void {
        const el = log.createDiv({ cls: `docket-log-row is-${row.kind}` });
        const name = rowName(row.text, row.kind);
        const file =
            name === null
                ? null
                : this.noteAt(destOf(this.plugin.settings.syncRoot, name));
        const parts = name === null ? null : logLink(row.text, name);
        if (file === null || name === null || parts === null) {
            el.setText(row.text);
            return;
        }
        if (parts.before !== "") el.createSpan({ text: parts.before });
        const link = el.createEl("a", {
            cls: "docket-log-file",
            text: name,
            href: "#",
        });
        link.onclick = (e) => {
            e.preventDefault();
            void this.plugin.app.workspace.getLeaf(false).openFile(file);
        };
        el.createSpan({ text: parts.after });
    }

    /** noteAt resolves a vault path to its note, or null. */
    private noteAt(path: string): TFile | null {
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile ? file : null;
    }
}
