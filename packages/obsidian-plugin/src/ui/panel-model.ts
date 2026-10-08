// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The dock panel's render decisions that are not DOM: which first-run step to
// show, the note card's detail line and button order, the progress bar's fill,
// a changes group's bulk action, a change row's tooltip, how a log line links
// its note, and whether a log follows its newest line. It is obsidian-free, so
// it unit-tests; the panel modules (view.ts, sync-*.ts, mcp-tab.ts) draw it.

import type { RemoteBody } from "@docket/core";
import type { docketSettings } from "../settings/model.ts";
import type { NoteAction } from "./note-actions.ts";
import type { ChangeGroupId } from "./review.ts";

/** SetupStep is the first-run step the Sync tab shows instead of its sections. */
export interface SetupStep {
    icon: string;
    text: string;
    cta: string;
    /** Whether the button adds a location rather than opening the settings. */
    addLocation: boolean;
}

/**
 * setupStep returns the first-run step still open — connect, then add a
 * location — or null once the vault is connected and has a location.
 */
export function setupStep(s: docketSettings, token: string): SetupStep | null {
    if (s.site === "" || s.account === "" || token === "") {
        return {
            icon: "plug",
            text: "Connect docket to your Confluence site to start syncing pages.",
            cta: "Connect to Confluence",
            addLocation: false,
        };
    }
    const count =
        Object.keys(s.pages).length +
        Object.keys(s.folders).length +
        Object.keys(s.spaces).length;
    if (count === 0) {
        return {
            icon: "file-plus",
            text: "Choose the Confluence pages, folders, or spaces to sync into this vault.",
            cta: "Add a location",
            addLocation: true,
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
