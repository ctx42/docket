// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The pure model behind the panel's push review and status view: which
// preflight entries a review lists and how each row behaves, and how a status
// report splits into the view's sections. view.ts only draws what these return.

import {
    type PreflightEntry,
    pageName,
    type RowAction,
    type StatusReport,
    type StatusRow,
    statusRows,
} from "@docket/core";

/**
 * ReviewRow is one push-review row. A `pick` row is a checkbox (ticked by
 * default); a `new` row offers later / create / never, starting at later; a
 * `locked` row (refused, or not checkable) is shown but cannot be chosen.
 */
export interface ReviewRow {
    entry: PreflightEntry;
    control: "pick" | "new" | "locked";
    /** The row's style: `info`, `warn` (diverged), or `err` (refused, skipped). */
    kind: "info" | "warn" | "err";
    /** The one-line note under the page name. */
    note: string;
}

/** ReviewModel is the rows a push review lists plus the count it hides. */
export interface ReviewModel {
    rows: ReviewRow[];
    /** Notes left out because a push would not change their page. */
    hidden: number;
}

/**
 * reviewModel builds the push review from a preflight. A note whose push would
 * change nothing — `unchanged`, or `remote-moved` with no local change — is
 * hidden and only counted. Modified and diverged notes are ticked by default
 * (a diverged push three-way-merges, or is refused on a real conflict); new
 * notes start at "later"; refused and skipped notes are locked.
 */
export function reviewModel(entries: PreflightEntry[]): ReviewModel {
    const rows: ReviewRow[] = [];
    let hidden = 0;
    for (const e of entries) {
        switch (e.cls) {
            case "unchanged":
            case "remote-moved":
                hidden++;
                break;
            case "modified":
                rows.push({
                    entry: e,
                    control: "pick",
                    kind: "info",
                    note: `Local edits on v${e.localBase}`,
                });
                break;
            case "diverged":
                rows.push({
                    entry: e,
                    control: "pick",
                    kind: "warn",
                    note:
                        `Changed on both sides (local v${e.localBase}, ` +
                        `remote v${e.remoteVersion}); push merges them`,
                });
                break;
            case "new":
                rows.push({
                    entry: e,
                    control: "new",
                    kind: "info",
                    note: "New page, not on Confluence yet",
                });
                break;
            case "refused":
                rows.push({
                    entry: e,
                    control: "locked",
                    kind: "err",
                    note: `Refused: ${e.reason}`,
                });
                break;
            case "skip":
                rows.push({
                    entry: e,
                    control: "locked",
                    kind: "err",
                    note: `Not checked: ${e.reason}`,
                });
                break;
        }
    }
    return { rows, hidden };
}

/** NewChoice is a new note's review answer. */
export type NewChoice = "later" | "create" | "never";

/**
 * reviewCommit splits the review's answers into the dests to push (ticked rows
 * and new notes marked create) and the new notes to mark never.
 */
export function reviewCommit(
    picked: Set<string>,
    answers: Map<string, NewChoice>,
): { push: string[]; never: string[] } {
    const push = [...picked];
    const never: string[] = [];
    for (const [dest, choice] of answers) {
        if (choice === "create") push.push(dest);
        if (choice === "never") never.push(dest);
    }
    return { push, never };
}

/** StatusLine is one row of a status-view section. */
export interface StatusLine {
    /** The syncRoot-relative page name. */
    name: string;
    /** The status word: new, modified, refused, remote, diverged, ignored, or warning. */
    word: string;
    /** The detail after the name: versions or a reason; may be empty. */
    detail: string;
}

/** StatusSection is one collapsible group of the status view. */
export interface StatusSection {
    title: string;
    lines: StatusLine[];
}

/**
 * statusSections splits a status report into the view's sections — To push, To
 * pull, Diverged, Ignored (only with `showIgnored`), and Could not check — in
 * that order, omitting empty ones. It mirrors the CLI `status` layout.
 */
export function statusSections(
    r: StatusReport,
    syncRoot: string,
    showIgnored: boolean,
): StatusSection[] {
    const versions = (e: PreflightEntry): string =>
        `local v${e.localBase} → remote v${e.remoteVersion}`;
    const sections: StatusSection[] = [
        {
            title: "To push",
            lines: r.push.map((e) => ({
                name: e.name,
                word: e.cls,
                detail: e.cls === "refused" ? e.reason : "",
            })),
        },
        {
            title: "To pull",
            lines: r.pull.map((e) => ({
                name: e.name,
                word: "remote",
                detail: versions(e),
            })),
        },
        {
            title: "Diverged",
            lines: r.diverged.map((e) => ({
                name: e.name,
                word: "diverged",
                detail: `${versions(e)}, local edits`,
            })),
        },
        {
            title: "Ignored",
            lines: showIgnored
                ? r.ignored.map((dest) => ({
                      name: pageName(syncRoot, dest),
                      word: "ignored",
                      detail: "",
                  }))
                : [],
        },
        {
            title: "Could not check",
            lines: r.warnings.map((e) => ({
                name: e.name,
                word: "warning",
                detail: e.reason,
            })),
        },
    ];
    return sections.filter((s) => s.lines.length > 0);
}

