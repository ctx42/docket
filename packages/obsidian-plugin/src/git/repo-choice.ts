// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// What the Git and History tabs show when the set of knowledge bases changes.
// Each tab has fixed buttons (Vault, Confluence, and History's Note) and one
// knowledge-base button, named after the base picked last, whose menu picks
// another. Pure, so it unit-tests; the tabs are DOM glue.

import { type KbRepoId, kbName } from "./history.ts";

/** Choice is what a tab shows (`repo`) and which base its button names. */
export interface Choice<M extends string> {
    /** A fixed button's id, or the id of the knowledge base shown. */
    repo: M | KbRepoId;
    /** The knowledge base the button names; null when there is none. */
    kb: string | null;
}

/**
 * settleChoice fits a tab's choice to the knowledge bases `names`: the button
 * keeps naming its base while that exists, else the first one; a tab showing
 * a base that is gone shows `fallback`.
 */
export function settleChoice<M extends string>(
    c: Choice<M>,
    names: readonly string[],
    fallback: M,
): Choice<M> {
    const kb =
        c.kb !== null && names.includes(c.kb) ? c.kb : (names[0] ?? null);
    const shown = kbName(c.repo);
    const repo = shown === null || names.includes(shown) ? c.repo : fallback;
    return { repo, kb };
}
