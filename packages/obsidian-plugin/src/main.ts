// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { hostname } from "node:os";
import {
    PACKAGE_NAME,
    type PreflightEntry,
    posixJoin,
    syncFolder,
    threadOf,
} from "@docket/core";
import {
    addIcon,
    FileSystemAdapter,
    type Menu,
    Notice,
    Plugin,
    setIcon,
    type TAbstractFile,
    TFile,
    TFolder,
} from "obsidian";
import { NodeGitExec } from "./adapters/git.ts";
import { loadDeviceToken, writePointer, writeToken } from "./device-state.ts";
import { CommitHistory, HISTORY_CAP, type RepoId } from "./git/history.ts";
import { addIgnoreItem } from "./git/ignore-menu.ts";
import { KbWatch } from "./git/kb-watch.ts";
import { openRepos } from "./git/open-repos.ts";
import { gitKbNames } from "./git/repos.ts";
import { SignsFeature } from "./git/signs/feature.ts";
import { ICON_ID, ICON_SVG } from "./icon.ts";
import { applyTerminalIcon, type LeanRegistry } from "./lean-terminal.ts";
import { legacyConfigPath } from "./mcp/config.ts";
import { McpController } from "./mcp/controller.ts";
import {
    commandApplies,
    type McpCommand,
    barText as mcpBarText,
    barTip as mcpBarTip,
    shown as mcpShown,
} from "./mcp/status.ts";
import { indentViewPlugin } from "./render/indent-livepreview.ts";
import { indentPostProcessor } from "./render/indent-reading.ts";
import {
    type ReplyHost,
    replyButtonsPlugin,
    replyButtonsPostProcessor,
} from "./render/reply-button.ts";
import { buildRuntime, resolveCacheRoot } from "./runtime.ts";
import { vaultBasePath } from "./settings/fields.ts";
import { DEFAULT_SETTINGS, type docketSettings } from "./settings/model.ts";
import {
    loadCommitHistory,
    loadDiffSigns,
    loadGitPath,
    loadHideProps,
    loadHistoryCap,
    loadKbRoles,
    loadMcpEnabled,
    loadSettings,
    loadTerminalIconSet,
    loadToken,
    saveCommitHistory,
    saveDiffSigns,
    saveGitPath,
    saveHideProps,
    saveHistoryCap,
    saveKbRoles,
    saveMcpEnabled,
    saveSettings,
    saveTerminalIconSet,
    saveToken,
} from "./settings/store.ts";
import { docketSettingTab } from "./settings/tab.ts";
import { BarBaseFeature } from "./ui/bar-base-feature.ts";
import { SyncController } from "./ui/controller.ts";
import {
    addFilesItems,
    addFolderItems,
    addNoteItems,
    addReplyItem,
    copyLink,
    frontmatter,
    openInConfluence,
    runNoteAction,
} from "./ui/menus.ts";
import {
    canPublish,
    canReply,
    type NoteAction,
    noteActions,
    noteLink,
    replyTarget,
} from "./ui/note-actions.ts";
import { pagePreflight, toDest } from "./ui/operations.ts";
import { barText, statusCounts } from "./ui/summary.ts";
import { docketView, VIEW_TYPE } from "./ui/view.ts";

/** HIDE_PROPS_CLASS on the body hides the `docket_*` properties (styles.css). */
const HIDE_PROPS_CLASS = "docket-hide-props";

/** AppSettings is the undocumented settings-modal API used to open our tab. */
interface AppSettings {
    open(): void;
    openTabById(id: string): void;
}

/**
 * docketPlugin is the Obsidian plugin entry point. It loads the shareable
 * settings (`data.json`) and the per-device API token (a file in the out-of-vault
 * cache home, migrated from localStorage) on start, records this device's pointer
 * to that cache home for the CLI, registers the settings tab, and keeps settings
 * and token in memory for the settings UI and the pull/push commands to read. The
 * indent renderers register as before.
 */
