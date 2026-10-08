// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The panel's Git tab: the repository's non-ready states, the obsidian-git
// guard banner, and one commit form over a flat change list with per-file
// checkboxes. It never runs git itself — the controller does. DOM shell; the
// logic is core's `git/` modules, history.ts, and guard.ts.

import { type GitChange, KIND_TEXT, posixBase, posixDir } from "@docket/core";
import { Notice, setIcon, TFile } from "obsidian";
import type docketPlugin from "../main.ts";
import {
    autoCommits,
    findObsidianGit,
    type PluginRegistry,
    stopAutoCommit,
} from "./guard.ts";
import { firstLine } from "./history.ts";

export class GitTab {
    /** Paths the user unchecked; they stay listed and out of commits. */
    private readonly unchecked = new Set<string>();
    /** The message as the user left it; null follows the latest history entry. */
    private draft: string | null = null;
    /** The message box's selection while focused, restored after a re-render. */
    private focus: { start: number; end: number } | null = null;

    constructor(
        private readonly plugin: docketPlugin,
        private readonly rerender: () => void,
    ) {}

    /** render draws the tab into `root`. */
    render(root: HTMLElement): void {
        const git = this.plugin.git;
        const st = git.state;
        switch (st.kind) {
            case "unknown":
                this.empty(root, "loader", "Checking the repository…");
                return;
            case "unavailable":
                this.empty(
                    root,
                    "git-branch",
                    "Git needs a vault stored on disk.",
                );
                return;
            case "no-git": {
                const el = this.empty(root, "alert-triangle", "");
                const text = el.querySelector(".docket-empty-text");
                text?.createSpan({ text: "Git not found at " });
                text?.createEl("code", { text: st.path });
                const btn = el.createEl("button", { text: "Set the git path" });
                btn.onclick = () => this.plugin.openSettings();
                return;
            }
            case "no-repo": {
                const el = this.empty(
                    root,
                    "git-branch",
                    "This vault is not a git repository.",
                );
                const btn = el.createEl("button", {
                    cls: "mod-cta",
                    text: "Initialize repository",
                });
                btn.disabled = git.busy;
                btn.onclick = () => void git.initialize();
                return;
            }
            case "nested":
                this.empty(
                    root,
                    "alert-triangle",
                    "This vault sits inside a git repository rooted above it. The vault must be the repository root.",
                );
                return;
            case "error":
                this.empty(root, "alert-triangle", `git: ${st.message}`);
                return;
            case "ready":
                break;
        }
        this.renderGuard(root);
        this.renderChanges(root);
    }

    /** empty draws a centered state message and returns its container. */
    private empty(root: HTMLElement, icon: string, text: string): HTMLElement {
        const el = root.createDiv({ cls: "docket-empty" });
        setIcon(el.createDiv({ cls: "docket-empty-icon" }), icon);
        el.createDiv({ cls: "docket-empty-text", text });
        return el;
    }

    /** renderGuard warns when obsidian-git commits on its own and offers Fix. */
    private renderGuard(root: HTMLElement): void {
        const registry = (
            this.plugin.app as unknown as { plugins?: PluginRegistry }
        ).plugins;
        const og = findObsidianGit(registry);
        if (og === null || !autoCommits(og.settings)) return;
        const banner = root.createDiv({ cls: "docket-error docket-git-guard" });
        setIcon(
            banner.createSpan({ cls: "docket-error-icon" }),
            "alert-triangle",
        );
        banner.createSpan({
            cls: "docket-error-text",
            text: "obsidian-git commits this vault automatically, which mixes its commits with yours. Fix keeps its automatic push and stops its automatic commit.",
        });
        const btn = banner.createEl("button", { text: "Fix" });
        btn.onclick = () => {
            stopAutoCommit(og).then(
                () => this.rerender(),
                (err: unknown) =>
                    new Notice(
                        `docket: changing obsidian-git's settings failed: ${err instanceof Error ? err.message : String(err)}`,
                    ),
            );
        };
    }

    /** renderChanges draws the commit form and the flat change list. */
    private renderChanges(root: HTMLElement): void {
        const git = this.plugin.git;
        const section = root.createDiv({ cls: "docket-section" });
        const head = section.createDiv({ cls: "docket-section-head" });
        head.createSpan({ cls: "docket-section-title", text: "Changes" });
        const refresh = head.createDiv({
            cls: "clickable-icon docket-icon-btn",
            attr: { "aria-label": "Refresh" },
        });
        setIcon(refresh, "refresh-cw");
        refresh.onclick = () => void git.refresh();
        if (git.error !== "") {
            section.createDiv({ cls: "docket-error", text: git.error });
        }
        const changes = [...git.changes].sort((a, b) =>
            a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        );
        for (const p of [...this.unchecked]) {
            if (!changes.some((c) => c.path === p)) this.unchecked.delete(p);
        }
        if (changes.length === 0) {
            section.createDiv({ cls: "docket-muted", text: "No changes." });
            return;
        }
        const checked = changes.filter((c) => !this.unchecked.has(c.path));
        this.renderCommit(section, checked);
        this.renderList(section, changes, checked.length);
    }

