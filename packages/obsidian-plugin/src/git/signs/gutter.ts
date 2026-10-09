// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT
//
// Ported from obsidian-git `src/editor/signs/gutter.ts`
// (https://github.com/Vinzent03/obsidian-git), MIT License,
// Copyright (c) 2020 Vinzent03, Denis Olehov.
//
// The change-bar gutter: one marker per line a hunk touches — added, changed,
// or a deletion marker where lines were removed. Hovering a marker shows the
// hunk's base lines (tooltip.ts), which outlive leaving the gutter briefly. Markers are rebuilt when fresh hunks arrive
// and mapped through edits while a debounced diff is pending.

import { RangeSet, StateField, type Transaction } from "@codemirror/state";
import { type EditorView, GutterMarker, gutter } from "@codemirror/view";
import { allSigns, findHunk, type SignType } from "./hunks.ts";
import { baseTextEffect, debouncedHunksEffect, hunksState } from "./state.ts";
import { hideSoon, hoveredHunk, hoverHunk, keepPopup } from "./tooltip.ts";

class SignMarker extends GutterMarker {
    constructor(readonly type: SignType) {
        super();
    }

    override eq(other: GutterMarker): boolean {
        return other instanceof SignMarker && other.type === this.type;
    }

    override toDOM(): Node {
        const el = document.createElement("div");
        el.className = `docket-sign docket-sign-${this.type}`;
        if (this.type === "changedelete") el.textContent = "~";
        return el;
    }
}

/** markers builds the gutter markers of the transaction's current hunks. */
function markers(tr: Transaction): RangeSet<SignMarker> {
    const data = tr.state.field(hunksState, false);
    if (data === undefined) return RangeSet.empty;
    const doc = tr.state.doc;
    const ranges = allSigns(data.hunks)
        .filter((s) => s.lnum >= 1 && s.lnum <= doc.lines)
        .map((s) => {
            const line = doc.line(s.lnum);
            return new SignMarker(s.type).range(line.from);
        });
    return RangeSet.of(ranges, true);
}

const signsMarker = StateField.define<RangeSet<SignMarker>>({
    create: () => RangeSet.empty,
    update: (set, tr) => {
        const data = tr.state.field(hunksState, false);
        if (data === undefined) return RangeSet.empty;
        const fresh = tr.effects.some(
            (e) => e.is(debouncedHunksEffect) || e.is(baseTextEffect),
        );
        if (fresh || (tr.docChanged && !data.isDirty)) return markers(tr);
        return tr.docChanged ? set.map(tr.changes) : set;
    },
});

/**
 * hoverAt shows the hunk under a gutter line, or off one hides the popup after
 * the grace that lets the pointer reach it.
 */
function hoverAt(view: EditorView, pos: number): boolean {
    const data = view.state.field(hunksState, false);
    const lnum = view.state.doc.lineAt(pos).number;
    const hunk = data === undefined ? undefined : findHunk(lnum, data.hunks);
    const at =
        hunk === undefined
            ? null
            : view.state.doc.line(
                  Math.min(view.state.doc.lines, Math.max(1, hunk.added.start)),
              ).from;
    if (at === null) {
        hideSoon(view);
        return false;
    }
    keepPopup(view);
    if (view.state.field(hoveredHunk, false) !== at) {
        view.dispatch({ effects: hoverHunk.of(at) });
    }
    return false;
}

const signsGutter = gutter({
    class: "docket-signs-gutter",
    markers: (view) => view.state.field(signsMarker, false) ?? RangeSet.empty,
    initialSpacer: () => new SignMarker("add"),
    domEventHandlers: {
        mousemove: (view, line) => hoverAt(view, line.from),
        mouseleave: (view) => {
            hideSoon(view);
            return false;
        },
    },
});

/** gutterExtensions are the gutter and its markers. */
export const gutterExtensions = [signsMarker, signsGutter];
