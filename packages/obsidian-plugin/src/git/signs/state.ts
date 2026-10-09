// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT
//
// Ported from obsidian-git `src/editor/signs/hunkState.ts`
// (https://github.com/Vinzent03/obsidian-git), MIT License,
// Copyright (c) 2020 Vinzent03, Denis Olehov.
//
// The editor state behind the change bars: the note's base text (HEAD, the
// Confluence page, or a commit — see {@link baseSource}), set by the signs
// feature through
// {@link baseTextEffect}, and the hunks of the editor
// text against it. Hunks are recomputed on every edit — incrementally, from the
// previous chunks and the edits since — except that a large edit, or a note
// whose diffs have run slow, recomputes once after a debounce instead. Only the
// unstaged-against-HEAD half of obsidian-git's state is ported.

import type { Chunk } from "@codemirror/merge";
import {
    type ChangeDesc,
    type EditorState,
    StateEffect,
    StateField,
    type Transaction,
} from "@codemirror/state";
import { type Debouncer, debounce, editorEditorField } from "obsidian";
import { type BaseSource, HEAD } from "./base.ts";
import { computeHunks } from "./diff.ts";
import type { Hunk } from "./hunks.ts";

/** HunksData is a note's base text and its current hunks. */
export interface HunksData {
    /** The base text; undefined shows no bars (ignored, or git unavailable). */
    base: string | undefined;
    hunks: Hunk[];
    chunks: readonly Chunk[] | undefined;
    /** The edits since `chunks` were computed. */
    changeDesc: ChangeDesc | undefined;
    /** Whether `hunks` lag the document (a debounced diff is pending). */
    isDirty: boolean;
    /** A decaying maximum of recent diff durations. */
    maxDiffTimeMs: number;
}

/** ComputedHunks is one diff's result. */
interface ComputedHunks {
    hunks: Hunk[];
    chunks: readonly Chunk[] | undefined;
    diffDuration: number;
}

/** baseTextEffect sets the note's base text. */
export const baseTextEffect = StateEffect.define<string | undefined>();

/** baseSourceEffect sets what the base text is. */
export const baseSourceEffect = StateEffect.define<BaseSource>();

/** baseSource is what the note's base text is; HEAD until told otherwise. */
export const baseSource = StateField.define<BaseSource>({
    create: () => HEAD,
    update: (src, tr) => {
        for (const e of tr.effects) if (e.is(baseSourceEffect)) return e.value;
        return src;
    },
});

/** debouncedHunksEffect delivers a debounced diff for one document revision. */
export const debouncedHunksEffect = StateEffect.define<{
    result: ComputedHunks;
    revision: object;
}>();

/** DEBOUNCE_MS delays the diff after a large edit or on a slow note. */
const DEBOUNCE_MS = 1000;

export const hunksState: StateField<HunksData | undefined> = StateField.define<
    HunksData | undefined
>({
    create: () => undefined,
    update: (previous, tr) => {
        const data: HunksData = previous
            ? { ...previous }
            : {
                  base: undefined,
                  hunks: [],
                  chunks: undefined,
                  changeDesc: undefined,
                  isDirty: false,
                  maxDiffTimeMs: 0,
              };
        let newBase = false;
        for (const effect of tr.effects) {
            if (effect.is(baseTextEffect)) {
                newBase = previous?.base !== effect.value;
                data.base = effect.value;
                if (newBase) {
                    data.chunks = undefined;
                    data.changeDesc = undefined;
                }
            }
            if (effect.is(debouncedHunksEffect)) {
                const revision = tr.startState.field(
                    debouncer,
                    false,
                )?.revision;
                if (effect.value.revision !== revision) continue;
                apply(data, effect.value.result);
            }
        }
        if (tr.docChanged) {
            // Composable only while both describe one document history.
            if (
                data.changeDesc !== undefined &&
                data.changeDesc.newLength !== tr.changes.length
            ) {
                data.chunks = undefined;
                data.changeDesc = tr.changes.desc;
            } else {
                data.changeDesc =
                    data.changeDesc?.composeDesc(tr.changes.desc) ??
                    tr.changes.desc;
            }
        }
        if (data.base === undefined) {
            data.hunks = [];
            data.chunks = undefined;
            data.changeDesc = undefined;
            data.isDirty = false;
            return data;
        }
        if (newBase || tr.docChanged) {
            data.isDirty = true;
            const res = schedule(tr, data);
            if (res !== undefined) apply(data, res);
        }
        return data;
    },
});

/** apply stores a diff result, ending the dirty state. */
function apply(data: HunksData, res: ComputedHunks): void {
    data.hunks = res.hunks;
    data.chunks = res.chunks;
    data.changeDesc = undefined;
    data.isDirty = false;
    data.maxDiffTimeMs = Math.max(0.95 * data.maxDiffTimeMs, res.diffDuration);
}

/** compute diffs the state's document against `base`, timing it. */
function compute(
    state: EditorState,
    base: string,
    chunks: readonly Chunk[] | undefined,
    changes: ChangeDesc | undefined,
): ComputedHunks {
    const start = performance.now();
    const res = computeHunks(base, state.doc.toString(), chunks, changes);
    return { ...res, diffDuration: performance.now() - start };
}

/**
 * schedule diffs now, or — for an edit over 1000 characters, or a note whose
 * diffs took over a frame — hands the diff to the debouncer and returns
 * undefined.
 */
function schedule(tr: Transaction, data: HunksData): ComputedHunks | undefined {
    const base = data.base ?? "";
    const size = Math.abs(tr.changes.length - tr.changes.newLength);
    if (size > 1000 || data.maxDiffTimeMs > 16) {
        const d = tr.state.field(debouncer);
        d.run({
            state: tr.state,
            base,
            chunks: data.chunks,
            changes: data.changeDesc,
            revision: d.revision,
        });
        return undefined;
    }
    return compute(tr.state, base, data.chunks, data.changeDesc);
}

/** DebounceJob is one deferred diff. */
interface DebounceJob {
    state: EditorState;
    base: string;
    chunks: readonly Chunk[] | undefined;
    changes: ChangeDesc | undefined;
    revision: object;
}

/** DebouncerData is the per-editor debouncer and the document revision. */
interface DebouncerData {
    run: Debouncer<[DebounceJob], void>;
    /** Replaced on every edit, so a diff of an older revision is dropped. */
    revision: object;
}

const debouncer = StateField.define<DebouncerData>({
    create: () => ({
        run: debounce(
            (job: DebounceJob) => {
                const view = job.state.field(editorEditorField, false);
                if (view === undefined) return;
                if (
                    view.state.field(debouncer, false)?.revision !==
                    job.revision
                ) {
                    return;
                }
                view.dispatch({
                    effects: debouncedHunksEffect.of({
                        result: compute(
                            job.state,
                            job.base,
                            job.chunks,
                            job.changes,
                        ),
                        revision: job.revision,
                    }),
                });
            },
            DEBOUNCE_MS,
            true,
        ),
        revision: {},
    }),
    update: (data, tr) => (tr.docChanged ? { ...data, revision: {} } : data),
});

/** hunksExtensions are the state fields the change bars need. */
export const hunksExtensions = [hunksState, baseSource, debouncer];
