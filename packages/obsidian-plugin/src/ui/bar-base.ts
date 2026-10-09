// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The pure model of what a note's change bars compare against: HEAD, the
// Confluence page, or a commit picked in the History tab. Confluence mode
// belongs to the note opened from its changes row, which offers the diff icon
// while it stays the active note. A picked commit belongs to the note it was
// picked for. Leaving the note forgets both. Between the two, the last action
// wins: picking a commit takes over from Confluence mode, and clearing the pick
// hands the bars back to it; turning Confluence mode on drops the pick.
// bar-base-feature.ts is the Obsidian side.

/** CommitPick is a commit a note's bars compare against. */
export interface CommitPick {
    /** The note's vault path now. */
    note: string;
    hash: string;
    /** The note's path at that commit; older across a rename. */
    path: string;
    /** The commit time, epoch milliseconds. */
    at: number;
}

/** BarBase is what a note's change bars compare against. */
export type BarBase =
    | { kind: "head" }
    | { kind: "confluence" }
    | { kind: "commit"; commit: CommitPick };

/**
 * BarBaseState is which note offers the Confluence diff icon (the one opened
 * from its row), whether its bars show the Confluence diff, and the commit
 * picked in History. Each mutating method returns whether anything changed.
 */
export class BarBaseState {
    private openedPath: string | null = null;
    private on = false;
    private picked: CommitPick | null = null;

    /** opened is the note opened from its row, still the active note, or null. */
    get opened(): string | null {
        return this.openedPath;
    }

    /**
     * confluencePath is the note in Confluence mode, or null. A picked commit
     * hides the mode without ending it.
     */
    get confluencePath(): string | null {
        return this.on ? this.openedPath : null;
    }

    /** commit is the picked commit, or null. */
    get commit(): CommitPick | null {
        return this.picked;
    }

    /** base is what `path`'s bars compare against. */
    base(path: string): BarBase {
        if (this.picked?.note === path) {
            return { kind: "commit", commit: this.picked };
        }
        if (this.confluencePath === path) return { kind: "confluence" };
        return { kind: "head" };
    }

    /** open records `path` as opened from its row, with the diff off. */
    open(path: string): boolean {
        const changed = this.openedPath !== path || this.on;
        this.openedPath = path;
        this.on = false;
        return changed;
    }

    /**
     * focus forgets the opened note and the pick once `path` (the active note)
     * is another.
     */
    focus(path: string | null): boolean {
        let changed = false;
        if (this.openedPath !== null && this.openedPath !== path) {
            this.openedPath = null;
            this.on = false;
            changed = true;
        }
        if (this.picked !== null && this.picked.note !== path) {
            this.picked = null;
            changed = true;
        }
        return changed;
    }

    /**
     * toggle flips the diff of the opened note; any other path is ignored.
     * Turning it on drops the note's pick.
     */
    toggle(path: string): boolean {
        if (this.openedPath !== path) return false;
        this.on = !this.on;
        if (this.on && this.picked?.note === path) this.picked = null;
        return true;
    }

    /** pick sets the picked commit, or clears it with null. */
    pick(c: CommitPick | null): boolean {
        if (c?.note === this.picked?.note && c?.hash === this.picked?.hash) {
            return false;
        }
        this.picked = c;
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
