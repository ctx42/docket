// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The plugin's pull/push flow layer, the analog of the CLI's commands.ts. Each
// function assembles the core orchestrators over the runtime and a per-run
// reporter, and returns the core outcome. It is obsidian-free (dests are plain
// vault paths), so it unit-tests with the core's MemFS + QueueHttpClient.

import {
    type ActionResult,
    applyActions,
    type Choice,
    collectStatus,
    MetaCache,
    managedPushDests,
    markIgnorePush,
    openLinkIndex,
    type PageAction,
    type PreflightDeps,
    type PreflightEntry,
    Puller,
    type PullOutcome,
    Pusher,
    type PushOutcome,
    pageLine,
    pageName,
    planCreates,
    posixClean,
    pullConfig,
    pushPreflight,
    type RemoteBody,
    type Reporter,
    remoteBodies,
    resolveFlavor,
    resolvePageSource,
    type StatusReport,
} from "@docket/core";
import type { PluginRuntime } from "../runtime.ts";
import type { PullTally } from "./run-state.ts";

/**
 * Target selects what a pull/push covers: the whole vault, the given notes, or
 * every note under a vault folder (push only; a folder pull is the notes in it).
 */
export type Target =
    | { kind: "vault" }
    | { kind: "notes"; dests: string[] }
    | { kind: "folder"; path: string };

/** NotesOutcome is a multi-note pull's per-action tally and per-note failures. */
export interface NotesOutcome {
    tally: PullTally;
    /** One `<name>: <reason>` line per note that failed. */
    errors: string[];
}

/** toDest cleans an Obsidian active-file path into a core dest path. */
export function toDest(activeFilePath: string): string {
    return posixClean(activeFilePath);
}

/** pullVault pulls every configured page and discovered folder/space page. */
export function pullVault(
    rt: PluginRuntime,
    reporter: Reporter,
): Promise<PullOutcome> {
    return pullConfig({
        client: rt.client,
        fs: rt.fs,
        config: rt.config,
        reporter,
        cacheDir: rt.dirs.cacheDir,
        assetsDir: rt.dirs.assetsDir,
        linksPath: rt.dirs.linksPath,
    });
}

/**
 * pullNotes pulls each managed page in `dests`; with `overwrite` it discards
 * local edits and rewrites each note from Confluence instead of merging. It
 * announces every note up front so the reporter sits in its processing phase
 * throughout — any on-demand root discovery inside resolvePageSource then runs
 * under a steady "pulling <name>" bar, not a discovery counter. One failing
 * note never stops the rest: its reason lands in the outcome's `errors`.
 */
