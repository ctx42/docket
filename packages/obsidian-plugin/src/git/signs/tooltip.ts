// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT
//
// Ported from obsidian-git `src/editor/signs/tooltip.ts`
// (https://github.com/Vinzent03/obsidian-git), MIT License,
// Copyright (c) 2020 Vinzent03, Denis Olehov.
//
// The change bars' hover popup: hovering a gutter marker shows the lines the
// hunk replaced, as they read in the base — HEAD, or the Confluence page.
// Read-only — obsidian-git's click-to-pin, stage, and reset buttons are not
// ported.

import { StateEffect, StateField } from "@codemirror/state";
import { showTooltip, type Tooltip } from "@codemirror/view";
import { findHunk, type Hunk } from "./hunks.ts";
import { type BaseKind, baseKind, hunksState } from "./state.ts";

/** hoverHunk sets the position of the hunk the pointer is over, or null. */
export const hoverHunk = StateEffect.define<number | null>();

/** hoveredHunk is the start position of the hovered hunk's first line. */
export const hoveredHunk = StateField.define<number | null>({
    create: () => null,
    update: (pos, tr) => {
        for (const e of tr.effects) if (e.is(hoverHunk)) return e.value;
        if (pos === null || !tr.docChanged) return pos;
        return tr.changes.mapPos(pos);
    },
});

const diffTooltip = StateField.define<readonly Tooltip[]>({
    create: () => [],
    update: (tips, tr) => {
        const changed =
            tr.docChanged ||
            tr.effects.some((e) => e.is(hoverHunk)) ||
            tr.startState.field(hunksState, false) !==
                tr.state.field(hunksState, false);
        if (!changed) return tips;
        const pos = tr.state.field(hoveredHunk);
        const data = tr.state.field(hunksState, false);
        if (pos === null || data === undefined) return [];
        const hunk = findHunk(tr.state.doc.lineAt(pos).number, data.hunks);
        if (hunk === undefined) return [];
        return [
            {
                pos,
                above: true,
                arrow: false,
                strictSide: false,
                create: () => ({
                    dom: popup(hunk, tr.state.field(baseKind, false) ?? "head"),
                }),
            },
        ];
    },
    provide: (f) => showTooltip.computeN([f], (state) => state.field(f)),
});

/** HEADS titles a popup by hunk type, for each kind of base text. */
const HEADS: Record<BaseKind, Record<Hunk["type"], string>> = {
    head: {
        add: "Added since the last commit",
        delete: "Deleted since the last commit",
        change: "Changed since the last commit",
    },
    confluence: {
        add: "Not on Confluence",
        delete: "Only on Confluence",
        change: "Differs from Confluence",
    },
};

/**
 * popup renders a hunk as a small unified diff: its base lines (HEAD, or the
 * Confluence page), then the lines that replaced them.
 */
function popup(hunk: Hunk, kind: BaseKind): HTMLElement {
    const el = document.createElement("div");
    el.className = "docket-diff-tooltip";
    const head = el.appendChild(document.createElement("div"));
    head.className = "docket-diff-head";
    head.textContent = HEADS[kind][hunk.type];
    const line = (text: string, cls: string): void => {
        const row = el.appendChild(document.createElement("div"));
        row.className = `docket-diff-line ${cls}`;
        row.textContent = text === "" ? "\u00a0" : text;
    };
    for (const l of hunk.removed.lines) line(l, "docket-diff-del");
    for (const l of hunk.added.lines) line(l, "docket-diff-ins");
    return el;
}

/** tooltipExtensions are the hover state and its popup. */
export const tooltipExtensions = [hoveredHunk, diffTooltip];
