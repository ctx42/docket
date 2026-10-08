// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The right-side dock panel. It never runs anything itself: it renders the
// controller's state and forwards clicks to the controller. This file is the
// panel's frame — its lifecycle, render scheduling, tab switch and "more"
// menu; each tab draws itself: Sync (sync-tab.ts), Git (git/git-tab.ts),
// History (git/history-tab.ts) and MCP (mcp-tab.ts). All logic lives in the
// obsidian-free models those files name; the DOM shells are verified by
// typecheck + manual load.

import {
    ItemView,
    type Menu,
    setIcon,
    type ViewStateResult,
    type WorkspaceLeaf,
} from "obsidian";
import { GitTab } from "../git/git-tab.ts";
import { HistoryTab } from "../git/history-tab.ts";
import { ICON_ID } from "../icon.ts";
import type docketPlugin from "../main.ts";
import { shown } from "../mcp/status.ts";
import { McpTab } from "./mcp-tab.ts";
import { statusSections, statusText } from "./review.ts";
import { SyncTab } from "./sync-tab.ts";

export const VIEW_TYPE = "docket-panel";

/** AGE_REFRESH_MS re-renders the "checked N min ago" stamp. */
const AGE_REFRESH_MS = 60_000;

/** PanelTab is one of the panel's tabs. */
export type PanelTab = "sync" | "git" | "history" | "mcp";

/** TABS are the panel's tabs, in order, with their labels and icons. */
const TABS: [PanelTab, string, string][] = [
    ["sync", "Sync", "refresh-cw"],
    ["git", "Git", "git-branch"],
    ["history", "History", "history"],
    ["mcp", "MCP", "plug"],
];

export class docketView extends ItemView {
    private unsubscribe: (() => void) | null = null;
    private unsubscribeGit: (() => void) | null = null;
    private unsubscribeCommit: (() => void) | null = null;
    private unsubscribeMcp: (() => void) | null = null;
    private unsubscribeMcpLog: (() => void) | null = null;
    private tab: PanelTab = "sync";
    private readonly syncTab: SyncTab;
    private readonly gitTab: GitTab;
    private readonly historyTab: HistoryTab;
    private readonly mcpTab: McpTab;
    private frame = 0;
    /**
     * Whether a pointer is down in the panel. A render then waits for its
     * release: rebuilding the DOM between press and release would replace the
     * button under the pointer, and the click would never fire.
     */
    private pressed = false;
    /** Whether a render was held back while {@link pressed}. */
    private deferred = false;

    constructor(
        leaf: WorkspaceLeaf,
        private readonly plugin: docketPlugin,
    ) {
        super(leaf);
        this.syncTab = new SyncTab(plugin, {
            schedule: () => this.schedule(),
            rerender: () => this.render(),
            moreItems: (menu) => this.addMoreItems(menu),
        });
        this.gitTab = new GitTab(plugin, () => this.schedule());
        this.historyTab = new HistoryTab(plugin, () => this.schedule());
        this.mcpTab = new McpTab(plugin);
    }

    override getState(): Record<string, unknown> {
        return { ...super.getState(), tab: this.tab };
    }

    override async setState(
        state: unknown,
        result: ViewStateResult,
    ): Promise<void> {
        const tab = (state as { tab?: unknown } | null)?.tab;
        if (TABS.some(([id]) => id === tab)) {
            this.tab = tab as PanelTab;
            this.schedule();
        }
        await super.setState(state, result);
    }

    /** showTab switches the panel to `tab`. */
    showTab(tab: PanelTab): void {
        if (tab === this.tab || !this.tabShown(tab)) return;
        this.tab = tab;
        if (tab === "git" || tab === "history") void this.plugin.git.refresh();
        if (tab === "history") this.historyTab.invalidate();
        this.app.workspace.requestSaveLayout();
        this.render();
    }

    getViewType(): string {
        return VIEW_TYPE;
    }
    getDisplayText(): string {
        return "docket";
    }
    override getIcon(): string {
        return ICON_ID;
    }

    override async onOpen(): Promise<void> {
        const c = this.plugin.controller;
        this.contentEl.addClass("docket-panel");

        this.unsubscribe = c.subscribe(() => this.schedule());
        this.unsubscribeGit = this.plugin.git.subscribe(() => this.schedule());
        this.unsubscribeMcp = this.plugin.mcp.subscribe(() => this.schedule());
        this.unsubscribeMcpLog = this.plugin.mcp.log.subscribe(() => {
            if (this.tab === "mcp") this.schedule();
        });
        this.unsubscribeCommit = this.plugin.git.onCommitted(() =>
            this.historyTab.invalidate(),
        );
        const ws = this.app.workspace;
        // Clicking into the panel activates its own leaf; the active note is
        // unchanged then, so only another leaf needs a render.
        this.registerEvent(
            ws.on("active-leaf-change", (leaf) => {
                if (leaf !== this.leaf) this.schedule();
            }),
        );
        this.registerEvent(ws.on("file-open", () => this.schedule()));
        this.registerEvent(
            this.app.metadataCache.on("changed", (file) => {
                if (file.path === this.syncTab.activeFile()?.path) {
                    this.schedule();
                }
            }),
        );
        this.registerInterval(
            window.setInterval(() => this.schedule(), AGE_REFRESH_MS),
        );
        this.registerDomEvent(
            this.contentEl,
            "pointerdown",
            () => {
                this.pressed = true;
            },
            { capture: true },
        );
        this.registerDomEvent(window, "pointerup", () => this.release());
        this.registerDomEvent(window, "pointercancel", () => this.release());
        this.render();
    }

