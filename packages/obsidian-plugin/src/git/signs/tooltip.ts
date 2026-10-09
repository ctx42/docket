// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT
//
// Ported from obsidian-git `src/editor/signs/tooltip.ts`
// (https://github.com/Vinzent03/obsidian-git), MIT License,
// Copyright (c) 2020 Vinzent03, Denis Olehov.
//
// The change bars' hover popup: hovering a gutter marker shows the lines the
// hunk replaced, as they read in the base — HEAD, the Confluence page, or a
// commit picked in History — then the lines that replaced them, with the
// edited words marked. Leaving the gutter hides the popup only after a short
// grace, so the pointer can move onto it — to scroll a long one — and it stays
// while the pointer is over it.
// Read-only — obsidian-git's click-to-pin, stage, and reset buttons are not
// ported.

import { StateEffect, StateField } from "@codemirror/state";
import { type EditorView, showTooltip, type Tooltip } from "@codemirror/view";
import { type BaseSource, HEAD, popupTitle } from "./base.ts";
import { findHunk, type Hunk } from "./hunks.ts";
import { baseSource, hunksState } from "./state.ts";
import { type Segment, wordDiff } from "./words.ts";

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

/** HIDE_DELAY_MS is how long a popup outlives the pointer leaving it. */
const HIDE_DELAY_MS = 300;

/** hideTimers are each editor's pending popup hides. */
const hideTimers = new WeakMap<EditorView, number>();

/**
 * hideSoon hides `view`'s popup after {@link HIDE_DELAY_MS}; a hide already
 * pending keeps its time, so a moving pointer cannot keep putting it off.
 */
export function hideSoon(view: EditorView): void {
    if (hideTimers.has(view)) return;
    hideTimers.set(
        view,
        window.setTimeout(() => {
            hideTimers.delete(view);
            if (!view.dom.isConnected) return;
            if (view.state.field(hoveredHunk, false) === null) return;
            view.dispatch({ effects: hoverHunk.of(null) });
        }, HIDE_DELAY_MS),
    );
}

/** keepPopup cancels a pending hide of `view`'s popup. */
export function keepPopup(view: EditorView): void {
    const t = hideTimers.get(view);
    if (t === undefined) return;
    window.clearTimeout(t);
    hideTimers.delete(view);
}

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
                create: (view) => {
                    const dom = popup(
                        hunk,
                        tr.state.field(baseSource, false) ?? HEAD,
                    );
                    dom.addEventListener("mouseenter", () => keepPopup(view));
                    dom.addEventListener("mouseleave", () => hideSoon(view));
                    return { dom };
                },
            },
        ];
    },
    provide: (f) => showTooltip.computeN([f], (state) => state.field(f)),
});

/**
 * popup renders a hunk as a small unified diff: its base lines (HEAD, the
 * Confluence page, or a commit), then the lines that replaced them, each
 * marking the words that changed.
 */
function popup(hunk: Hunk, src: BaseSource): HTMLElement {
    const el = document.createElement("div");
    el.className = "docket-diff-tooltip";
    const head = el.appendChild(document.createElement("div"));
    head.className = "docket-diff-head";
    head.textContent = popupTitle(src, hunk.type);
    const line = (segs: Segment[], cls: string): void => {
        const row = el.appendChild(document.createElement("div"));
        row.className = `docket-diff-line ${cls}`;
        if (segs.every((s) => s.text === "")) {
            row.textContent = "\u00a0";
            return;
        }
        for (const s of segs) {
            if (!s.changed) {
                row.append(s.text);
                continue;
            }
            const word = row.appendChild(document.createElement("span"));
            word.className = "docket-diff-word";
            word.textContent = s.text;
        }
    };
    const words = wordDiff(hunk);
    for (const l of words.removed) line(l, "docket-diff-del");
    for (const l of words.added) line(l, "docket-diff-ins");
    return el;
}

/** tooltipExtensions are the hover state and its popup. */
export const tooltipExtensions = [hoveredHunk, diffTooltip];
