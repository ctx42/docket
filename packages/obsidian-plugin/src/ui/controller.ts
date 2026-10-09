// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The plugin's run controller: it owns every pull, push, discard, publish,
// status check, and status apply, so commands, menus, the panel, and the status bar share one
// busy flag, one live RunState, and one last status report. Runs happen in the
// background — nothing here reveals the panel unless the user must look (a
// failure or a conflict); the push review is a modal. Subscribers re-render on
// every change. This is obsidian glue; the logic it calls lives in
// operations.ts, review.ts, run-state.ts, and summary.ts.

import {
    type Choice,
    describeHolder,
    overwrites,
    type PreflightEntry,
    type PublishPlan,
    pageName,
    planPublish,
    publish,
    type RemoteBody,
    RunLockError,
    type StatusReport,
} from "@docket/core";
import { type App, MarkdownView, Notice } from "obsidian";
import type docketPlugin from "../main.ts";
import { buildRuntime, type PluginRuntime } from "../runtime.ts";
import { confirmModal } from "./confirm.ts";
import {
    applyStatus,
    markNever,
    preflight,
    pullNotes,
    pullVault,
    pushSelected,
    type Target,
    vaultStatus,
} from "./operations.ts";
import { reviewPush } from "./push-modal.ts";
import { ACTION_DONE, reviewModel } from "./review.ts";
import { PanelReporter, type RunState } from "./run-state.ts";
import { needsAttention, needsSettings, runSummary } from "./summary.ts";

/** PullTarget is what a pull covers: the whole vault or the given notes. */
export type PullTarget = { kind: "vault" } | { kind: "notes"; dests: string[] };

/** StatusSnapshot is the last status report and when it was taken (epoch ms). */
export interface StatusSnapshot {
    report: StatusReport;
    /** The remote body (or why there is none) of each changed note, by path. */
    bodies: Map<string, RemoteBody>;
    at: number;
}

/** RESULT_NOTICE_MS keeps an end-of-run notice up long enough to click it. */
const RESULT_NOTICE_MS = 8000;

export class SyncController {
    private busyFlag = false;
    /** busyWhat names the in-flight operation for the "already running" notice. */
    private busyWhat = "";
    private runState: RunState | null = null;
    private statusSnap: StatusSnapshot | null = null;
    private readonly listeners = new Set<() => void>();

    constructor(
        private readonly app: App,
        private readonly plugin: docketPlugin,
    ) {}