    /**
     * release ends a press in the panel and schedules any render it held back;
     * the scheduled frame runs after the press's click has been dispatched.
     */
    private release(): void {
        if (!this.pressed) return;
        this.pressed = false;
        if (this.deferred) {
            this.deferred = false;
            this.schedule();
        }
    }

    override async onClose(): Promise<void> {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.unsubscribeGit?.();
        this.unsubscribeGit = null;
        this.unsubscribeCommit?.();
        this.unsubscribeCommit = null;
        this.unsubscribeMcp?.();
        this.unsubscribeMcp = null;
        this.unsubscribeMcpLog?.();
        this.unsubscribeMcpLog = null;
        if (this.frame !== 0) cancelAnimationFrame(this.frame);
    }

    /** onPaneMenu adds the panel's less frequent actions to its "more" menu. */
    override onPaneMenu(menu: Menu, source: string): void {
        super.onPaneMenu(menu, source);
        this.addMoreItems(menu);
    }

    /** addMoreItems adds the panel's less frequent actions to `menu`. */
    private addMoreItems(menu: Menu): void {
        const status = this.plugin.controller.status;
        menu.addItem((item) =>
            item
                .setSection("docket")
                .setTitle("Show ignored notes")
                .setIcon("eye-off")
                .setChecked(this.syncTab.showIgnored)
                .onClick(() => {
                    this.syncTab.showIgnored = !this.syncTab.showIgnored;
                    this.render();
                }),
        );
        menu.addItem((item) =>
            item
                .setSection("docket")
                .setTitle("Copy status report")
                .setIcon("copy")
                .setDisabled(status === null)
                .onClick(() => {
                    if (status === null) return;
                    const text = statusText(
                        statusSections(
                            status.report,
                            this.plugin.settings.syncRoot,
                            true,
                        ),
                    );
                    void navigator.clipboard.writeText(
                        text || "Everything up to date\n",
                    );
                }),
        );
        menu.addItem((item) =>
            item
                .setSection("docket")
                .setTitle("docket settings")
                .setIcon("settings")
                .onClick(() => this.plugin.openSettings()),
        );
    }

    /**
     * schedule coalesces bursts of changes (a run's log lines) into one render,
     * held back while a pointer is down in the panel (see {@link pressed}).
     */
    private schedule(): void {
        if (this.frame !== 0) return;
        this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            if (this.pressed) {
                this.deferred = true;
                return;
            }
            this.render();
        });
    }

    /**
     * tabShown reports whether the panel offers tab: the MCP tab only while
     * the server is shown at all (see {@link shown}).
     */
    private tabShown(tab: PanelTab): boolean {
        return (
            tab !== "mcp" ||
            shown(this.plugin.mcp.state, this.plugin.mcpEnabled)
        );
    }

    /**
     * render rebuilds the panel, keeping its scroll position; a tab no
     * longer offered falls back to Sync.
     */
    private render(): void {
        const root = this.contentEl;
        const scroll = root.scrollTop;
        root.empty();
        if (!this.tabShown(this.tab)) this.tab = "sync";
        this.renderTabs(root);
        if (this.tab === "mcp") {
            this.mcpTab.render(
                root.createDiv({ cls: "docket-tab-body docket-mcp-tab" }),
            );
        } else if (this.tab === "git") {
            this.gitTab.render(root.createDiv({ cls: "docket-tab-body" }));
        } else if (this.tab === "history") {
            this.historyTab.render(root.createDiv({ cls: "docket-tab-body" }));
        } else {
            this.syncTab.render(root);
        }
        root.scrollTop = scroll;
    }

    /** renderTabs draws the Sync | Git | History switch. */
    private renderTabs(root: HTMLElement): void {
        const bar = root.createDiv({ cls: "docket-tabs" });
        for (const [id, label, icon] of TABS) {
            if (!this.tabShown(id)) continue;
            const el = bar.createDiv({
                cls: "docket-tab",
                attr: { role: "tab", "aria-selected": String(id === this.tab) },
            });
            setIcon(el.createSpan({ cls: "docket-tab-icon" }), icon);
            el.createSpan({ text: label });
            if (id === this.tab) el.addClass("is-active");
            el.onclick = () => this.showTab(id);
        }
    }
}
