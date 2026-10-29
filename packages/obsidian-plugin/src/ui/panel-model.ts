// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The dock panel's render decisions that are not DOM: which first-run step to
// show, the note card's detail line and button order, the progress bar's fill,
// a changes group's bulk action, a change row's tooltip, how a log line links
// its note, and whether a log follows its newest line. It is obsidian-free, so
// it unit-tests; the panel modules (view.ts, sync-*.ts, mcp-tab.ts) draw it.

import { type RemoteBody, syncFolder } from "@docket/core";
import type { docketSettings } from "../settings/model.ts";
import type { NoteAction } from "./note-actions.ts";
import type { ChangeGroupId } from "./review.ts";

/**
 * SetupAction is what a setup step's button does: open the settings, create
 * the sync folder, add a location, or nothing (the step has no button).
 */
export type SetupAction = "settings" | "folder" | "location" | "none";

/** SetupStep is the first-run step the Sync tab shows instead of its sections. */
export interface SetupStep {
    icon: string;
    text: string;
    /** The button's text; `""` with no button. */
    cta: string;
    action: SetupAction;
}

/** SYNC_FOLDER_SUGGESTION is the sync folder name the setup step suggests. */
export const SYNC_FOLDER_SUGGESTION = "confluence";

/**
 * setupStep returns the first-run step still open — connect, choose the sync
 * folder, then add a location — or null once all three are done. A vault that
 * already syncs pages without a sync folder gets no folder choice: docket
 * never moves files, so the pages must be moved by hand.
 */
export function setupStep(s: docketSettings, token: string): SetupStep | null {
    if (s.site === "" || s.account === "" || token === "") {
        return {
            icon: "plug",
            text: "Connect docket to your Confluence site to start syncing pages.",
            cta: "Connect to Confluence",
            action: "settings",
        };
    }
    const count =
        Object.keys(s.pages).length +
        Object.keys(s.folders).length +
        Object.keys(s.spaces).length;
    if (syncFolder(s.syncRoot) === "") {
        if (count > 0) {
            return {
                icon: "alert-triangle",
                text: 'This vault syncs pages but has no sync folder, so docket does not pull or push. Move the synced pages by hand into one top-level folder, set "syncRoot" in the plugin\'s data.json to it, and reload the plugin.',
                cta: "",
                action: "none",
            };
        }
        return {
            icon: "folder-plus",
            text: "Choose the top-level folder docket syncs Confluence pages into. Docket keeps it in its own git repository, apart from your notes.",
            cta: "Create folder",
            action: "folder",
        };
    }
    if (count === 0) {
        return {
            icon: "file-plus",
            text: "Choose the Confluence pages, folders, or spaces to sync into this vault.",
            cta: "Add a location",
            action: "location",
        };
    }
    return null;
}

/** cardDetail joins a card's detail and its base version, either possibly absent. */
export function cardDetail(detail: string, version: number): string {
    return [detail, version > 0 ? `v${version}` : ""]
        .filter((d) => d !== "")
        .join(" · ");
}

/**
 * cardButtons returns the actions a card shows as buttons: every action but
 * discard (kept for its menu), the primary one first.
 */
export function cardButtons(
    actions: NoteAction[],
    primary: NoteAction | null,
): NoteAction[] {
    const buttons: NoteAction[] = actions.filter((a) => a !== "discard");
    return primary !== null && buttons.includes(primary)
        ? [primary, ...buttons.filter((a) => a !== primary)]
        : buttons;
}

/** progressPercent is a run's completed share, 0–100, or 0 before a total. */
export function progressPercent(pos: number, total: number): number {
    return total > 0 ? Math.min(100, Math.round((pos / total) * 100)) : 0;
}

/** BulkAction is a changes group's header button. */
export interface BulkAction {
    icon: string;
    label: string;
    /** The controller operation the button runs on the group's notes. */
    op: "push" | "pull";
}

/** bulkAction returns a changes group's header button, or null for none. */
export function bulkAction(id: ChangeGroupId): BulkAction | null {
    switch (id) {
        case "outgoing":
        case "diverged":
            return { icon: "arrow-up", label: "Push all…", op: "push" };
        case "new":
            return {
                icon: "file-plus",
                label: "Review new pages…",
                op: "push",
            };
        case "incoming":
            return { icon: "arrow-down", label: "Pull all", op: "pull" };
        default:
            return null;
    }
}

/**
 * changeTooltip is a change row's hover text: its name, its detail, and why
 * it has no Confluence diff when its remote body failed to load.
 */
export function changeTooltip(
    name: string,
    detail: string,
    remote: RemoteBody | null,
): string {
    const tip = [name, detail];
    if (remote !== null && "error" in remote) {
        tip.push(`No Confluence diff: ${remote.error}`);
    }
    return tip.filter((t) => t !== "").join("\n");
}

/**
 * logLink splits a log line around the page name it reports, so the name can
 * link to its note, or returns null when the line does not hold the name.
 */
export function logLink(
    text: string,
    name: string,
): { before: string; after: string } | null {
    const at = text.indexOf(name);
    if (at < 0) return null;
    return { before: text.slice(0, at), after: text.slice(at + name.length) };
}

/** destOf maps a syncRoot-relative page name back to its vault path. */
export function destOf(syncRoot: string, name: string): string {
    return syncRoot === "" || syncRoot === "." ? name : `${syncRoot}/${name}`;
}

/**
 * followsEnd reports whether a log scrolled to `top` sits at its newest line,
 * within a two-pixel tolerance for fractional scroll positions.
 */
export function followsEnd(
    top: number,
    scrollHeight: number,
    clientHeight: number,
): boolean {
    return top >= scrollHeight - clientHeight - 2;
}