    /**
     * renderCommit draws the recent-messages picker, the message box, git's
     * error from a rejected commit, and the button committing `checked`.
     */
    private renderCommit(parent: HTMLElement, checked: GitChange[]): void {
        const git = this.plugin.git;
        const history = this.plugin.commitHistory;
        if (history.length > 0) {
            const pick = parent.createEl("select", {
                cls: "dropdown docket-git-recent",
                attr: { "aria-label": "Recent commit messages" },
            });
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
                const m = history[Number(pick.value)];
                if (m === undefined) return;
                this.draft = m;
                this.focus = { start: m.length, end: m.length };
                this.rerender();
            };
        }
        const text = this.draft ?? history[0] ?? "";
        const area = parent.createEl("textarea", {
            cls: "docket-git-message",
            attr: {
                rows: String(Math.min(8, text.split("\n").length + 1)),
                placeholder: "Commit message",
                "aria-label": "Commit message",
            },
        });
        area.value = text;
        const err = git.commitError;
        if (err !== "") {
            parent.createDiv({
                cls: "docket-error docket-git-error",
                text: err,
            });
        }
        const n = checked.length;
        const btn = parent.createEl("button", {
            cls: "mod-cta docket-git-commit",
            text: n === 1 ? "Commit 1 file" : `Commit ${n} files`,
        });
        const blocked = (): boolean =>
            git.busy || n === 0 || area.value.trim() === "";
        btn.disabled = blocked();
        area.oninput = () => {
            this.draft = area.value;
            btn.disabled = blocked();
        };
        area.onfocus = () => {
            this.focus ??= { start: 0, end: 0 };
        };
        // A re-render removes the box; only a real blur forgets the focus.
        area.onblur = () => {
            if (area.isConnected) this.focus = null;
        };
        area.onselect = area.onkeyup = () => {
            this.focus = { start: area.selectionStart, end: area.selectionEnd };
        };
        if (this.focus !== null) {
            const f = this.focus;
            window.setTimeout(() => {
                area.focus();
                area.setSelectionRange(f.start, f.end);
            }, 0);
        }
        btn.onclick = () => {
            if (blocked()) return;
            void git.commit(checked, area.value.trim()).then((ok) => {
                // The next message starts from the one just committed.
                if (ok) this.draft = null;
                this.rerender();
            });
        };
    }

    /**
     * renderList draws the select-all header and one row per change; `checked`
     * counts the rows whose box is ticked.
     */
    private renderList(
        parent: HTMLElement,
        changes: GitChange[],
        checked: number,
    ): void {
        const list = parent.createDiv({ cls: "docket-git-list" });
        const head = list.createDiv({ cls: "docket-git-list-head" });
        const all = head.createEl("input", {
            type: "checkbox",
            attr: { "aria-label": "Select all" },
        });
        const full = checked === changes.length;
        all.checked = full;
        all.indeterminate = checked > 0 && !full;
        all.onchange = () => {
            // Unchecked paths stay an exception set: a file that shows up
            // later arrives checked, even after everything was unchecked.
            if (full) for (const c of changes) this.unchecked.add(c.path);
            else this.unchecked.clear();
            this.rerender();
        };
        head.createSpan({
            cls: "docket-git-count",
            text: `${checked} of ${changes.length} selected`,
        });
        for (const c of changes) this.renderFile(list, c);
    }

    /** renderFile draws one changed file with its checkbox and badges. */
    private renderFile(parent: HTMLElement, c: GitChange): void {
        const row = parent.createDiv({
            cls: `tree-item-self docket-git-file is-${c.kind}`,
        });
        const box = row.createEl("input", { type: "checkbox" });
        box.checked = !this.unchecked.has(c.path);
        box.onchange = () => {
            if (box.checked) this.unchecked.delete(c.path);
            else this.unchecked.add(c.path);
            this.rerender();
        };
        row.createSpan({
            cls: "docket-git-kind",
            text: c.kind,
            attr: { "aria-label": KIND_TEXT[c.kind] },
        });
        const name = row.createSpan({
            cls: "docket-git-name",
            text: posixBase(c.path),
        });
        const dir = posixDir(c.path);
        if (dir !== ".") {
            row.createSpan({ cls: "docket-muted docket-git-dir", text: dir });
        }
        row.setAttribute(
            "aria-label",
            c.from === "" ? c.path : `${c.from} → ${c.path}`,
        );
        row.setAttribute("data-tooltip-position", "left");
        if (c.from !== "") {
            row.createSpan({
                cls: "docket-muted docket-git-from",
                text: `from ${c.from}`,
            });
        }
        if (c.staged) {
            row.createSpan({ cls: "docket-git-badge", text: "staged" });
        }
        const file = this.plugin.app.vault.getAbstractFileByPath(c.path);
        if (file instanceof TFile) {
            name.addClass("is-clickable");
            name.onclick = () =>
                void this.plugin.app.workspace.getLeaf(false).openFile(file);
        }
    }
}
