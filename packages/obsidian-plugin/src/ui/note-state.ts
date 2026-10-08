// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The panel's "this note" card model: what one note's sync state is, worded for
// the user, and which action fits it best. It reads the note's frontmatter, a
// conflict-marker check, and the last status report — never the network — so it
// unit-tests on plain values.

import { parseMeta, type StatusReport } from "@docket/core";
import { type NoteAction, noteActions } from "./note-actions.ts";

/** NoteStateKind classifies one note for the card's icon and colour. */
export type NoteStateKind =
    | "unsynced"
    | "new"
    | "conflict"
    | "edited"
    | "incoming"
    | "diverged"
    | "refused"
    | "unchecked"
    | "ignored"
    | "synced"
    | "unknown";

/** NoteFacts are what the card knows about the active note. */
export interface NoteFacts {
    dest: string;
    /** The parsed frontmatter, or undefined when the note has none. */
    fm: unknown;
    /** Whether the note lies under the sync root (a push candidate when new). */
    inSyncRoot: boolean;
    /** Whether the note carries unresolved conflict markers. */
    conflicts: boolean;
    /** The note's last modification time (epoch ms). */
    mtime: number;
    /** The last status report and when it was taken, or null. */
    status: { report: StatusReport; at: number } | null;
}

/** NoteState is the card's render model. */
export interface NoteState {
    kind: NoteStateKind;
    /** The one-line state, e.g. "Local edits". */
    label: string;
    /** A muted second line: versions, a reason, or a hint; may be empty. */
    detail: string;
    /** The page version the note is based on, or 0. */
    version: number;
    /** The actions the note offers, in menu order. */
    actions: NoteAction[];
    /** The action the state calls for, shown as the card's main button. */
    primary: NoteAction | null;
}

/**
 * noteState works out the card for one note. Local facts win over the status
 * report — conflict markers first — and the report decides the rest; a note
 * edited after the report was taken is shown as such rather than up to date.
 */
export function noteState(f: NoteFacts): NoteState {
    const meta = parseMeta(f.fm ?? {});
    const actions = noteActions(f.fm);
    const base = { version: meta.pageVersion, actions };
    const make = (
        kind: NoteStateKind,
        label: string,
        detail: string,
        primary: NoteAction | null = null,
    ): NoteState => ({
        kind,
        label,
        detail,
        primary: primary !== null && actions.includes(primary) ? primary : null,
        ...base,
    });

    if (meta.pageId === "") {
        if (f.inSyncRoot && meta.title !== "" && !meta.ignorePush) {
            return make("new", "New page", "Push to create it on Confluence");
        }
        return make("unsynced", "Not synced with Confluence", "");
    }
    if (f.conflicts) {
        return make(
            "conflict",
            "Unresolved conflicts",
            "Resolve the <<<<<<< markers, then push",
        );
    }

    const r = f.status?.report;
    const push = r?.push.find((e) => e.dest === f.dest);
    if (push !== undefined) {
        if (push.cls === "refused") {
            return make("refused", "Push refused", push.reason, "discard");
        }
        return make(
            "edited",
            "Local edits",
            `Based on v${push.localBase}`,
            "push",
        );
    }
    const pull = r?.pull.find((e) => e.dest === f.dest);
    if (pull !== undefined) {
        return make(
            "incoming",
            "Newer version on Confluence",
            `v${pull.localBase} → v${pull.remoteVersion}`,
            "pull",
        );
    }
    const both = r?.diverged.find((e) => e.dest === f.dest);
    if (both !== undefined) {
        return make(
            "diverged",
            "Changed on both sides",
            `Local v${both.localBase}, remote v${both.remoteVersion}; push merges them`,
            "push",
        );
    }
    const warn = r?.warnings.find((e) => e.dest === f.dest);
    if (warn !== undefined) {
        return make("unchecked", "Couldn't check", warn.reason);
    }
    if (meta.ignorePush) {
        return make("ignored", "Ignored by push", "Pull still updates it");
    }
    if (f.status === null) {
        return make(
            "unknown",
            "Synced",
            "Check status to compare with Confluence",
        );
    }
    if (f.mtime > f.status.at) {
        return make(
            "unknown",
            "Edited since the last check",
            "Check status to compare with Confluence",
        );
    }
    return make("synced", "Up to date", "");
}
