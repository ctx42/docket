// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT
//
// Adapted from obsidian-git `src/editor/signs/signsIntegration.ts` and
// `signsProvider.ts` (https://github.com/Vinzent03/obsidian-git), MIT License,
// Copyright (c) 2020 Vinzent03, Denis Olehov.
//
// The change bars' Obsidian side: it registers the editor extensions (toggled
// by a per-device setting, without a reload) and feeds every open editor its
// note's HEAD text — or, for a note in Confluence mode, the base the
// {@link BaseOverride} supplies. Where obsidian-git keeps a pub-sub of editors
// per path, a view plugin here records each live editor, and a refresh reads
// each one's current path. Refreshes run on opening a note, a rename, a docket
// commit, and every 10 s for the active note (a commit made outside docket).

import type { Extension } from "@codemirror/state";
import { type EditorView, ViewPlugin } from "@codemirror/view";
import { editorInfoField, type Plugin } from "obsidian";
import type { GitController } from "../controller.ts";
import { gutterExtensions } from "./gutter.ts";
import {
    type BaseKind,
    baseKind,
    baseKindEffect,
    baseTextEffect,
    hunksExtensions,
    hunksState,
} from "./state.ts";
import { tooltipExtensions } from "./tooltip.ts";

/** INTERVAL_MS re-reads the active note's HEAD text for outside commits. */
const INTERVAL_MS = 10_000;

/**
 * BaseOverride supplies the text a note's bars compare against in place of its
 * HEAD version — given its vault path and editor text — or null to use HEAD.
 */
export type BaseOverride = (path: string, doc: string) => string | null;

export class SignsFeature {
    /** The registered extension array, mutated in place to toggle the bars. */
    private readonly extensions: Extension[] = [];
    private readonly editors = new Set<EditorView>();
    private enabled = false;

    constructor(
        private readonly plugin: Plugin,
        private readonly git: GitController,
        private readonly override: BaseOverride = () => null,
    ) {}

    /** load registers the extensions and the refresh triggers. */
    load(enabled: boolean): void {
        const p = this.plugin;
        p.registerEditorExtension(this.extensions);
        const ws = p.app.workspace;
        p.registerEvent(ws.on("file-open", () => this.refreshAll()));
        p.registerEvent(ws.on("active-leaf-change", () => this.refreshAll()));
        p.registerEvent(p.app.vault.on("rename", () => this.refreshAll()));
        p.register(this.git.onCommitted(() => this.refreshAll()));
        let kind = this.git.state.kind;
        p.register(
            this.git.watch(() => {
                if (this.git.state.kind === kind) return;
                kind = this.git.state.kind;
                this.refreshAll();
            }),
        );
        p.registerInterval(
            window.setInterval(() => this.refreshActive(), INTERVAL_MS),
        );
        this.setEnabled(enabled);
    }

    /** setEnabled shows or hides the bars in every editor. */
    setEnabled(on: boolean): void {
        if (on === this.enabled) return;
        this.enabled = on;
        this.extensions.length = 0;
        if (on) {
            this.extensions.push(
                hunksExtensions,
                gutterExtensions,
                tooltipExtensions,
                ViewPlugin.define((view) => {
                    this.editors.add(view);
                    window.setTimeout(() => void this.refresh(view), 0);
                    return { destroy: () => this.editors.delete(view) };
                }),
            );
        } else {
            this.editors.clear();
        }
        this.plugin.app.workspace.updateOptions();
    }

    /** refreshAll re-reads the HEAD text of every open editor's note. */
    refreshAll(): void {
        if (!this.enabled) return;
        for (const view of this.editors) void this.refresh(view);
    }

    /** refreshActive re-reads the HEAD text of the active editor's note. */
    private refreshActive(): void {
        if (!this.enabled) return;
        const path = this.plugin.app.workspace.getActiveFile()?.path;
        for (const view of this.editors) {
            if (pathOf(view) === path) void this.refresh(view);
        }
    }

    /**
     * refresh sets `view`'s base text to its note's override (see
     * {@link BaseOverride}), else to its HEAD version.
     */
    private async refresh(view: EditorView): Promise<void> {
        const path = pathOf(view);
        if (path === undefined) return;
        const over = this.override(path, view.state.doc.toString());
        const kind: BaseKind = over === null ? "head" : "confluence";
        let base: string | undefined;
        if (over !== null) {
            base = over;
        } else {
            try {
                base = await this.git.baseText(path);
            } catch {
                base = undefined;
            }
        }
        if (base !== undefined) base = base.replace(/\r\n/g, "\n");
        if (!this.editors.has(view) || pathOf(view) !== path) return;
        if (
            view.state.field(hunksState, false)?.base === base &&
            view.state.field(baseKind, false) === kind
        ) {
            return;
        }
        view.dispatch({
            effects: [baseKindEffect.of(kind), baseTextEffect.of(base)],
        });
    }
}

/** pathOf is the vault path of the note an editor shows, if any. */
function pathOf(view: EditorView): string | undefined {
    return view.state.field(editorInfoField, false)?.file?.path;
}
