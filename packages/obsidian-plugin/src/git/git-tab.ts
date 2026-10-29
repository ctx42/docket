// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The panel's Git tab: a Vault | Confluence switch between the vault's two
// repositories (repos.ts), each with its own state message, change list,
// unticked files, message draft, and commit form over a flat change list with
// per-file checkboxes. The Vault side adds Pull and Push with the ahead and
// behind counts, and the obsidian-git guard banner. Nothing commits on its
// own, and the tab never runs git itself — the controllers do. DOM shell; the
// logic is core's `git/` modules, repos.ts, history.ts, and guard.ts.

import { type GitChange, KIND_TEXT, posixBase, posixDir } from "@docket/core";
import { Notice, setIcon, TFile } from "obsidian";
import type docketPlugin from "../main.ts";
import type { GitController } from "./controller.ts";
import {
    autoCommits,
    findObsidianGit,
    type PluginRegistry,
    stopAutoCommit,
} from "./guard.ts";
import { firstLine, type RepoId } from "./history.ts";

/** REPO_LABEL names each repository on its sub-tab. */
const REPO_LABEL: Record<RepoId, string> = {
    vault: "Vault",
    sync: "Confluence",
};

/** Pane is one sub-tab's form state, kept across re-renders. */
interface Pane {
    /** Paths the user unchecked; they stay listed and out of commits. */
    unchecked: Set<string>;
    /** The message as the user left it; null follows the latest history entry. */
    draft: string | null;
    /** The message box's selection while focused, restored after a re-render. */
    focus: { start: number; end: number } | null;
}

export class GitTab {
    /** The sub-tab shown. */
    private repo: RepoId = "vault";
    private readonly panes: Record<RepoId, Pane> = {
        vault: { unchecked: new Set(), draft: null, focus: null },
        sync: { unchecked: new Set(), draft: null, focus: null },
    };

    constructor(
        private readonly plugin: docketPlugin,
        private readonly rerender: () => void,
    ) {}

    /** git is the controller of the sub-tab shown. */
    private get git(): GitController {
        return this.plugin.repos[this.repo];
    }

    /** pane is the form state of the sub-tab shown. */
    private get pane(): Pane {
        return this.panes[this.repo];
    }