/**
 * statusText renders the status sections as plain text for the clipboard, one
 * `Title (n):` heading per section and one `  word  name  detail` line per row,
 * sections separated by a blank line — the layout `docket status` prints.
 */
export function statusText(sections: StatusSection[]): string {
    return sections
        .map((s) => {
            const rows = s.lines.map((l) =>
                [`  ${l.word}`, l.name, l.detail]
                    .filter((part) => part !== "")
                    .join("  "),
            );
            return `${s.title} (${s.lines.length}):\n${rows.join("\n")}\n`;
        })
        .join("\n");
}

/** ACTION_TEXT labels each status-row action in the plugin's own words. */
export const ACTION_TEXT: Record<RowAction, string> = {
    skip: "Skip",
    create: "Create page",
    never: "Never push",
    push: "Push",
    pull: "Pull",
    overwrite: "Discard local changes",
    unignore: "Stop ignoring",
};

/** ACTION_ICON is each status-row action's Lucide icon. */
export const ACTION_ICON: Record<RowAction, string> = {
    skip: "minus",
    create: "file-plus",
    never: "eye-off",
    push: "arrow-up",
    pull: "arrow-down",
    overwrite: "rotate-ccw",
    unignore: "eye",
};

/**
 * ACTION_DONE is each action's one-word past tense, the lead word of an applied
 * row's log line (so the log's name extraction still reads it).
 */
export const ACTION_DONE: Record<RowAction, string> = {
    skip: "skipped",
    create: "created",
    never: "ignored",
    push: "pushed",
    pull: "pulled",
    overwrite: "discarded",
    unignore: "unignored",
};

/** ChangeGroupId names one group of the panel's changes list. */
export type ChangeGroupId =
    | "conflicts"
    | "outgoing"
    | "new"
    | "incoming"
    | "diverged"
    | "problems"
    | "ignored";

/** ChangeRow is one note in a changes group. */
export interface ChangeRow {
    dest: string;
    name: string;
    /** A short detail after the name: versions or a reason; may be empty. */
    detail: string;
    /** The actionable status row, or null for a note that could not be checked. */
    row: StatusRow | null;
}

/** ChangeGroup is one collapsible group of the changes list. */
export interface ChangeGroup {
    id: ChangeGroupId;
    title: string;
    rows: ChangeRow[];
}

/** CONFLICT_REASON matches a refusal caused by unresolved conflict markers. */
const CONFLICT_REASON = /conflict markers/;

/**
 * changeGroups splits a status report into the changes list's groups, in the
 * order the user acts on them — Conflicts, Outgoing, New, Incoming, Diverged,
 * Problems, then Ignored (only with `showIgnored`) — omitting empty ones. A
 * refusal for unresolved conflict markers is a conflict; any other refusal and
 * every note that could not be checked is a problem.
 */
export function changeGroups(
    r: StatusReport,
    syncRoot: string,
    showIgnored: boolean,
): ChangeGroup[] {
    const rows = new Map(statusRows(r, syncRoot).map((x) => [x.dest, x]));
    const groups: Record<ChangeGroupId, ChangeRow[]> = {
        conflicts: [],
        outgoing: [],
        new: [],
        incoming: [],
        diverged: [],
        problems: [],
        ignored: [],
    };
    const add = (
        id: ChangeGroupId,
        e: PreflightEntry,
        detail: string,
    ): void => {
        groups[id].push({
            dest: e.dest,
            name: e.name,
            detail,
            row: rows.get(e.dest) ?? null,
        });
    };
    for (const e of r.push) {
        if (e.cls === "new") add("new", e, "");
        else if (e.cls === "refused") {
            add(
                CONFLICT_REASON.test(e.reason) ? "conflicts" : "problems",
                e,
                e.reason,
            );
        } else add("outgoing", e, `local edits on v${e.localBase}`);
    }
    for (const e of r.pull) {
        add("incoming", e, `v${e.localBase} → v${e.remoteVersion}`);
    }
    for (const e of r.diverged) {
        add("diverged", e, `local v${e.localBase}, remote v${e.remoteVersion}`);
    }
    for (const e of r.warnings) add("problems", e, e.reason);
    if (showIgnored) {
        for (const dest of r.ignored) {
            groups.ignored.push({
                dest,
                name: pageName(syncRoot, dest),
                detail: "",
                row: rows.get(dest) ?? null,
            });
        }
    }
    const titles: Record<ChangeGroupId, string> = {
        conflicts: "Conflicts",
        outgoing: "Outgoing",
        new: "New",
        incoming: "Incoming",
        diverged: "Changed on both sides",
        problems: "Problems",
        ignored: "Ignored",
    };
    return (Object.keys(groups) as ChangeGroupId[])
        .filter((id) => groups[id].length > 0)
        .map((id) => ({ id, title: titles[id], rows: groups[id] }));
}