export default class docketPlugin extends Plugin {
    override settings: docketSettings = { ...DEFAULT_SETTINGS };
    readonly controller = new SyncController(this.app, this);
    token = "";
    /** The out-of-vault cache home, or `""` when the vault has no disk path. */
    cacheRoot = "";
    /** Whether this device hides the `docket_*` properties (see setHideProps). */
    hideProps = true;
    /** This device's git binary path; `""` means whatever PATH finds. */
    gitPath = "";
    /** Whether this device shows the editor change bars (see setDiffSigns). */
    diffSigns = true;
    /** This device's committed messages per repository, most recent first. */
    readonly commitHistory = new CommitHistory(
        (repo) => loadCommitHistory(this, repo),
        (repo, list) => saveCommitHistory(this, repo, list),
        HISTORY_CAP,
    );
    /** How many commit messages this device keeps (see setHistoryCap). */
    historyCap = HISTORY_CAP;
    /** Whether this device runs the MCP doc server (see setMcpEnabled). */
    mcpEnabled = false;
    /** The MCP doc server this device runs. */
    readonly mcp = new McpController(this);

    /**
     * pagePreflight classifies vault notes against Confluence for the doc
     * server's page_status tool; it throws when the plugin is not connected.
     */
    pagePreflight(dests: string[]): Promise<PreflightEntry[]> {
        const rt = buildRuntime(this.app, this.settings, this.token);
        return pagePreflight(rt, dests);
    }
    /** The vault and sync repositories: change lists, commits, history. */
    readonly repos = openRepos(this.app, {
        gitPath: () => this.gitPath,
        syncFolder: () => syncFolder(this.settings.syncRoot),
        record: (repo, m) => this.recordCommitMessage(repo, m),
    });
    /** The git knowledge bases' roles, pins, and checks behind their cards. */
    readonly kbWatch = new KbWatch({
        exec: new NodeGitExec(
            () => this.gitPath,
            vaultBasePath(this.app) || ".",
        ),
        repos: this.repos,
        knowledgeBases: () => this.settings.knowledgeBases,
        setPin: (name, pin) => this.setKbPin(name, pin),
        folderExists: (path) => this.app.vault.adapter.exists(path),
        loadRoles: () => loadKbRoles(this),
        saveRoles: (roles) => saveKbRoles(this, roles),
        openUrl: (url) => {
            window.open(url);
        },
        now: () => Date.now(),
        today: () => new Date(),
    });
    /** What the change bars compare against: HEAD, Confluence, or a commit. */
    readonly barBase = new BarBaseFeature(this);
    private readonly signs = new SignsFeature(this, this.repos, (path, doc) =>
        this.barBase.base(path, doc),
    );

