// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The doc server's page port: how notes stand against their Confluence
// pages, answered with the same push preflight the push review runs. The
// server names notes by absolute file path; preflight takes vault paths.
// Preflight is injected, so the mapping is unit-tested without Obsidian.

import type { PreflightEntry } from "@docket/core";
import type { PageStatus } from "@docket/docserver";

/** PageStateDeps are what {@link pageStates} needs. */
export interface PageStateDeps {
    /** base is the vault's folder on disk. */
    base: string;
    /** preflight classifies vault notes, one entry each, in order. */
    preflight: (dests: string[]) => Promise<PreflightEntry[]>;
}

/**
 * pageStates reports how each file stands against its Confluence page, in
 * order: the files inside the vault go to one preflight, and a file
 * outside it is skipped.
 */
export async function pageStates(
    files: readonly string[],
    deps: PageStateDeps,
): Promise<PageStatus[]> {
    const base = deps.base.replace(/\/+$/, "");
    const dests = files.map((file) =>
        file.startsWith(`${base}/`) ? file.slice(base.length + 1) : null,
    );
    const inVault = dests.filter((d): d is string => d !== null);
    const entries = inVault.length === 0 ? [] : await deps.preflight(inVault);
    let at = 0;
    return files.map((file, i) => {
        if (dests[i] === null) {
            return {
                file,
                state: "skip",
                localVersion: 0,
                remoteVersion: 0,
                reason: "not in the vault",
            };
        }
        const e = entries[at++];
        return {
            file,
            state: e?.cls ?? "skip",
            localVersion: e?.localBase ?? 0,
            remoteVersion: e?.remoteVersion ?? 0,
            reason: e?.reason ?? "no preflight result",
        };
    });
}
