// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The Confluence diff's pure helpers: which changes rows offer the diff icon,
// and the base text a note's change bars compare against in Confluence mode.
// Whether a note is in Confluence mode is bar-base.ts's.

import type { RemoteBody } from "@docket/core";
import type { ChangeGroupId } from "./review.ts";

/** DIFF_GROUPS are the changes groups whose rows can show the diff icon. */
export const DIFF_GROUPS: ReadonlySet<ChangeGroupId> = new Set([
    "outgoing",
    "incoming",
    "diverged",
]);

/**
 * remoteFor returns the remote body of the note at `dest` in group `id` — its
 * body, or the reason it has none — or null when the group offers no diff or
 * the status check recorded nothing for the note.
 */
export function remoteFor(
    bodies: ReadonlyMap<string, RemoteBody> | undefined,
    id: ChangeGroupId,
    dest: string,
): RemoteBody | null {
    if (!DIFF_GROUPS.has(id)) return null;
    return bodies?.get(dest) ?? null;
}

/**
 * confluenceBase is the text a note's change bars compare against in Confluence
 * mode: the note's own frontmatter (and the blank lines after it), then the
 * remote `body`, then the note's own trailing newlines — so only the body can
 * differ. It splits the note as core's `splitFrontmatter` does; a note without
 * frontmatter is all body.
 */
export function confluenceBase(doc: string, body: string): string {
    let head = "";
    if (doc.startsWith("---\n")) {
        const end = doc.indexOf("\n---", 4);
        if (end >= 0) {
            const fence = end + "\n---".length;
            const blank = /^\n*/.exec(doc.slice(fence))?.[0].length ?? 0;
            head = doc.slice(0, fence + blank);
        }
    }
    const tail = /\n*$/.exec(doc.slice(head.length))?.[0] ?? "";
    return head + body + tail;
}