    override async onload(): Promise<void> {
        const legacy = legacyConfigPath(await this.loadData());
        this.settings = await loadSettings(this);
        if (legacy !== undefined) {
            // The config is always the vault root's now: say so once, then
            // save, which drops the old setting.
            new Notice(
                `docket: the MCP server now reads project-config.md at the vault root; move ${legacy} there.`,
                0,
            );
            await saveSettings(this, this.settings);
        }
        this.cacheRoot = resolveCacheRoot(this.app);
        this.token = await this.loadToken();
        void this.recordPointer();
        this.setHideProps(loadHideProps(this), false);
        this.gitPath = loadGitPath(this);
        this.diffSigns = loadDiffSigns(this);
        this.historyCap = loadHistoryCap(this);
        this.commitHistory.setCap(this.historyCap);
        // The first refresh comes with the layout (watchGit).
        this.repos.setKnowledgeBases(gitKbNames(this.settings.knowledgeBases));
        this.mcpEnabled = loadMcpEnabled(this);

        this.addSettingTab(new docketSettingTab(this.app, this));
        this.registerEditorExtension(indentViewPlugin);
        this.registerMarkdownPostProcessor(indentPostProcessor);
        const replies = this.replyHost();
        this.registerEditorExtension(replyButtonsPlugin(replies));
        this.registerMarkdownPostProcessor(
            replyButtonsPostProcessor(this.app.vault, replies),
        );
        this.signs.load(this.diffSigns);
        this.barBase.load(() => this.signs.refreshAll());
        this.watchGit();
        this.mcp.load();

        addIcon(ICON_ID, ICON_SVG);
        this.registerView(VIEW_TYPE, (leaf) => new docketView(leaf, this));

        this.addRibbonIcon(ICON_ID, "Open docket", () => {
            void this.activateView();
        });
        this.addStatusBar();
        this.addMcpStatusBar();
        this.addCommands();
        this.addMcpCommands();

        const ws = this.app.workspace;
        this.registerEvent(
            ws.on("file-menu", (menu, file) => this.fileMenu(menu, file)),
        );
        this.registerEvent(
            ws.on("files-menu", (menu, files) =>
                addFilesItems(menu, this, files),
            ),
        );
        this.registerEvent(
            ws.on("editor-menu", (menu, editor, info) => {
                if (info.file === null) return;
                addReplyItem(menu, this, editor, info.file);
                addNoteItems(menu, this, info.file);
            }),
        );

        ws.onLayoutReady(() => void this.setTerminalIcon());

        console.log(`docket: loaded (core=${PACKAGE_NAME})`);
    }

    override onunload(): void {
        this.mcp.unload();
        this.repos.dispose();
        document.body.removeClass(HIDE_PROPS_CLASS);
        console.log("docket: unloaded");
    }

    /** leanRegistry is Obsidian's undocumented plugin registry. */
    get leanRegistry(): LeanRegistry | undefined {
        return (this.app as unknown as { plugins?: LeanRegistry }).plugins;
    }

    /** setTerminalIcon sets Lean Terminal's icon once on this device. */
    private async setTerminalIcon(): Promise<void> {
        if (loadTerminalIconSet(this)) return;
        if (await applyTerminalIcon(this.leanRegistry)) {
            saveTerminalIconSet(this);
        }
    }

    /** persistSettings writes the current shareable settings to `data.json`. */
    async persistSettings(): Promise<void> {
        await saveSettings(this, this.settings);
        this.applyKnowledgeBases();
        this.controller.touch();
    }

    /** setKbPin pins the knowledge base `name` to `pin` and saves the settings. */
    private async setKbPin(name: string, pin: string): Promise<void> {
        this.settings = {
            ...this.settings,
            knowledgeBases: this.settings.knowledgeBases.map((kb) =>
                kb.name === name ? { ...kb, pin } : kb,
            ),
        };
        await this.persistSettings();
    }

    /**
     * applyKnowledgeBases gives every git knowledge base in the settings its
     * repository and reads the new ones.
     */
    private applyKnowledgeBases(): void {
        const added = this.repos.setKnowledgeBases(
            gitKbNames(this.settings.knowledgeBases),
        );
        for (const git of added) void git.refresh();
    }

    /**
     * persistToken writes the current API token to the per-device token file in
     * the cache home (localStorage when the vault has no disk path). A failed
     * write is reported as a notice.
     */
    persistToken(): void {
        this.controller.touch();
        if (this.cacheRoot === "") {
            saveToken(this, this.token);
            return;
        }
        writeToken(this.cacheRoot, this.token).catch((err: unknown) => {
            console.error("docket: saving the API token failed", err);
            new Notice("docket: saving the API token failed; see the console.");
        });
    }

    /** loadToken reads the API token, migrating one left in localStorage. */
    private loadToken(): Promise<string> {
        if (this.cacheRoot === "") {
            return Promise.resolve(loadToken(this));
        }
        return loadDeviceToken(this.cacheRoot, {
            load: () => loadToken(this),
            clear: () => saveToken(this, ""),
        });
    }

