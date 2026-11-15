// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The knowledge base cards under the Confluence card in the Sources section.
// A git one shows its state as the plugin's KbWatch sees it (design 06):
// clone progress, the role (own, protected, read with its pin), what to push
// and pull, what a pinned update would change, conflicts, offline; and the
// buttons for it (kb-card.ts decides which). A local folder's card says its
// history is the vault repository's. Each card has Remove. Adding a git one
// opens kb-modal.ts and its card clones it; a local one folder-kb-modal.ts.
// Then the folder is registered: a cloned folder gets an entry in the vault
// repository's ignore block, and, when asked, either kind goes into the doc
// server's `sources`. DOM glue; the logic is core, kb-watch.ts, kb-card.ts,
// and knowledge.ts.

import {
    addIgnoreEntry,
    type CloneInfo,
    cloneInfo,
    type GitExec,
    ignorePattern,
    type KnowledgeBase,
    syncFolder,
} from "@docket/core";
import { Notice, setIcon, setTooltip, TFolder } from "obsidian";
import { NodeGitExec } from "../adapters/git.ts";
import { type ActionId, type KbStatus, kbCardView } from "../git/kb-card.ts";
import { DEFAULT_CONFIG_PATH } from "../mcp/config.ts";
import { type SettingsCtx, vaultBasePath } from "./fields.ts";
import { addLocalFolder } from "./folder-kb-modal.ts";
import { runKbAction } from "./kb-actions.ts";
import { addKnowledgeBase } from "./kb-modal.ts";
import {
    addSource,
    localFolderChoices,
    remoteAdvice,
    takenNames,
} from "./knowledge.ts";

/** NO_CLONE stands for a repository whose clone docket cannot read. */
const NO_CLONE: CloneInfo = { url: "", branch: "" };

/** KnowledgeSection draws and manages the knowledge base cards. */
export class KnowledgeSection {
    private listEl: HTMLElement | null = null;
    /** serve holds, per new git knowledge base, whether its clone joins `sources`. */
    private readonly serve = new Map<string, boolean>();

    constructor(private readonly ctx: SettingsCtx) {}

    /** render draws the cards into `el`. */
    render(el: HTMLElement): void {
        const list = el.createDiv({ cls: "docket-kb-list" });
        this.listEl = list;
        const watch = this.ctx.plugin.kbWatch;
        // The cards follow the watch until the settings tab drops them.
        const stop = watch.subscribe(() => {
            if (!list.isConnected) {
                stop();
                return;
            }
            this.redraw();
        });
        this.redraw();
        void watch.checkAll();
    }

    /**
     * addLocal opens the local folder dialog, creates the folder when it is
     * new, and saves and registers it.
     */
    async addLocal(): Promise<void> {
        const { app, plugin } = this.ctx;
        const s = plugin.settings;
        const top = app.vault.getRoot().children;
        const folders = top
            .filter((f) => f instanceof TFolder)
            .map((f) => f.name);
        const files = new Set(
            top.filter((f) => !(f instanceof TFolder)).map((f) => f.name),
        );
        const choices = localFolderChoices(folders, s);
        const added = await addLocalFolder(
            app,
            choices,
            await this.clones(choices),
            files,
            s.knowledgeBases,
            syncFolder(s.syncRoot),
        );
        if (added === null) return;
        try {
            if (!(await this.folderExists(added.kb.name))) {
                await app.vault.createFolder(added.kb.name);
            }
        } catch (err) {
            new Notice(
                `docket: could not create ${added.kb.name}: ${remoteAdvice(err)}`,
            );
            return;
        }
        this.save([...plugin.settings.knowledgeBases, added.kb]);
        await this.register(added.kb, added.serve);
        new Notice(
            added.kb.kind === "git"
                ? `docket: added ${added.kb.name} as a git knowledge base`
                : `docket: added ${added.kb.name}`,
        );
    }

    /**
     * clones reads what each folder in `names` that is its own git repository
     * says about its clone. A repository git cannot read counts as one without
     * a remote, so the dialog refuses it rather than adding it as a folder.
     */
    private async clones(
        names: readonly string[],
    ): Promise<Map<string, CloneInfo>> {
        const out = new Map<string, CloneInfo>();
        const exec = this.exec();
        for (const name of names) {
            if (!(await this.folderExists(`${name}/.git`))) continue;
            try {
                out.set(
                    name,
                    exec === null ? NO_CLONE : await cloneInfo(exec, name),
                );
            } catch {
                out.set(name, NO_CLONE);
            }
        }
        return out;
    }