    /** render draws the tab into `root`. */
    render(root: HTMLElement): void {
        this.renderSwitch(root);
        const git = this.git;
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
                    this.repo === "vault"
                        ? "This vault is not a git repository."
                        : "The sync folder is not a git repository.",
                );
                const btn = el.createEl("button", {
                    cls: "mod-cta",
                    text: "Initialize repository",
                });
                btn.disabled = git.busy;
                btn.onclick = () =>
                    void (this.repo === "vault"
                        ? git.initialize()
                        : this.plugin.repos.initializeSync());
                return;
            }
            case "no-folder":
                this.empty(
                    root,
                    "folder-x",
                    git.root === null
                        ? "No sync folder is set yet. Choose it in the Sync tab."
                        : `The sync folder ${git.root} does not exist.`,
                );
                return;
            case "nested":
                this.empty(
                    root,
                    "alert-triangle",
                    this.repo === "vault"
                        ? "This vault sits inside a git repository rooted above it. The vault must be the repository root."
                        : "The sync folder sits inside a git repository rooted above the vault. Initialize the vault's own repository first.",
                );
                return;
            case "error":
                this.empty(root, "alert-triangle", `git: ${st.message}`);
                return;
            case "ready":
                break;
        }
        if (this.repo === "vault") {
            this.renderGuard(root);
            this.renderRemote(root);
        }
        this.renderChanges(root);
    }

    /** renderSwitch draws the Vault | Confluence switch with change counts. */
    private renderSwitch(root: HTMLElement): void {
        const bar = root.createDiv({ cls: "docket-history-toggle" });
        for (const id of ["vault", "sync"] as const) {
            const git = this.plugin.repos[id];
            const el = bar.createDiv({
                cls: "clickable-icon docket-history-mode",
                attr: { "aria-label": `${REPO_LABEL[id]} repository` },
            });
            setIcon(el.createSpan(), id === "vault" ? "vault" : "cloud");
            el.createSpan({ text: REPO_LABEL[id] });
            const n = git.ready ? git.changes.length : 0;
            if (n > 0)
                el.createSpan({ cls: "docket-git-badge", text: String(n) });
            if (id === this.repo) el.addClass("is-active");
            el.onclick = () => {
                this.repo = id;
                this.rerender();
            };
        }
    }

    /**
     * renderRemote draws Pull and Push with the ahead and behind counts, and
     * how the last of them went wrong.
     */
    private renderRemote(root: HTMLElement): void {
        const git = this.git;
        const row = root.createDiv({ cls: "docket-git-remote" });
        const counts = git.counts;
        const pull = row.createEl("button", {
            text: counts === null ? "Pull" : `Pull (${counts.behind})`,
            attr: { "aria-label": "Pull: git pull --rebase --autostash" },
        });
        pull.disabled = git.busy;
        pull.onclick = () => void git.pull();
        const push = row.createEl("button", {
            text: counts === null ? "Push" : `Push (${counts.ahead})`,
            attr: { "aria-label": "Push: git push" },
        });
        push.disabled = git.busy;
        push.onclick = () => void git.push();
        if (counts === null) {
            row.createSpan({
                cls: "docket-muted docket-git-count",
                text: "No upstream branch",
            });
        }
        const r = git.remote;
        if (r === null) return;
        const files = "files" in r ? r.files : [];
        let text: string;
        switch (r.kind) {
            case "failed":
                text = r.message;
                break;
            case "conflict":
                text = `Pull stopped: its rebase conflicts, so nothing changed.\n${r.message}`;
                break;
            case "stash-conflict":
                text =
                    "Pulled, but your uncommitted changes conflict with it. " +
                    "They are safe in the git stash; these files hold " +
                    "conflict markers:";
                break;
        }
        const box = root.createDiv({ cls: "docket-error docket-git-error" });
        box.createDiv({ text });
        if (files.length > 0) {
            const list = box.createEl("ul");
            for (const f of files) list.createEl("li", { text: f });
        }
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
        const git = this.git;
        const unchecked = this.pane.unchecked;
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
        for (const p of [...unchecked]) {
            if (!changes.some((c) => c.path === p)) unchecked.delete(p);
        }
        if (changes.length === 0) {
            section.createDiv({ cls: "docket-muted", text: "No changes." });
            return;
        }
        const checked = changes.filter((c) => !unchecked.has(c.path));
        this.renderCommit(section, checked);
        this.renderList(section, changes, checked.length);
    }

    /**
     * renderCommit draws the recent-messages picker, the message box, git's
     * error from a rejected commit, and the button committing `checked`.
     */
    private renderCommit(parent: HTMLElement, checked: GitChange[]): void {
        const git = this.git;
        const pane = this.pane;
        const history = this.plugin.commitHistory[this.repo];
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
                pane.draft = m;
                pane.focus = { start: m.length, end: m.length };
                this.rerender();
            };
        }
        const text = pane.draft ?? history[0] ?? "";
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
            pane.draft = area.value;
            btn.disabled = blocked();
        };
        area.onfocus = () => {
            pane.focus ??= { start: 0, end: 0 };
        };
        // A re-render removes the box; only a real blur forgets the focus.
        area.onblur = () => {
            if (area.isConnected) pane.focus = null;
        };
        area.onselect = area.onkeyup = () => {
            pane.focus = { start: area.selectionStart, end: area.selectionEnd };
        };
        if (pane.focus !== null) {
            const f = pane.focus;
            window.setTimeout(() => {
                area.focus();
                area.setSelectionRange(f.start, f.end);
            }, 0);
        }
        btn.onclick = () => {
            if (blocked()) return;
            void git.commit(checked, area.value.trim()).then((ok) => {
                // The next message starts from the one just committed.
                if (ok) pane.draft = null;
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
        const unchecked = this.pane.unchecked;
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
            if (full) for (const c of changes) unchecked.add(c.path);
            else unchecked.clear();
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
        const unchecked = this.pane.unchecked;
        const box = row.createEl("input", { type: "checkbox" });
        box.checked = !unchecked.has(c.path);
        box.onchange = () => {
            if (box.checked) unchecked.delete(c.path);
            else unchecked.add(c.path);
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
        // The folder within the repository: the sync folder's name is implied.
        const dir = posixDir(this.inRepo(c.path));
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
                text: `from ${this.inRepo(c.from)}`,
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

    /** inRepo is a vault path relative to the shown repository's root. */
    private inRepo(path: string): string {
        const root = this.git.root ?? "";
        return root === "" ? path : path.slice(root.length + 1);
    }
}
