// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The panel's History tab: a Note | Vault toggle over read-only commit rows,
// `DD/MM/YY HH:MM: <subject>` each, newest first, a page at a time. Note
// follows the active note across renames — committed ones through
// `git log --follow`, and a move not yet committed through the change list's
// rename. In Note mode, clicking a row compares the note's change bars against
// that commit, and clicking it again ends that (history-pick.ts). DOM shell
// over the controller's `log`.

import { type LogEntry, logLine } from "@docket/core";
import { setIcon } from "obsidian";
import type docketPlugin from "../main.ts";
import { isPicked, nextPick, pickBlock } from "./history-pick.ts";

/** PAGE_SIZE is how many commits one load (and each Load more) adds. */
export const PAGE_SIZE = 100;

/** HistoryMode is whose history the tab shows. */
export type HistoryMode = "note" | "vault";

export class HistoryTab {
    private mode: HistoryMode = "note";
    private rows: LogEntry[] = [];
    private more = false;
    private loading = false;
    private error = "";
    /** The query the rows belong to; a different one reloads. */
    private loadedFor: string | null = null;
    /** Bumped on every load so a stale answer is dropped. */
    private seq = 0;

    constructor(
        private readonly plugin: docketPlugin,
        private readonly rerender: () => void,
    ) {}

    /** invalidate drops the loaded rows (HEAD moved) so the next render reloads. */
    invalidate(): void {
        this.loadedFor = null;
    }

    /** render draws the tab into `root`, loading the rows it needs. */
    render(root: HTMLElement): void {
        if (!this.plugin.git.ready) {
            root.createDiv({
                cls: "docket-muted",
                text: "History needs the vault to be a git repository; see the Git tab.",
            });
            return;
        }
        this.renderToggle(root);
        const path = this.path();
        if (this.mode === "note" && path === null) {
            root.createDiv({
                cls: "docket-muted",
                text: "Open a note to see its history.",
            });
            return;
        }
        const key = `${this.mode}:${path ?? ""}`;
        if (key !== this.loadedFor) this.load(key, path, false);
        const list = root.createDiv({ cls: "docket-history" });
        if (this.error !== "") {
            list.createDiv({ cls: "docket-error", text: this.error });
        }
        const note = this.note();
        const block =
            note === null ? null : pickBlock(this.plugin.diffSigns, note);
        const bars = this.plugin.barBase;
        for (const e of this.rows) {
            const row = list.createDiv({
                cls: "docket-history-row",
                text: logLine(e),
                attr: { "aria-label": block ?? e.hash.slice(0, 10) },
            });
            if (note === null || path === null) continue;
            if (block !== null) {
                row.addClass("is-blocked");
                continue;
            }
            row.addClass("is-pickable");
            row.toggleClass("is-selected", isPicked(bars.commit, note, e));
            row.onclick = () => {
                // A drag that selected the row's text is not a pick.
                if (window.getSelection()?.toString() !== "") return;
                bars.pick(nextPick(bars.commit, note, path, e));
            };
        }
        if (this.loading) {
            list.createDiv({ cls: "docket-muted", text: "Loading…" });
        } else if (this.rows.length === 0 && this.error === "") {
            list.createDiv({ cls: "docket-muted", text: "No commits yet." });
        }
        if (this.more && !this.loading) {
            const btn = list.createEl("button", { text: "Load more" });
            btn.onclick = () => this.load(key, path, true);
        }
    }

    /** renderToggle draws the Note | Vault switch. */
    private renderToggle(root: HTMLElement): void {
        const bar = root.createDiv({ cls: "docket-history-toggle" });
        const item = (mode: HistoryMode, label: string, icon: string): void => {
            const el = bar.createDiv({
                cls: "clickable-icon docket-history-mode",
                attr: { "aria-label": `${label} history` },
            });
            setIcon(el.createSpan(), icon);
            el.createSpan({ text: label });
            if (mode === this.mode) el.addClass("is-active");
            el.onclick = () => {
                this.mode = mode;
                this.rerender();
            };
        };
        item("note", "Note", "file-text");
        item("vault", "Vault", "vault");
    }

    /** note is the active note's path in Note mode, else null. */
    private note(): string | null {
        if (this.mode === "vault") return null;
        return this.plugin.app.workspace.getActiveFile()?.path ?? null;
    }

    /**
     * path is the history path for Note mode: the active note's, or for a move
     * not yet committed, its old path (whose history `--follow` continues).
     */
    private path(): string | null {
        if (this.mode === "vault") return null;
        const f = this.plugin.app.workspace.getActiveFile();
        if (f === null) return null;
        const moved = this.plugin.git.changes.find(
            (c) => c.path === f.path && c.from !== "",
        );
        return moved?.from ?? f.path;
    }

    /** load fetches the first page for `key`, or the next one with `append`. */
    private load(key: string, path: string | null, append: boolean): void {
        const seq = ++this.seq;
        this.loadedFor = key;
        this.loading = true;
        this.error = "";
        if (!append) this.rows = [];
        const skip = this.rows.length;
        const q =
            path === null
                ? { skip, limit: PAGE_SIZE + 1 }
                : { path, skip, limit: PAGE_SIZE + 1 };
        this.plugin.git.log(q).then(
            (rows) => {
                if (seq !== this.seq) return;
                this.more = rows.length > PAGE_SIZE;
                this.rows = [...this.rows, ...rows.slice(0, PAGE_SIZE)];
                this.loading = false;
                this.rerender();
            },
            (err: unknown) => {
                if (seq !== this.seq) return;
                this.error = err instanceof Error ? err.message : String(err);
                this.loading = false;
                this.rerender();
            },
        );
        if (append) this.rerender();
    }
}