    /** addGit opens the git dialog and saves and registers the cloned knowledge base. */
    async addGit(): Promise<void> {
        const { app, plugin } = this.ctx;
        const exec = this.exec();
        if (exec === null) {
            new Notice("docket: knowledge bases need the desktop app.");
            return;
        }
        const s = plugin.settings;
        const top = app.vault.getRoot().children.map((f) => f.name);
        const added = await addKnowledgeBase(
            app,
            exec,
            s.knowledgeBases,
            syncFolder(s.syncRoot),
            takenNames(s, top),
        );
        if (added === null) return;
        this.serve.set(added.kb.name, added.serve);
        this.save([...plugin.settings.knowledgeBases, added.kb]);
        await this.clone(added.kb);
    }

    /** redraw draws one card per knowledge base. */
    redraw(): void {
        const el = this.listEl;
        if (el === null) return;
        el.empty();
        for (const kb of this.ctx.plugin.settings.knowledgeBases) {
            this.card(el, kb);
        }
    }

    /** card draws one knowledge base's card. */
    private card(el: HTMLElement, kb: KnowledgeBase): void {
        if (kb.kind === "folder") {
            this.folderCard(el, kb);
            return;
        }
        const s = this.ctx.plugin.kbWatch.status(kb.name);
        if (s !== undefined) this.gitCard(el, kb, s);
    }

    /** gitCard draws a git knowledge base's card from its status. */
    private gitCard(el: HTMLElement, kb: KnowledgeBase, s: KbStatus): void {
        const v = kbCardView(s);
        const card = el.createDiv({ cls: "docket-source" });
        const head = card.createDiv({ cls: "docket-source-head" });
        setIcon(
            head.createDiv({ cls: "docket-source-icon is-git" }),
            "git-branch",
        );
        const title = head.createDiv({ cls: "docket-source-title" });
        const name = title.createDiv({ cls: "docket-source-name" });
        name.createSpan({ text: kb.name });
        name.createSpan({ cls: "docket-badge is-orange", text: "Git" });
        for (const p of v.pills) {
            const pill = name.createSpan({
                cls: `docket-badge docket-kb-pill is-${p.tone}`,
            });
            setIcon(pill.createSpan({ cls: "docket-kb-pill-icon" }), p.icon);
            pill.createSpan({ text: p.text });
        }
        const sub = title.createDiv({ cls: "docket-source-sub is-one-line" });
        const where = sub.createSpan({
            cls: "docket-ellipsis docket-mono",
            text: kb.url,
        });
        setTooltip(where, kb.url);
        const state = title.createDiv({ cls: "docket-source-sub" });
        state.setText(v.line);
        if (v.warn) state.addClass("docket-source-warn");
        if (v.progress !== null) {
            const bar = title.createDiv({ cls: "docket-kb-progress" });
            bar.createDiv().style.width = `${v.progress}%`;
        }
        const acts = head.createDiv({ cls: "docket-source-actions" });
        for (const a of v.actions) {
            const b = acts.createEl("button", {
                cls: a.main ? "mod-cta" : "",
            });
            setIcon(b.createSpan({ cls: "docket-kb-btn-icon" }), a.icon);
            b.createSpan({ text: a.label });
            b.disabled = a.disabled;
            b.addEventListener("click", () => void this.act(kb, a.id));
        }
        if (s.clone.kind !== "running") this.removeButton(acts, kb);
        if (v.update !== null) {
            const u = v.update;
            const row = card.createDiv({ cls: "docket-kb-update-row" });
            row.createSpan({ cls: "docket-muted", text: "If you update:" });
            row.createSpan({
                cls: "docket-kb-changed",
                text: `~ ${u.changed.length} changed`,
            });
            row.createSpan({
                cls: "docket-kb-added",
                text: `+ ${u.added.length} added`,
            });
            row.createSpan({
                cls: "docket-kb-removed",
                text: `− ${u.removed.length} removed`,
            });
            const names = [...u.changed, ...u.added, ...u.removed];
            row.createSpan({
                cls: "docket-muted docket-ellipsis",
                text: `· ${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""}`,
            });
        }
    }

    /** act runs a card button's action for the knowledge base `kb`. */
    private async act(kb: KnowledgeBase, id: ActionId): Promise<void> {
        if (id === "clone") {
            await this.clone(kb);
            return;
        }
        await runKbAction(this.ctx.app, this.ctx.plugin, kb.name, id);
    }

    /**
     * clone clones the knowledge base `kb` in its card and, once it is
     * there, registers it.
     */
    private async clone(kb: KnowledgeBase): Promise<void> {
        if (!(await this.ctx.plugin.kbWatch.clone(kb.name))) return;
        await this.register(kb, this.serve.get(kb.name) ?? true);
        this.serve.delete(kb.name);
        new Notice(`docket: cloned ${kb.name}`);
        await this.ctx.plugin.kbWatch.check(kb.name);
    }

