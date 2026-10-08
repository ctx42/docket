// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The Sync tab's Changes section: the last status check as collapsible
// groups of notes, each with its bulk action, and per-note hover actions. DOM
// shell; the grouping is review.ts and the render decisions panel-model.ts.

import { isClean, rowActions } from "@docket/core";
import { Menu, setIcon, TFile } from "obsidian";
import type docketPlugin from "../main.ts";
import { addNoteItems, frontmatter, openInConfluence } from "./menus.ts";
import { noteLink } from "./note-actions.ts";
import { bulkAction, changeTooltip } from "./panel-model.ts";
import { remoteFor } from "./remote-diff.ts";
import {
    ACTION_ICON,
    ACTION_TEXT,
    type ChangeGroup,
    type ChangeGroupId,
    type ChangeRow,
    changeGroups,
} from "./review.ts";
import { ago } from "./summary.ts";

/** GROUP_ICON is each changes group's row icon. */
const GROUP_ICON: Record<ChangeGroupId, string> = {
    conflicts: "alert-triangle",
    outgoing: "arrow-up",
    new: "file-plus",
    incoming: "arrow-down",
    diverged: "git-merge",
    problems: "ban",
    ignored: "eye-off",
};

export class ChangesList {
    /** Groups the user collapsed; they stay collapsed across re-renders. */
    private readonly collapsed = new Set<ChangeGroupId>();

    constructor(
        private readonly plugin: docketPlugin,
        private readonly rerender: () => void,
    ) {}

    /** render draws the section; `showIgnored` adds the ignored group. */
    render(root: HTMLElement, showIgnored: boolean): void {
        const section = root.createDiv({ cls: "docket-section" });
        const head = section.createDiv({ cls: "docket-section-head" });
        head.createSpan({ cls: "docket-section-title", text: "Changes" });
        const status = this.plugin.controller.status;
        if (status === null) {
            section.createDiv({
                cls: "docket-muted",
                text: "Check status to see which notes changed here or on Confluence.",
            });
            const btn = section.createEl("button", { text: "Check status" });
            btn.disabled = this.plugin.controller.busy;
            btn.onclick = () => void this.plugin.controller.checkStatus();
            return;
        }
        head.createSpan({
            cls: "docket-muted",
            text: `checked ${ago(status.at, Date.now())}`,
        });
        const groups = changeGroups(
            status.report,
            this.plugin.settings.syncRoot,
            showIgnored,
        );
        if (isClean(status.report) && groups.length === 0) {
            section.createDiv({
                cls: "docket-muted",
                text: "Everything is up to date.",
            });
            return;
        }
        for (const g of groups) this.renderGroup(section, g);
    }

    /** renderGroup draws one changes group: its header and, unless collapsed, rows. */
    private renderGroup(parent: HTMLElement, g: ChangeGroup): void {
        const c = this.plugin.controller;
        const collapsed = this.collapsed.has(g.id);
        const tree = parent.createDiv({
            cls: `tree-item docket-group is-${g.id}`,
        });
        const self = tree.createDiv({
            cls: "tree-item-self is-clickable docket-group-head",
        });
        const toggle = self.createDiv({ cls: "tree-item-icon collapse-icon" });
        if (collapsed) toggle.addClass("is-collapsed");
        setIcon(toggle, "right-triangle");
        self.createDiv({ cls: "tree-item-inner", text: g.title });
        const end = self.createDiv({ cls: "docket-row-end" });
        const dests = g.rows.map((r) => r.dest);
        const bulk = bulkAction(g.id);
        if (bulk !== null) {
            this.iconButton(
                end,
                bulk.icon,
                bulk.label,
                () =>
                    void (bulk.op === "push"
                        ? c.push({ kind: "notes", dests })
                        : c.pull({ kind: "notes", dests })),
                true,
            );
        }
        end.createDiv({ cls: "tree-item-flair", text: String(g.rows.length) });
        self.onclick = () => {
            if (collapsed) this.collapsed.delete(g.id);
            else this.collapsed.add(g.id);
            this.rerender();
        };
        if (collapsed) return;
        const kids = tree.createDiv({ cls: "tree-item-children" });
        for (const r of g.rows) this.renderChange(kids, g.id, r);
    }

    /** renderChange draws one note of a group with its hover actions. */
    private renderChange(
        parent: HTMLElement,
        id: ChangeGroupId,
        r: ChangeRow,
    ): void {
        const file = this.noteAt(r.dest);
        const self = parent.createDiv({
            cls: "tree-item-self is-clickable docket-change",
        });
        const remote = remoteFor(
            this.plugin.controller.status?.bodies,
            id,
            r.dest,
        );
        self.setAttribute(
            "aria-label",
            changeTooltip(r.name, r.detail, remote),
        );
        self.setAttribute("data-tooltip-position", "left");
        setIcon(
            self.createDiv({ cls: "tree-item-icon docket-change-icon" }),
            GROUP_ICON[id],
        );
        const inner = self.createDiv({ cls: "tree-item-inner" });
        inner.createSpan({
            cls: "docket-change-name",
            text: file?.basename ?? r.name,
        });
        if (r.detail !== "") {
            inner.createSpan({ cls: "docket-change-detail", text: r.detail });
        }
        const diff = this.plugin.remoteDiff;
        if (
            remote !== null &&
            "body" in remote &&
            diff.opened === r.dest &&
            this.plugin.diffSigns
        ) {
            const on = diff.isOn(r.dest);
            this.iconButton(
                self.createDiv({ cls: "docket-row-end" }),
                "file-diff",
                on ? "Show the git diff" : "Show the Confluence diff",
                () => diff.toggle(r.dest),
            ).toggleClass("is-active", on);
        }
        const end = self.createDiv({ cls: "docket-row-end docket-hover" });
        const row = r.row;
        if (row !== null) {
            for (const a of rowActions(row.kind).filter((x) => x !== "skip")) {
                this.iconButton(end, ACTION_ICON[a], ACTION_TEXT[a], () => {
                    void this.plugin.controller.apply([{ row, action: a }]);
                });
            }
        }
        const url =
            file === null ? "" : noteLink(frontmatter(this.plugin, file));
        if (url !== "") {
            this.iconButton(end, "external-link", "Open in Confluence", () =>
                openInConfluence(url),
            );
        }
        if (file !== null) {
            self.onclick = () => {
                diff.open(r.dest);
                void this.plugin.app.workspace.getLeaf(false).openFile(file);
            };
            self.oncontextmenu = (e) => {
                const menu = new Menu();
                if (addNoteItems(menu, this.plugin, file))
                    menu.showAtMouseEvent(e);
            };
        }
    }

    /** noteAt resolves a vault path to its note, or null. */
    private noteAt(path: string): TFile | null {
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile ? file : null;
    }

    /** iconButton appends a small icon button that does not trigger its row. */
    private iconButton(
        parent: HTMLElement,
        icon: string,
        label: string,
        onClick: () => void,
        sync = false,
    ): HTMLElement {
        const btn = parent.createDiv({
            cls: "clickable-icon docket-icon-btn",
            attr: { "aria-label": label },
        });
        setIcon(btn, icon);
        if (sync && this.plugin.controller.busy) btn.addClass("is-disabled");
        btn.onclick = (e) => {
            e.stopPropagation();
            onClick();
        };
        return btn;
    }
}
