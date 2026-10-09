// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { hostname } from "node:os";
import { PACKAGE_NAME, posixJoin } from "@docket/core";
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

import { loadDeviceToken, writePointer, writeToken } from "./device-state.ts";
import { GitController } from "./git/controller.ts";
import { capHistory, HISTORY_CAP, recordMessage } from "./git/history.ts";
import { addIgnoreItem } from "./git/ignore-menu.ts";
import { SignsFeature } from "./git/signs/feature.ts";
import { ICON_ID, ICON_SVG } from "./icon.ts";
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
import { resolveCacheRoot } from "./runtime.ts";
import { DEFAULT_SETTINGS, type docketSettings } from "./settings/model.ts";
import {
    loadCommitHistory,
    loadDiffSigns,
    loadGitPath,
    loadHideProps,
    loadHistoryCap,
    loadMcpEnabled,
    loadSettings,
    loadToken,
    saveCommitHistory,
    saveDiffSigns,
    saveGitPath,
    saveHideProps,
    saveHistoryCap,
    saveMcpEnabled,
    saveSettings,
    saveToken,
} from "./settings/store.ts";
import { docketSettingTab } from "./settings/tab.ts";
import { BarBaseFeature } from "./ui/bar-base-feature.ts";
import { SyncController } from "./ui/controller.ts";
import {
    addFilesItems,
    addFolderItems,
    addNoteItems,
    copyLink,
    frontmatter,
    openInConfluence,
    runNoteAction,
} from "./ui/menus.ts";
import {
    canPublish,
    type NoteAction,
    noteActions,
    noteLink,
} from "./ui/note-actions.ts";
import { toDest } from "./ui/operations.ts";
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
    /** This device's committed messages, most recent first. */
    commitHistory: string[] = [];
    /** How many commit messages this device keeps (see setHistoryCap). */
    historyCap = HISTORY_CAP;
    /** Whether this device runs the MCP doc server (see setMcpEnabled). */
    mcpEnabled = false;
    /** The MCP doc server this device runs. */
    readonly mcp = new McpController(this);
    /** The vault repository: change list, commits, history. */
    readonly git = new GitController(
        this.app,
        () => this.gitPath,
        (m) => this.recordCommitMessage(m),
    );
    /** What the change bars compare against: HEAD, Confluence, or a commit. */
    readonly barBase = new BarBaseFeature(this);
    private readonly signs = new SignsFeature(this, this.git, (path, doc) =>
        this.barBase.base(path, doc),
    );

    override async onload(): Promise<void> {
        this.settings = await loadSettings(this);
        this.cacheRoot = resolveCacheRoot(this.app);
        this.token = await this.loadToken();
        void this.recordPointer();
        this.setHideProps(loadHideProps(this), false);
        this.gitPath = loadGitPath(this);
        this.diffSigns = loadDiffSigns(this);
        this.historyCap = loadHistoryCap(this);
        this.commitHistory = capHistory(
            loadCommitHistory(this),
            this.historyCap,
        );
        this.mcpEnabled = loadMcpEnabled(this);

        this.addSettingTab(new docketSettingTab(this.app, this));
        this.registerEditorExtension(indentViewPlugin);
        this.registerMarkdownPostProcessor(indentPostProcessor);
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
            ws.on("editor-menu", (menu, _editor, info) => {
                if (info.file !== null) addNoteItems(menu, this, info.file);
            }),
        );

        console.log(`docket: loaded (core=${PACKAGE_NAME})`);
    }

    override onunload(): void {
        this.mcp.unload();
        this.git.dispose();
        document.body.removeClass(HIDE_PROPS_CLASS);
        console.log("docket: unloaded");
    }

    /** persistSettings writes the current shareable settings to `data.json`. */
    async persistSettings(): Promise<void> {
        await saveSettings(this, this.settings);
        this.controller.touch();
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
     * uses it, and the repository state is re-read now.
     */
    setGitPath(path: string): void {
        this.gitPath = path.trim();
        saveGitPath(this, this.gitPath);
        void this.git.refresh();
    }

    /** recordCommitMessage puts a committed message first in the history. */
    recordCommitMessage(message: string): void {
        this.commitHistory = recordMessage(
            this.commitHistory,
            message,
            this.historyCap,
        );
        saveCommitHistory(this, this.commitHistory);
    }

    /**
     * setHistoryCap changes how many commit messages this device keeps,
     * trimming the stored history at once; 0 turns the history off.
     */
    setHistoryCap(cap: number): void {
        this.historyCap = cap;
        saveHistoryCap(this, cap);
        this.commitHistory = capHistory(this.commitHistory, cap);
        saveCommitHistory(this, this.commitHistory);
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
     * watchGit wires the change list's refresh triggers: vault events (once the
     * vault has loaded, debounced by the controller) and a sync run finishing —
     * pull and push never commit, so their file changes simply show up.
     */
    private watchGit(): void {
        this.app.workspace.onLayoutReady(() => {
            const vault = this.app.vault;
            const changed = () => this.git.changed();
            this.registerEvent(vault.on("modify", changed));
            this.registerEvent(vault.on("create", changed));
            this.registerEvent(vault.on("delete", changed));
            this.registerEvent(vault.on("rename", changed));
            void this.git.refresh();
        });
        let busy = this.controller.busy;
        this.register(
            this.controller.subscribe(() => {
                const was = busy;
                busy = this.controller.busy;
                if (was && !busy) void this.git.refresh();
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