    /**
     * folderCard draws a local folder's card: its name, that its history is
     * the vault repository's, Create when the folder is missing, and Remove.
     */
    private folderCard(el: HTMLElement, kb: KnowledgeBase): void {
        const card = el.createDiv({ cls: "docket-source" });
        const head = card.createDiv({ cls: "docket-source-head" });
        setIcon(head.createDiv({ cls: "docket-source-icon" }), "folder");
        const title = head.createDiv({ cls: "docket-source-title" });
        const name = title.createDiv({ cls: "docket-source-name" });
        name.createSpan({ text: kb.name });
        name.createSpan({ cls: "docket-badge", text: "Folder" });
        const sub = title.createDiv({ cls: "docket-source-sub" });
        const acts = head.createDiv({ cls: "docket-source-actions" });
        void this.folderExists(kb.name).then((exists) => {
            if (exists) {
                sub.setText("Local folder · history in the vault repository");
                void this.folderExists(`${kb.name}/.git`).then((repo) => {
                    if (!repo) return;
                    sub.addClass("docket-source-warn");
                    sub.setText(
                        "Now its own git repository: remove it and add it " +
                            "again to keep it out of the vault repository",
                    );
                });
            } else {
                sub.addClass("docket-source-warn");
                sub.setText("Folder missing");
                const b = acts.createEl("button", { text: "Create" });
                setTooltip(b, `Create ${kb.name}/ in the vault`);
                b.addEventListener("click", () => void this.create(kb));
            }
            this.removeButton(acts, kb);
        });
    }

    /** removeButton appends the Remove button for `kb` to `acts`. */
    private removeButton(acts: HTMLElement, kb: KnowledgeBase): void {
        const remove = acts.createEl("button", { cls: "clickable-icon" });
        setIcon(remove, "trash-2");
        setTooltip(remove, "Stop tracking (the folder stays in the vault)");
        remove.addEventListener("click", () => this.remove(kb));
    }

    /** create makes a registered local folder that is missing, and registers it. */
    private async create(kb: KnowledgeBase): Promise<void> {
        try {
            await this.ctx.app.vault.createFolder(kb.name);
        } catch (err) {
            new Notice(
                `docket: could not create ${kb.name}: ${remoteAdvice(err)}`,
            );
            return;
        }
        await this.register(kb, true);
        this.redraw();
    }

    /** remove stops tracking a knowledge base; its folder stays. */
    private remove(kb: KnowledgeBase): void {
        this.save(
            this.ctx.plugin.settings.knowledgeBases.filter((k) => k !== kb),
        );
        new Notice(
            `docket: stopped tracking ${kb.name}. Its folder and its entry ` +
                "in project-config.md stay; remove them by hand if you like.",
        );
    }

    /**
     * register keeps a git knowledge base's folder out of the vault
     * repository and untracks anything the vault already tracks there, such
     * as a committed pointer to the inner repository; a local folder stays in
     * the vault repository. When `serve` is set, it adds the folder to the doc
     * server's `sources` and restarts a running server so it picks it up.
     */
    private async register(kb: KnowledgeBase, serve: boolean): Promise<void> {
        const { app, plugin } = this.ctx;
        const vault = plugin.repos.vault;
        if (kb.kind === "git" && vault.ready) {
            const tracked = await vault.trackedUnder(kb.name);
            await vault.ignore(
                (text) =>
                    addIgnoreEntry(
                        text,
                        ignorePattern(kb.name, true),
                        vault.ignores,
                    ),
                tracked.length > 0 ? kb.name : "",
            );
        }
        if (!serve) return;
        const path = DEFAULT_CONFIG_PATH;
        const file = app.vault.getFileByPath(path);
        if (file === null) {
            new Notice(
                `docket: no ${path} found; add ${kb.name} to its sources by hand.`,
            );
            return;
        }
        // Edit only the `sources` lines: a front matter rewrite would drop
        // comments and reformat the keys other tools write.
        let next: string | undefined;
        try {
            next = addSource(await app.vault.read(file), kb.name);
        } catch (err) {
            new Notice(
                `docket: ${(err as Error).message}; add ${kb.name} to its sources by hand.`,
            );
            return;
        }
        if (next === undefined) return;
        // The controller restarts a running server on this edit.
        await app.vault.modify(file, next);
    }

    /** save stores the knowledge base list and redraws the cards. */
    private save(next: KnowledgeBase[]): void {
        this.ctx.plugin.settings = {
            ...this.ctx.plugin.settings,
            knowledgeBases: next,
        };
        this.ctx.persist();
        this.ctx.flush();
        this.redraw();
    }

    /** folderExists reports whether the vault has a folder or file at `name`. */
    private folderExists(name: string): Promise<boolean> {
        return this.ctx.app.vault.adapter.exists(name);
    }

    /** exec runs git at the vault root, or is null without a disk path (mobile). */
    private exec(): GitExec | null {
        const base = vaultBasePath(this.ctx.app);
        if (base === "") return null;
        return new NodeGitExec(() => this.ctx.plugin.gitPath, base);
    }
}