    /** subscribe calls `fn` on every change and returns its unsubscriber. */
    subscribe(fn: () => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    /** busy reports whether a run or a pre-flight is in flight. */
    get busy(): boolean {
        return this.busyFlag;
    }

    /** activity names the in-flight operation (e.g. "pull", "status check"). */
    get activity(): string {
        return this.busyWhat;
    }

    /** touch re-renders every subscriber, e.g. after the settings changed. */
    touch(): void {
        this.emit();
    }

    /** run is the in-flight or last finished run, or null before the first. */
    get run(): RunState | null {
        return this.runState;
    }

    /** status is the last status report, or null before the first check. */
    get status(): StatusSnapshot | null {
        return this.statusSnap;
    }

    /** pull pulls the target, merging remote changes into local edits. */
    async pull(target: PullTarget): Promise<void> {
        await this.execute("pulling", async (rt, reporter) => {
            if (target.kind === "notes") {
                const out = await pullNotes(rt, reporter, target.dests);
                for (const e of out.errors) reporter.fail(e);
                reporter.setTally(out.tally, out.errors.length);
                return;
            }
            const outcome = await pullVault(rt, reporter);
            for (const e of outcome.errors) reporter.fail(e);
            const s = outcome.stats;
            reporter.setTally(
                {
                    added: s.added,
                    updated: s.updated,
                    unchanged: s.unchanged,
                    conflict: s.conflict,
                    deleted: s.deleted,
                },
                outcome.errors.length,
            );
        });
    }

    /** discard rewrites each note from Confluence, after the user confirms. */
    async discard(dests: string[]): Promise<void> {
        if (this.refuseBusy() || dests.length === 0) return;
        const root = this.plugin.settings.syncRoot;
        const yes = await confirmModal(
            this.app,
            "Discard local changes?",
            dests.length === 1
                ? "This note will be replaced by its Confluence version. Your local edits will be lost:"
                : "These notes will be replaced by their Confluence versions. Your local edits will be lost:",
            dests.map((d) => pageName(root, d)),
            "Discard",
        );
        if (!yes) return;
        await this.execute("discarding", async (rt, reporter) => {
            const out = await pullNotes(rt, reporter, dests, true);
            for (const e of out.errors) reporter.fail(e);
            reporter.setTally(out.tally, out.errors.length);
        });
    }

    /**
     * push pre-flights the target, opens the review, and pushes what the user
     * picks under a fresh run. The pre-flight holds the busy flag; the review
     * does not, so a run started meanwhile makes the commit refuse.
     */
    async push(target: Target): Promise<void> {
        if (this.refuseBusy()) return;
        await this.saveEditors();
        const rt = this.runtime();
        if (rt === null) return;
        this.setBusy(true, "push check");
        let entries: PreflightEntry[];
        try {
            entries = await rt.withLock("push preflight", () =>
                preflight(rt, target),
            );
        } catch (err) {
            this.setBusy(false);
            this.fail(err);
            return;
        }
        this.setBusy(false);
        if (reviewModel(entries).rows.length === 0) {
            new Notice("docket: nothing to push");
            return;
        }
        const choice = await reviewPush(this.app, entries);
        if (choice === null) return;
        await this.execute("pushing", async (rt, reporter) => {
            await markNever(rt, choice.never);
            const outcome = await pushSelected(rt, reporter, choice.push);
            for (const e of outcome.errors) reporter.fail(e);
            reporter.setCounts({
                ok: outcome.pushed,
                warn: outcome.unchanged,
                err: outcome.errors.length,
            });
        });
    }

    /**
     * publish makes the page of the note `dest` visible to others: it plans
     * which author-only restrictions to lift (the page and the author-only
     * folders directly above it), confirms them in a dialog, and clears them under a
     * fresh run. A page restricted to anyone else is refused by the plan.
     */
    async publish(dest: string): Promise<void> {
        if (this.refuseBusy()) return;
        const rt = this.runtime();
        if (rt === null) return;
        this.setBusy(true, "publish check");
        let plan: PublishPlan;
        try {
            plan = await planPublish(rt, dest);
        } catch (err) {
            this.setBusy(false);
            this.fail(err);
            return;
        }
        this.setBusy(false);
        const name = pageName(this.plugin.settings.syncRoot, dest);
        const warn = plan.warning === "" ? "" : ` (${plan.warning})`;
        if (plan.items.length === 0) {
            new Notice(`docket: ${name} is already published${warn}`);
            return;
        }
        const yes = await confirmModal(
            this.app,
            "Publish to Confluence?",
            "Your restriction will be lifted from these, making them visible " +
                "to everyone with access to the space:",
            plan.items.map((i) => `${i.kind} "${i.title}"`),
            "Publish",
        );
        if (!yes) return;
        await this.execute("publishing", async (rt, reporter) => {
            const cleared = await publish(rt.client, plan);
            for (const i of cleared) {
                reporter.log(`${i.kind} "${i.title}" is now visible`);
            }
            if (plan.warning !== "") {
                reporter.log(`warning: ${plan.warning}`);
            }
            reporter.setCounts({ ok: cleared.length, warn: 0, err: 0 });
        });
    }

    /**
     * checkStatus collects the whole vault's two-way status. `quiet` (a refresh
     * after a run) skips when busy and reports failures only to the console.
     */
    async checkStatus(quiet = false): Promise<void> {
        if (this.busyFlag) {
            if (!quiet) this.refuseBusy();
            return;
        }
        const rt = quiet ? this.quietRuntime() : this.runtime();
        if (rt === null) return;
        this.setBusy(true, "status check");
        try {
            const { report, bodies } = await rt.withLock("status", () =>
                vaultStatus(rt),
            );
            this.statusSnap = { report, bodies, at: Date.now() };
        } catch (err) {
            if (quiet) {
                console.error("docket: refreshing status failed", err);
            } else {
                this.fail(err);
            }
        }
        this.setBusy(false);
    }

    /** apply runs the chosen status-row actions, confirming discards first. */
    async apply(choices: Choice[]): Promise<void> {
        if (this.refuseBusy()) return;
        const chosen = choices.filter((c) => c.action !== "skip");
        if (chosen.length === 0) return;
        const lose = overwrites(chosen).map((r) => r.name);
        if (
            lose.length > 0 &&
            !(await confirmModal(
                this.app,
                "Discard local changes?",
                "These notes will be replaced by their Confluence versions. Your local edits will be lost:",
                lose,
                "Discard",
            ))
        ) {
            return;
        }
        await this.execute("applying", async (rt, reporter) => {
            reporter.discovered(chosen.length);
            const results = await applyStatus(rt, reporter, chosen);
            let ok = 0;
            for (const r of results) {
                const line = `${ACTION_DONE[r.action]} ${r.name} (${r.detail})`;
                if (r.ok) {
                    ok++;
                    reporter.log(line);
                } else {
                    reporter.fail(line);
                }
            }
            reporter.setCounts({ ok, warn: 0, err: results.length - ok });
        });
    }

    /**
     * execute runs one operation under a fresh reporter and the run lock, saving
     * open editors first so a pending autosave is neither lost nor written over
     * the result. A finished run ends in one summary notice (click: open the
     * panel), opens the panel itself when the run needs attention, and refreshes
     * a status report already on screen.
     */
    private async execute(
        verb: string,
        op: (rt: PluginRuntime, reporter: PanelReporter) => Promise<void>,
    ): Promise<void> {
        if (this.refuseBusy()) return;
        await this.saveEditors();
        const rt = this.runtime();
        if (rt === null) return;
        this.setBusy(true, verb);
        const reporter = new PanelReporter(verb, (s) => {
            this.runState = s;
            this.emit();
        });
        this.runState = reporter.state(); // the panel shows this run, not the last
        this.emit();
        try {
            await rt.withLock(verb, () => op(rt, reporter));
            reporter.finish();
        } catch (err) {
            if (err instanceof RunLockError) {
                this.setBusy(false);
                this.fail(err);
                return;
            }
            // Finish into the error phase rather than dropping the run: it
            // keeps the log of the pages that already succeeded.
            reporter.error(message(err));
        }
        this.setBusy(false);
        const state = reporter.state();
        this.announce(state);
        if (needsAttention(state)) void this.plugin.activateView();
        if (this.statusSnap !== null) await this.checkStatus(true);
    }

    /** announce shows a finished run's summary as a notice that opens the panel. */
    private announce(state: RunState): void {
        const text = runSummary(state);
        if (state.phase === "error" && needsSettings(state.errorText)) {
            this.settingsNotice(text);
            return;
        }
        const n = new Notice(`docket: ${text}`, RESULT_NOTICE_MS);
        n.messageEl.addClass("docket-notice-link");
        n.messageEl.onclick = () => void this.plugin.activateView();
    }

    /** fail reports a failure that ended an operation before a run started. */
    private fail(err: unknown): void {
        if (err instanceof RunLockError) {
            new Notice(
                `docket: busy: ${describeHolder(err.holder)}. Try again when it finishes.`,
            );
            return;
        }
        const msg = message(err);
        if (needsSettings(msg)) {
            this.settingsNotice(msg);
            return;
        }
        new Notice(`docket: ${msg}`);
    }

    /** settingsNotice shows `text` with an action that opens the settings tab. */
    private settingsNotice(text: string): void {
        const frag = createFragment((f) => {
            f.createSpan({ text: `docket: ${text} ` });
            f.createEl("a", { text: "Open settings", href: "#" });
        });
        const n = new Notice(frag, 0);
        n.messageEl.onclick = (e) => {
            e.preventDefault();
            n.hide();
            this.plugin.openSettings();
        };
    }

    /** runtime builds the run's runtime, reporting an invalid config. */
    private runtime(): PluginRuntime | null {
        try {
            return buildRuntime(
                this.app,
                this.plugin.settings,
                this.plugin.token,
            );
        } catch (err) {
            this.fail(err);
            return null;
        }
    }

    /** quietRuntime is {@link runtime} without the notice. */
    private quietRuntime(): PluginRuntime | null {
        try {
            return buildRuntime(
                this.app,
                this.plugin.settings,
                this.plugin.token,
            );
        } catch {
            return null;
        }
    }

    /** refuseBusy blocks a second operation while one runs, saying which. */
    private refuseBusy(): boolean {
        if (!this.busyFlag) return false;
        new Notice(`docket: wait for the ${this.busyWhat} to finish`);
        return true;
    }

    /** saveEditors flushes every open Markdown editor to disk. */
    private async saveEditors(): Promise<void> {
        for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
            const v = leaf.view;
            if (v instanceof MarkdownView && v.file !== null) await v.save();
        }
    }

    private setBusy(busy: boolean, what = ""): void {
        this.busyFlag = busy;
        this.busyWhat = busy ? what.replace(/ing$/, "") : "";
        this.emit();
    }

    private emit(): void {
        for (const fn of this.listeners) fn();
    }
}

/** message returns an unknown thrown value's message. */
function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
