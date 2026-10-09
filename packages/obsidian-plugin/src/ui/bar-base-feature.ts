// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The Obsidian side of what the change bars compare against: it tracks the
// active note against the note opened from its changes row and the commit
// picked in History, feeds the change bars the Confluence base of the note in
// Confluence mode, and re-feeds them whenever a status check replaces the
// remote bodies. The model is bar-base.ts.

import type docketPlugin from "../main.ts";
import { BarBaseState, type CommitPick } from "./bar-base.ts";
import { confluenceBase } from "./remote-diff.ts";

export class BarBaseFeature {
    private readonly state = new BarBaseState();
    /** refreshBars re-reads every open editor's base text. */
    private refreshBars: () => void = () => {};

    constructor(private readonly plugin: docketPlugin) {}

    /** load registers the triggers; `refreshBars` re-feeds the change bars. */
    load(refreshBars: () => void): void {
        this.refreshBars = refreshBars;
        const p = this.plugin;
        const ws = p.app.workspace;
        const focus = (): void => {
            const path = ws.getActiveFile()?.path ?? null;
            if (this.state.focus(path)) this.changed();
        };
        p.registerEvent(ws.on("file-open", focus));
        p.registerEvent(ws.on("active-leaf-change", focus));
        p.register(
            p.controller.subscribe(() => {
                this.state.reconcile((path) => this.body(path) !== null);
                this.refreshBars();
            }),
        );
    }

    /** opened is the note opened from its changes row, or null. */
    get opened(): string | null {
        return this.state.opened;
    }

    /** isOn reports whether `path`'s change bars show the Confluence diff. */
    isOn(path: string): boolean {
        return this.state.confluencePath === path;
    }

    /** open records `path` as opened from its changes row. */
    open(path: string): void {
        if (this.state.open(path)) this.changed();
    }

    /** toggle switches `path`'s change bars between git and Confluence. */
    toggle(path: string): void {
        if (this.state.toggle(path)) this.changed();
    }

    /** commit is the commit picked in History, or null. */
    get commit(): CommitPick | null {
        return this.state.commit;
    }

    /** pick compares a note's bars against a commit, or clears it with null. */
    pick(c: CommitPick | null): void {
        if (this.state.pick(c)) this.changed();
    }

    /**
     * base is the text `path`'s change bars compare against in Confluence mode,
     * built from the editor text `doc`, or null to compare against HEAD.
     */
    base(path: string, doc: string): string | null {
        if (this.state.base(path).kind !== "confluence") return null;
        const body = this.body(path);
        return body === null ? null : confluenceBase(doc, body);
    }

    /** body is `path`'s remote body from the last status check, or null. */
    private body(path: string): string | null {
        const remote = this.plugin.controller.status?.bodies.get(path);
        return remote !== undefined && "body" in remote ? remote.body : null;
    }

    /** changed re-renders the panel (its icon) and re-feeds the bars. */
    private changed(): void {
        this.plugin.controller.touch();
    }
}
