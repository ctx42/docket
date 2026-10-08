// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The pure model behind the Confluence diff: which changes rows offer the diff
// icon, the base text a note's change bars compare against in Confluence mode,
// and the per-note on/off state. The icon shows only on the row of the note
// opened by clicking that row, while it stays the active note; leaving the note
// forgets it. remote-diff-feature.ts is the Obsidian side.

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

/**
 * RemoteDiffState is which note offers the diff icon (the one opened from its
 * row) and whether its bars show the Confluence diff. Each method returns
 * whether anything changed.
 */
export class RemoteDiffState {
    private openedPath: string | null = null;
    private on = false;

    /** opened is the note opened from its row, still the active note, or null. */
    get opened(): string | null {
        return this.openedPath;
    }

    /** confluencePath is the note whose bars show the Confluence diff, or null. */
    get confluencePath(): string | null {
        return this.on ? this.openedPath : null;
    }

    /** open records `path` as opened from its row, with the diff off. */
    open(path: string): boolean {
        const changed = this.openedPath !== path || this.on;
        this.openedPath = path;
        this.on = false;
        return changed;
    }

    /** focus forgets the opened note once `path` (the active note) is another. */
    focus(path: string | null): boolean {
        if (this.openedPath === null || this.openedPath === path) return false;
        this.openedPath = null;
        this.on = false;
        return true;
    }

    /** toggle flips the diff of the opened note; any other path is ignored. */
    toggle(path: string): boolean {
        if (this.openedPath !== path) return false;
        this.on = !this.on;
        return true;
    }

    /**
     * reconcile turns the diff off when the note no longer has a remote body to
     * compare against — its row left the list, or its prefetch failed.
     */
    reconcile(hasBody: (path: string) => boolean): boolean {
        if (!this.on || this.openedPath === null) return false;
        if (hasBody(this.openedPath)) return false;
        this.on = false;
        return true;
    }
}
