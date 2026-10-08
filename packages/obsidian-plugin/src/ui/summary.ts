// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Short worded summaries of a run and a status report: the end-of-run notice,
// the panel's result line, and the status-bar item all read these. Obsidian-free
// so it unit-tests directly.

import type { StatusReport } from "@docket/core";
import type { RunState } from "./run-state.ts";

/** SummaryKind styles one summary part (it matches a log-row kind). */
export type SummaryKind =
    | "added"
    | "updated"
    | "unchanged"
    | "deleted"
    | "conflict"
    | "ok"
    | "warn"
    | "err";

/** SummaryPart is one counted outcome of a run, e.g. `2 updated`. */
export interface SummaryPart {
    kind: SummaryKind;
    count: number;
    label: string;
}

/** DONE names each run verb's finished form, for the summary's lead word. */
const DONE: Record<string, string> = {
    pulling: "Pulled",
    pushing: "Pushed",
    discarding: "Discarded local changes",
    applying: "Applied",
};

/**
 * summaryParts lists a finished run's non-zero outcomes in reading order: a
 * pull's added/updated/deleted/conflict/unchanged plus failures, an apply's
 * applied/failed, a push's pushed/unchanged/refused.
 */
export function summaryParts(s: RunState): SummaryPart[] {
    const parts: SummaryPart[] = [];
    const add = (kind: SummaryKind, count: number, label: string): void => {
        if (count > 0) parts.push({ kind, count, label });
    };
    if (s.tally !== null) {
        const t = s.tally;
        add("added", t.added, "added");
        add("updated", t.updated, "updated");
        add("deleted", t.deleted, "deleted");
        add(
            "conflict",
            t.conflict,
            t.conflict === 1 ? "conflict" : "conflicts",
        );
        add("unchanged", t.unchanged, "unchanged");
        add("err", s.counts.err, "failed");
    } else if (s.verb === "applying") {
        add("ok", s.counts.ok, "applied");
        add("err", s.counts.err, "failed");
    } else {
        add("ok", s.counts.ok, "pushed");
        add("unchanged", s.counts.warn, "unchanged");
        add("err", s.counts.err, "refused");
    }
    return parts;
}

/**
 * runSummary is a finished run's one-line notice text, e.g.
 * `Pulled: 2 updated · 1 conflict · 9 unchanged`, or the failure for a run that
 * ended in error.
 */
export function runSummary(s: RunState): string {
    const lead = DONE[s.verb] ?? s.verb;
    if (s.phase === "error") {
        return `${lead.split(" ")[0]} failed: ${s.errorText || "unknown error"}`;
    }
    const parts = summaryParts(s).map((p) => `${p.count} ${p.label}`);
    return parts.length === 0
        ? `${lead}: nothing to do`
        : `${lead}: ${parts.join(" · ")}`;
}

/**
 * needsAttention reports whether a finished run left something the user must
 * look at — a failure, a refusal, or a conflict — so the panel opens itself.
 */
export function needsAttention(s: RunState): boolean {
    return (
        s.phase === "error" ||
        s.counts.err > 0 ||
        (s.tally !== null && s.tally.conflict > 0)
    );
}

/** StatusCounts are a status report's actionable totals. */
export interface StatusCounts {
    push: number;
    pull: number;
    diverged: number;
    problems: number;
}

/** statusCounts totals a status report's sections. */
export function statusCounts(r: StatusReport): StatusCounts {
    return {
        push: r.push.length,
        pull: r.pull.length,
        diverged: r.diverged.length,
        problems: r.warnings.length,
    };
}

/**
 * barText is the status-bar item's text: progress while a run is in flight
 * (`3/12`, or `…` while discovering), else the last status report's counts
 * (`↑2 ↓1 ⇅1`, or `✓` when everything is up to date), else empty.
 */
export function barText(
    run: RunState | null,
    busy: boolean,
    report: StatusReport | null,
): string {
    if (busy) {
        if (run === null || run.phase === "discovering") return "…";
        return `${run.pos}/${run.total}`;
    }
    if (report === null) return "";
    const c = statusCounts(report);
    const parts = [
        c.push > 0 ? `↑${c.push}` : "",
        c.pull > 0 ? `↓${c.pull}` : "",
        c.diverged > 0 ? `⇅${c.diverged}` : "",
        c.problems > 0 ? `!${c.problems}` : "",
    ].filter((p) => p !== "");
    return parts.length === 0 ? "✓" : parts.join(" ");
}

/**
 * needsSettings reports whether an error message means the credentials or the
 * settings are wrong — a rejected login or an invalid config — so its notice offers
 * to open the settings.
 */
export function needsSettings(msg: string): boolean {
    return /^config: |authentication rejected|HTTP 40[13]\b/.test(msg);
}

/** ago renders the age of `at` (epoch ms) relative to `now`, e.g. `3 min ago`. */
export function ago(at: number, now: number): string {
    const s = Math.max(0, Math.round((now - at) / 1000));
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    return `${Math.round(h / 24)} d ago`;
}