    /**
     * recordPointer writes this device's pointer to the cache home into the plugin
     * folder, so a CLI run inside the vault shares the plugin's cache and token.
     * Best effort: a failure is logged, and the CLI then refuses to run here.
     */
    private async recordPointer(): Promise<void> {
        const adapter = this.app.vault.adapter;
        if (this.cacheRoot === "" || !(adapter instanceof FileSystemAdapter)) {
            return;
        }
        const vaultPath = adapter.getBasePath();
        const dir =
            this.manifest.dir ??
            `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
        try {
            await writePointer(
                posixJoin(vaultPath.replace(/\\/g, "/"), dir),
                hostname(),
                vaultPath,
                this.cacheRoot,
            );
        } catch (err) {
            console.error("docket: writing the device pointer failed", err);
        }
    }

    /**
     * setHideProps shows or hides the `docket_*` properties in every note's
     * Properties view (a body class the stylesheet keys off), saving the choice
     * for this device unless `save` is false.
     */
    setHideProps(hide: boolean, save = true): void {
        this.hideProps = hide;
        document.body.toggleClass(HIDE_PROPS_CLASS, hide);
        if (save) saveHideProps(this, hide);
    }

    /**
     * setGitPath changes this device's git binary path; the next git command
     * uses it, and both repositories' states are re-read now.
     */
    setGitPath(path: string): void {
        this.gitPath = path.trim();
        saveGitPath(this, this.gitPath);
        void this.repos.refresh();
    }

    /** recordCommitMessage puts a message first in `repo`'s history. */
    recordCommitMessage(repo: RepoId, message: string): void {
        this.commitHistory.record(repo, message);
    }

    /**
     * setHistoryCap changes how many commit messages this device keeps,
     * trimming the stored history at once; 0 turns the history off.
     */
    setHistoryCap(cap: number): void {
        this.historyCap = cap;
        saveHistoryCap(this, cap);
        this.commitHistory.setCap(cap);
    }

    /** setMcpEnabled switches the MCP doc server on or off on this device. */
    setMcpEnabled(on: boolean): void {
        this.mcpEnabled = on;
        saveMcpEnabled(this, on);
        void this.mcp.setEnabled(on);
    }

    /**
     * setDiffSigns shows or hides the editor change bars on this device; hiding
     * them drops a commit picked in History.
     */
    setDiffSigns(on: boolean): void {
        this.diffSigns = on;
        saveDiffSigns(this, on);
        this.signs.setEnabled(on);
        if (!on) this.barBase.pick(null);
        this.controller.touch();
    }

    /**
     * watchGit wires the change lists' refresh triggers: vault events (once the
     * vault has loaded, debounced by the controller owning the path) and a sync
     * run finishing, which refreshes the sync repository — pull and push never
     * commit, so their file changes simply show up there.
     */
    private watchGit(): void {
        this.app.workspace.onLayoutReady(() => {
            const vault = this.app.vault;
            const changed = (file: TAbstractFile) =>
                this.repos.forPath(file.path).changed();
            this.registerEvent(vault.on("modify", changed));
            this.registerEvent(vault.on("create", changed));
            this.registerEvent(vault.on("delete", changed));
            this.registerEvent(
                vault.on("rename", (file, old) => {
                    changed(file);
                    this.repos.forPath(old).changed();
                }),
            );
            void this.repos.refresh();
        });
        let busy = this.controller.busy;
        this.register(
            this.controller.subscribe(() => {
                const was = busy;
                busy = this.controller.busy;
                if (was && !busy) void this.repos.sync.refresh();
            }),
        );
    }

    /** activateView reveals the panel in the right sidebar. */
    async activateView(): Promise<docketView> {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
        if (leaf === undefined) {
            leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
            await leaf.setViewState({ type: VIEW_TYPE, active: true });
        }
        await workspace.revealLeaf(leaf);
        return leaf.view as docketView;
    }

    /**
     * openSettings opens the settings modal on the docket tab. It uses the
     * undocumented `app.setting` API, so it degrades to doing nothing.
     */
    openSettings(): void {
        const setting = (this.app as unknown as { setting?: AppSettings })
            .setting;
        setting?.open();
        setting?.openTabById(this.manifest.id);
    }

    /**
     * addStatusBar shows progress while a run is in flight and the last status
     * report's counts afterwards; a click opens the panel.
     */
    private addStatusBar(): void {
        const item = this.addStatusBarItem();
        item.addClass("mod-clickable", "docket-statusbar");
        const icon = item.createSpan({ cls: "docket-statusbar-icon" });
        setIcon(icon, ICON_ID);
        const text = item.createSpan();
        item.onclick = () => void this.activateView();
        const paint = (): void => {
            const c = this.controller;
            const report = c.status?.report ?? null;
            text.setText(barText(c.run, c.busy, report));
            item.toggleClass("is-busy", c.busy);
            let tip = "docket: open the panel";
            if (c.busy) {
                tip = `docket: ${c.activity || "working"}…`;
            } else if (report !== null) {
                const n = statusCounts(report);
                tip =
                    `docket: ${n.push} to push, ${n.pull} to pull, ` +
                    `${n.diverged} changed on both sides` +
                    (n.problems > 0 ? `, ${n.problems} not checked` : "");
            }
            item.setAttribute("aria-label", tip);
            item.setAttribute("data-tooltip-position", "top");
        };
        this.register(this.controller.subscribe(paint));
        paint();
    }

    /**
     * addMcpStatusBar shows the MCP server's state while this device has it
     * switched on or it runs; a click copies its URL.
     */
    private addMcpStatusBar(): void {
        const item = this.addStatusBarItem();
        item.addClass("mod-clickable", "docket-statusbar", "docket-mcp-status");
        const icon = item.createSpan({ cls: "docket-statusbar-icon" });
        setIcon(icon, "plug");
        const text = item.createSpan();
        item.onclick = () => void this.mcp.copyUrl();
        const paint = (): void => {
            const state = this.mcp.state;
            item.toggle(mcpShown(state, this.mcpEnabled));
            text.setText(mcpBarText(state));
            item.toggleClass("is-busy", state.kind === "starting");
            item.toggleClass("mod-error", state.kind === "error");
            item.setAttribute("aria-label", mcpBarTip(state));
            item.setAttribute("data-tooltip-position", "top");
        };
        this.register(this.mcp.subscribe(paint));
        paint();
    }

    /**
     * addMcpCommands registers the MCP server commands; start, stop and
     * restart show only when they apply. They act on the server now and
     * leave this device's switch as it is.
     */
    private addMcpCommands(): void {
        const act: [McpCommand, string, () => Promise<void>][] = [
            ["start", "Start MCP server", () => this.mcp.host.start()],
            ["stop", "Stop MCP server", () => this.mcp.host.stop()],
            ["restart", "Restart MCP server", () => this.mcp.host.restart()],
        ];
        for (const [cmd, name, run] of act) {
            this.addCommand({
                id: `docket-mcp-${cmd}`,
                name,
                checkCallback: (checking) => {
                    if (!commandApplies(cmd, this.mcp.state)) return false;
                    if (!checking) void run();
                    return true;
                },
            });
        }
        this.addCommand({
            id: "docket-mcp-copy-url",
            name: "Copy MCP URL",
            callback: () => void this.mcp.copyUrl(),
        });
    }

    /**
     * addCommands registers the palette commands. The note commands use a
     * checkCallback, so they only show when the active note offers them.
     */
    private addCommands(): void {
        const c = this.controller;
        this.addCommand({
            id: "docket-open-panel",
            name: "Open panel",
            callback: () => void this.activateView(),
        });
        this.addCommand({
            id: "docket-pull-all",
            name: "Pull whole vault",
            callback: () => void c.pull({ kind: "vault" }),
        });
        this.addCommand({
            id: "docket-push-all",
            name: "Push whole vault…",
            callback: () => void c.push({ kind: "vault" }),
        });
        this.addCommand({
            id: "docket-status",
            name: "Check status",
            callback: () => void c.checkStatus(),
        });
        const noteCommand = (id: string, name: string, action: NoteAction) =>
            this.addCommand({
                id,
                name,
                checkCallback: (checking) => {
                    const file = this.activeNote();
                    if (file === null) return false;
                    if (
                        !noteActions(frontmatter(this, file)).includes(action)
                    ) {
                        return false;
                    }
                    if (!checking) void runNoteAction(this, action, file);
                    return true;
                },
            });
        noteCommand("docket-pull-current", "Pull current note", "pull");
        noteCommand("docket-push-current", "Push current note…", "push");
        noteCommand(
            "docket-discard-current",
            "Discard local changes in current note…",
            "discard",
        );
        this.addCommand({
            id: "docket-reply-comment",
            name: "Reply to comment…",
            editorCheckCallback: (checking, editor, ctx) => {
                const file = ctx.file;
                if (file === null || file.extension !== "md") return false;
                const ref = replyTarget(
                    this.settings.comments,
                    frontmatter(this, file),
                    editor.getValue(),
                    editor.getCursor().line,
                );
                if (ref === null) return false;
                if (!checking) void c.reply(file, ref);
                return true;
            },
        });
        this.addCommand({
            id: "docket-publish-current",
            name: "Publish current note to Confluence…",
            checkCallback: (checking) => {
                const file = this.activeNote();
                if (file === null || !canPublish(frontmatter(this, file))) {
                    return false;
                }
                if (!checking) void c.publish(toDest(file.path));
                return true;
            },
        });
        const linkCommand = (
            id: string,
            name: string,
            use: (url: string) => void,
        ) =>
            this.addCommand({
                id,
                name,
                checkCallback: (checking) => {
                    const file = this.activeNote();
                    const url =
                        file === null ? "" : noteLink(frontmatter(this, file));
                    if (url === "") return false;
                    if (!checking) use(url);
                    return true;
                },
            });
        linkCommand(
            "docket-open-in-confluence",
            "Open current note in Confluence",
            openInConfluence,
        );
        linkCommand(
            "docket-copy-link",
            "Copy Confluence link of current note",
            copyLink,
        );
    }

    /**
     * replyHost serves the comment callouts' reply buttons: a note's comments
     * can be answered when comments are on and the note is on Confluence, and
     * a click opens the reply dialog for the clicked comment's thread.
     */
    private replyHost(): ReplyHost {
        return {
            canReply: (file) =>
                canReply(this.settings.comments, frontmatter(this, file)),
            reply: (file, id) => void this.replyTo(file, id),
        };
    }

    /** replyTo opens the reply dialog for the thread of comment `id` in `file`. */
    private async replyTo(file: TFile, id: string): Promise<void> {
        const ref = threadOf(await this.app.vault.cachedRead(file), id);
        if (ref === null) {
            new Notice(`docket: comment id:${id} is not in the note; pull it`);
            return;
        }
        await this.controller.reply(file, ref);
    }

    /** activeNote is the active Markdown note, or null. */
    private activeNote(): TFile | null {
        const f = this.app.workspace.getActiveFile();
        return f !== null && f.extension === "md" ? f : null;
    }

    /**
     * fileMenu adds the docket section to a note's or a folder's context menu,
     * from the file explorer or a note's tab: sync actions and "Ignore in Git".
     */
    private fileMenu(menu: Menu, file: TAbstractFile): void {
        if (file instanceof TFile) {
            addNoteItems(menu, this, file);
        } else if (file instanceof TFolder) {
            addFolderItems(menu, this, file);
        }
        addIgnoreItem(menu, this, file);
    }
}