export async function pullNotes(
    rt: PluginRuntime,
    reporter: Reporter,
    dests: string[],
    overwrite = false,
): Promise<NotesOutcome> {
    const tally: PullTally = {
        added: 0,
        updated: 0,
        unchanged: 0,
        conflict: 0,
        deleted: 0,
    };
    const errors: string[] = [];
    reporter.discovered(dests.length);
    for (const dest of dests) {
        const name = pageName(rt.config.syncRoot, dest);
        reporter.item(name);
        try {
            tally[await pullNote(rt, reporter, dest, name, overwrite)]++;
        } catch (err) {
            errors.push(
                `${name}: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }
    return { tally, errors };
}

/** pullNote pulls the one managed page at `dest`, returning its pull action. */
async function pullNote(
    rt: PluginRuntime,
    reporter: Reporter,
    dest: string,
    name: string,
    overwrite: boolean,
): Promise<PageAction> {
    const { src, spaceKey, links } = await resolvePageSource(
        {
            client: rt.client,
            fs: rt.fs,
            config: rt.config,
            reporter,
            linksPath: rt.dirs.linksPath,
        },
        dest,
    );
    const puller = new Puller({
        client: rt.client,
        fs: rt.fs,
        config: rt.config,
        reporter,
        cacheDir: rt.dirs.cacheDir,
        assetsDir: rt.dirs.assetsDir,
        links,
        flavor: resolveFlavor(rt.config.flavor),
        overwrite,
    });
    const { state, action, version } = await puller.pullOne(
        dest,
        src,
        spaceKey,
    );
    reporter.log(pageLine(action, state, name, version));
    return action;
}

/** preflight classifies the push candidates of `target` against their remote versions. */
export async function preflight(
    rt: PluginRuntime,
    target: Target,
): Promise<PreflightEntry[]> {
    // One frontmatter cache spans discovery and preflight so each note is read
    // once, not twice.
    const cache = new MetaCache();
    const dests = await pushDestsFor(rt, target, cache);
    return pushPreflight(await preflightDeps(rt), dests, cache);
}

/** VaultStatus is a status report and the remote body of each changed note. */
export interface VaultStatus {
    report: StatusReport;
    /** Keyed by note path; see {@link remoteBodies}. */
    bodies: Map<string, RemoteBody>;
}

/**
 * vaultStatus reports the two-way status of the whole vault, ignored notes
 * included (the view toggles them), with the remote body each changed note's
 * Confluence diff compares against. It throws when Confluence cannot be
 * reached; a body that cannot be had is recorded per note instead.
 */
export async function vaultStatus(rt: PluginRuntime): Promise<VaultStatus> {
    const deps = await preflightDeps(rt);
    const report = await collectStatus(deps, { ignored: true });
    const bodies = await remoteBodies(
        { ...deps, assetsDir: rt.dirs.assetsDir },
        report,
    );
    return { report, bodies };
}

/** applyStatus applies the chosen status-row actions (see {@link applyActions}). */
export function applyStatus(
    rt: PluginRuntime,
    reporter: Reporter,
    choices: Choice[],
): Promise<ActionResult[]> {
    return applyActions(
        {
            client: rt.client,
            fs: rt.fs,
            yaml: rt.yaml,
            config: rt.config,
            reporter,
            cacheDir: rt.dirs.cacheDir,
            assetsDir: rt.dirs.assetsDir,
            linksPath: rt.dirs.linksPath,
            mintLocalId: rt.mintLocalId,
            flavor: resolveFlavor(rt.config.flavor),
        },
        choices,
    );
}

/** markNever writes the ignore-push marker into each new note answered "never". */
export async function markNever(
    rt: PluginRuntime,
    dests: string[],
): Promise<void> {
    for (const dest of dests) {
        await markIgnorePush(rt.fs, dest);
    }
}

/** preflightDeps assembles the ports a preflight or status run reads. */
async function preflightDeps(rt: PluginRuntime): Promise<PreflightDeps> {
    return {
        client: rt.client,
        fs: rt.fs,
        yaml: rt.yaml,
        config: rt.config,
        cacheDir: rt.dirs.cacheDir,
        flavor: resolveFlavor(rt.config.flavor),
        links: (
            await openLinkIndex(rt.fs, rt.dirs.linksPath, rt.config.syncRoot)
        ).links,
    };
}

/** pushSelected pushes exactly the given dests, creating any confirmed new pages. */
export async function pushSelected(
    rt: PluginRuntime,
    reporter: Reporter,
    dests: string[],
): Promise<PushOutcome> {
    const { links, healed } = await openLinkIndex(
        rt.fs,
        rt.dirs.linksPath,
        rt.config.syncRoot,
    );
    for (const line of healed) {
        reporter.log(line);
    }
    // The user already chose these in the preview, so confirm every create.
    const plan = await planCreates(
        { client: rt.client, fs: rt.fs, yaml: rt.yaml, config: rt.config },
        dests,
        async (cands) => new Map(cands.map((c) => [c.dest, true])),
    );
    const pusher = new Pusher({
        client: rt.client,
        fs: rt.fs,
        yaml: rt.yaml,
        config: rt.config,
        reporter,
        cacheDir: rt.dirs.cacheDir,
        assetsDir: rt.dirs.assetsDir,
        mintLocalId: rt.mintLocalId,
        links,
        flavor: resolveFlavor(rt.config.flavor),
    });
    reporter.discovered(dests.length);
    return pusher.pushDests(dests, plan);
}

/**
 * pushDestsFor resolves the candidate dests of a target. A notes target keeps
 * the managed ones and fails when none is; a folder target keeps the managed
 * notes under that folder.
 */
async function pushDestsFor(
    rt: PluginRuntime,
    target: Target,
    cache?: MetaCache,
): Promise<string[]> {
    const all = await managedPushDests(rt.fs, rt.yaml, rt.config, cache);
    switch (target.kind) {
        case "vault":
            return all;
        case "folder": {
            const dir = posixClean(target.path);
            if (dir === ".") return all;
            return all.filter((d) => d.startsWith(`${dir}/`));
        }
        case "notes": {
            const managed = target.dests.filter((d) => all.includes(d));
            if (managed.length === 0) {
                const one = target.dests.length === 1 ? target.dests[0] : null;
                throw new Error(
                    one === null || one === undefined
                        ? "none of the selected notes is a managed page"
                        : `not a managed page: ${one}`,
                );
            }
            return managed;
        }
    }
}
