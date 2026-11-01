// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The knowledge base cards under the Confluence card in the Sources section:
// one per git repository docket clones into the vault, with Pull (or Clone
// when its folder is missing, e.g. after an import), and one per local folder;
// each with Remove. Adding a git one opens kb-modal.ts, a local one
// folder-kb-modal.ts; then the folder is registered: a cloned folder gets an
// entry in the vault repository's ignore block, and, when asked, either kind
// goes into the doc server's `sources`. DOM glue; the logic is core and
// knowledge.ts.

import {
    addIgnoreEntry,
    type CloneInfo,
    cloneInfo,
    cloneRepo,
    type GitExec,
    ignorePattern,
    type KnowledgeBase,
    pullFastForward,
    syncFolder,
} from "@docket/core";
import { Notice, setIcon, setTooltip, TFolder } from "obsidian";
import { NodeGitExec } from "../adapters/git.ts";
import { configPath } from "../mcp/config.ts";
import { type SettingsCtx, vaultBasePath } from "./fields.ts";
import { addLocalFolder } from "./folder-kb-modal.ts";
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
    /** busy holds the names of knowledge bases with a clone or pull running. */
    private readonly busy = new Set<string>();

    constructor(private readonly ctx: SettingsCtx) {}

    /** render draws the cards into `el`. */
    render(el: HTMLElement): void {
        this.listEl = el.createDiv({ cls: "docket-kb-list" });
        this.redraw();
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
        this.save([...plugin.settings.knowledgeBases, added.kb]);
        await this.register(added.kb, added.serve);
        new Notice(`docket: cloned ${added.kb.name}`);
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
        const card = el.createDiv({ cls: "docket-card" });
        const head = card.createDiv({ cls: "docket-card-head" });
        setIcon(
            head.createDiv({ cls: "docket-kind-icon is-git" }),
            "git-branch",
        );
        const title = head.createDiv({ cls: "docket-card-title" });
        const name = title.createDiv({ cls: "docket-card-name" });
        name.createSpan({ text: kb.name });
        name.createSpan({ cls: "docket-badge is-orange", text: "Git" });
        const sub = title.createDiv({ cls: "docket-card-sub is-one-line" });
        const where = sub.createSpan({
            cls: "docket-ellipsis docket-mono",
            text: `${kb.url} · ${kb.branch === "" ? "default branch" : kb.branch}`,
        });
        setTooltip(where, kb.url);
        const state = title.createDiv({ cls: "docket-card-sub" });

        const acts = head.createDiv({ cls: "docket-card-actions" });
        const busy = this.busy.has(kb.name);
        void this.folderExists(kb.name).then((exists) => {
            if (!exists) {
                state.addClass("docket-card-warn");
                state.setText("Folder missing");
            }
            const b = acts.createEl("button", {
                text: busy ? "Working…" : exists ? "Pull" : "Clone",
            });
            b.disabled = busy;
            setTooltip(
                b,
                exists
                    ? "Fast-forward to the remote branch"
                    : `Clone into ${kb.name}/`,
            );
            b.addEventListener("click", () => {
                void (exists ? this.pull(kb) : this.clone(kb));
            });
            this.removeButton(acts, kb);
        });
    }

    /**
     * folderCard draws a local folder's card: its name, that its history is
     * the vault repository's, Create when the folder is missing, and Remove.
     */
    private folderCard(el: HTMLElement, kb: KnowledgeBase): void {
        const card = el.createDiv({ cls: "docket-card" });
        const head = card.createDiv({ cls: "docket-card-head" });
        setIcon(head.createDiv({ cls: "docket-kind-icon" }), "folder");
        const title = head.createDiv({ cls: "docket-card-title" });
        const name = title.createDiv({ cls: "docket-card-name" });
        name.createSpan({ text: kb.name });
        name.createSpan({ cls: "docket-badge", text: "Folder" });
        const sub = title.createDiv({ cls: "docket-card-sub" });
        const acts = head.createDiv({ cls: "docket-card-actions" });
        void this.folderExists(kb.name).then((exists) => {
            if (exists) {
                sub.setText("Local folder · history in the vault repository");
                void this.folderExists(`${kb.name}/.git`).then((repo) => {
                    if (!repo) return;
                    sub.addClass("docket-card-warn");
                    sub.setText(
                        "Now its own git repository: remove it and add it " +
                            "again to keep it out of the vault repository",
                    );
                });
            } else {
                sub.addClass("docket-card-warn");
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

    /** pull fast-forwards a knowledge base and says how it went. */
    private async pull(kb: KnowledgeBase): Promise<void> {
        await this.run(kb, async (exec) => {
            await pullFastForward(exec, kb.name);
            new Notice(`docket: pulled ${kb.name}`);
        });
    }

    /** clone clones a registered knowledge base whose folder is missing. */
    private async clone(kb: KnowledgeBase): Promise<void> {
        await this.run(kb, async (exec) => {
            await cloneRepo(exec, kb.url, kb.name, kb.branch);
            await this.register(kb, true);
            new Notice(`docket: cloned ${kb.name}`);
        });
    }

    /** run runs a git operation for `kb`, one at a time, reporting a failure. */
    private async run(
        kb: KnowledgeBase,
        op: (exec: GitExec) => Promise<void>,
    ): Promise<void> {
        const exec = this.exec();
        if (exec === null || this.busy.has(kb.name)) return;
        this.busy.add(kb.name);
        this.redraw();
        try {
            await op(exec);
        } catch (err) {
            new Notice(`docket: ${kb.name}: ${remoteAdvice(err)}`, 10000);
        } finally {
            this.busy.delete(kb.name);
            this.redraw();
        }
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
        const path = configPath(plugin.settings.mcpConfigPath);
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
        await app.vault.modify(file, next);
        if (plugin.mcp.host.running) await plugin.mcp.host.restart();
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
