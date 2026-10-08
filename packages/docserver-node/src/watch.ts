// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// FsNotifier is a watch Notifier over Markdown sources on the local
// filesystem, the port of the Go server's fsnotify-based FS. Like fsnotify
// it watches each directory on its own (`fs.watch`, not recursive): a
// directory source and every directory below it, plus the source's parent
// so a sync tool replacing the whole directory is still seen; a file source
// through its parent, so an editor replacing the file by rename is seen.
//
// Under a directory source a change to a "*.md" file signals, as do a new
// directory (which is watched from then on) and any removal or rename,
// which may take Markdown files with it. A change that only touches
// permissions never signals: `fs.watch` reports it as a "change" like a
// write, so a "change" counts only when the file's modification time or
// size moved. Unlike fsnotify, `fs.watch` does not report an inotify queue
// overflow, so events lost to one are not warned about.
//
// Bun's `fs.watch` reports a rename only under the old name and folds a
// quick create-then-rename of one name into a single event, so an atomic
// save (a temp file renamed over a Markdown file, or a temp directory over
// a directory source) can reach the notifier as nothing but the temp entry
// appearing. Such an entry is polled for up to PENDING_MS: once it is gone,
// it signals when it was under a directory source (as the rename or removal
// does in Go), and its directory is rechecked when that holds a source: a
// directory source on a new inode is watched afresh and signals, a file
// source whose stamp moved signals. Every event from such a directory
// rechecks it too.

import {
    type BigIntStats,
    type Dirent,
    type FSWatcher,
    lstatSync,
    readdirSync,
    watch,
} from "node:fs";
import { resolve } from "node:path";

import { isAbsPosix, posixBase, posixDir, posixJoin } from "@docket/core";
import {
    underDir as configUnderDir,
    type Notifier,
    type NotifierSink,
    Relay,
} from "@docket/docserver";

import { slashPath } from "./fs.ts";

/** Stamp is what a write changes and a chmod does not. */
interface Stamp {
    mtimeNs: bigint;
    size: bigint;
}

/** Watched is a directory watcher and the inode it watches. */
interface Watched {
    w: FSWatcher;
    ino: bigint;
}

/** Stats are bigint lstat results. */
type Stats = BigIntStats;

/** PENDING_MS is how long a new entry is polled for. */
export const PENDING_MS = 1000;

/** POLL_MS is the poll interval for pending files. */
const POLL_MS = 50;

/** FsNotifier watches directory and file sources; release it with close. */
export class FsNotifier implements Notifier {
    private readonly relay = new Relay();
    private readonly dirs: string[];
    private readonly files: Set<string>;
    private readonly watchers = new Map<string, Watched>();
    /** roots are the parents watched for sources, never dropped. */
    private readonly roots = new Set<string>();
    private readonly stamps = new Map<string, Stamp>();
    /** parents are the directories holding a source. */
    private readonly parents = new Set<string>();
    /** pending maps new entries to when they were seen. */
    private readonly pending = new Map<string, number>();
    private poller: ReturnType<typeof setInterval> | undefined;
    private closed = false;

    /**
     * Starts watching the directory sources dirs and the file sources
     * files; every path must exist. It throws "watch <path>: <reason>" when
     * a watch cannot be set up.
     */
    constructor(dirs: readonly string[], files: readonly string[] = []) {
        this.dirs = dirs.map((d) => slashPath(resolve(d)));
        this.files = new Set(files.map((f) => slashPath(resolve(f))));
        for (const src of [...this.dirs, ...this.files]) {
            if (posixDir(src) !== src) this.parents.add(posixDir(src));
        }
        try {
            for (const dir of this.dirs) {
                this.addTree(dir);
                // The parent sees the root itself replaced, so the new
                // root's tree gets watched in place of the old one.
                const parent = posixDir(dir);
                if (parent !== dir && !this.watchers.has(parent)) {
                    this.add(parent, parent);
                    this.roots.add(parent);
                }
            }
            for (const file of this.files) {
                const parent = posixDir(file);
                if (!this.watchers.has(parent)) {
                    this.add(parent, file);
                    this.roots.add(parent);
                }
                let st: Stats | undefined;
                try {
                    st = lstatSync(file, { bigint: true });
                } catch {
                    st = undefined;
                }
                this.restamp(file, st);
            }
        } catch (err) {
            this.close();
            throw err;
        }
    }

    listen(sink: NotifierSink): void {
        this.relay.listen(sink);
    }

    /** close stops watching and reports closed; later calls do nothing. */
    close(): void {
        if (this.closed) return;
        this.closed = true;
        clearInterval(this.poller);
        for (const ent of this.watchers.values()) ent.w.close();
        this.watchers.clear();
        this.relay.close();
    }

    /** handle signals when an event in dir affects a watched source. */
    private handle(
        dir: string,
        w: FSWatcher,
        kind: string,
        name: string | null,
    ): void {
        // An event from a watcher already replaced or dropped is stale: it
        // names paths by where the directory used to be.
        if (this.closed || this.watchers.get(dir)?.w !== w) return;
        const path = name === null ? dir : posixJoin(dir, name);
        let st: Stats | undefined;
        try {
            st = lstatSync(path, { bigint: true });
        } catch {
            st = undefined;
        }
        if (st === undefined && this.selfEvent(dir, path)) return;
        if (this.parents.has(dir)) this.recheck(dir);
        const fresh = st !== undefined && this.isNewEntry(path, st);
        if (fresh && !this.underSource(path) && this.parents.has(dir)) {
            this.watchPending(path);
        }
        if (st?.isDirectory()) {
            // libuv reports a directory's attribute change as "rename"; a
            // directory still watched as the same inode only had its
            // permissions or times touched.
            if (this.watchers.get(path)?.ino === st.ino) return;
            if (!this.underSource(path)) return;
            try {
                this.addTree(path);
            } catch (err) {
                this.relay.warn(err as Error);
            }
            this.relay.signal();
            return;
        }
        if (st === undefined) this.drop(path);
        const tracked = this.files.has(path) || this.isSourceMarkdown(path);
        if (kind === "change") {
            // A "change" is a write or a permission change; only a moved
            // mtime or size is a write.
            if (tracked && this.restamp(path, st)) this.relay.signal();
            return;
        }
        if (tracked) this.restamp(path, st);
        if (this.files.has(path)) this.relay.signal();
        if (!this.underSource(path)) return;
        if (path.endsWith(".md") || st === undefined) this.relay.signal();
        else if (st.isFile()) this.watchPending(path);
    }

    /**
     * isNewEntry reports whether path, existing as st, is an entry the
     * notifier does not track yet: a file other than a source or a
     * directory not watched.
     */
    private isNewEntry(path: string, st: Stats): boolean {
        if (st.isDirectory()) return this.watchers.get(path)?.ino !== st.ino;
        return st.isFile() && !this.files.has(path) && !path.endsWith(".md");
    }

    /**
     * recheck looks at the sources in dir: a directory source on another
     * inode than the one watched is watched afresh, and a file source
     * whose stamp moved signals.
     */
    private recheck(dir: string): void {
        for (const src of this.dirs) {
            if (posixDir(src) !== dir) continue;
            let ino: bigint | undefined;
            try {
                ino = lstatSync(src, { bigint: true }).ino;
            } catch {
                ino = undefined;
            }
            if (ino === undefined || this.watchers.get(src)?.ino === ino)
                continue;
            try {
                this.addTree(src);
            } catch (err) {
                this.relay.warn(err as Error);
            }
            this.relay.signal();
        }
        for (const file of this.files) {
            if (posixDir(file) !== dir) continue;
            let st: Stats | undefined;
            try {
                st = lstatSync(file, { bigint: true });
            } catch {
                st = undefined;
            }
            if (this.restamp(file, st)) this.relay.signal();
        }
    }

    /** watchPending polls path, a new entry, until it goes. */
    private watchPending(path: string): void {
        this.pending.set(path, Date.now());
        this.poller ??= setInterval(() => this.pollPending(), POLL_MS);
        this.poller.unref?.();
    }

    /**
     * pollPending signals for each pending file now gone and forgets it,
     * as it does a file pending for longer than {@link PENDING_MS}.
     */
    private pollPending(): void {
        const now = Date.now();
        for (const [path, seen] of this.pending) {
            let gone = false;
            try {
                lstatSync(path);
            } catch {
                gone = true;
            }
            if (gone && this.underSource(path)) this.relay.signal();
            if (gone && this.parents.has(posixDir(path)))
                this.recheck(posixDir(path));
            if (gone || now - seen > PENDING_MS) this.pending.delete(path);
        }
        if (this.pending.size === 0) {
            clearInterval(this.poller);
            this.poller = undefined;
        }
    }

    /**
     * selfEvent reports an event a directory's own watcher raises about
     * the directory itself (libuv names it after the directory): its
     * parent's watcher reports any real removal or rename, so it is
     * dropped. A missing child that happens to share the directory's name
     * is a real event when the notifier knew that child.
     */
    private selfEvent(dir: string, path: string): boolean {
        if (posixBase(path) !== posixBase(dir)) return false;
        return !this.watchers.has(path) && !this.stamps.has(path);
    }

    /** isSourceMarkdown reports a "*.md" path under a directory source. */
    private isSourceMarkdown(path: string): boolean {
        return path.endsWith(".md") && this.underSource(path);
    }

    /**
     * restamp records path's stamp from st (gone when undefined) and
     * reports whether it moved: new, gone, or a different mtime or size.
     */
    private restamp(path: string, st: Stats | undefined): boolean {
        const prev = this.stamps.get(path);
        if (st === undefined || !st.isFile()) {
            this.stamps.delete(path);
            return prev !== undefined;
        }
        this.stamps.set(path, { mtimeNs: st.mtimeNs, size: st.size });
        return (
            prev === undefined ||
            prev.mtimeNs !== st.mtimeNs ||
            prev.size !== st.size
        );
    }

    /**
     * drop releases the watchers and stamps at path and below it: the
     * directory was removed or moved away, and a watcher left on it would
     * report its new location's events under the old path.
     */
    private drop(path: string): void {
        for (const [dir, ent] of this.watchers) {
            if (this.roots.has(dir) || !underDir(dir, path)) continue;
            ent.w.close();
            this.watchers.delete(dir);
        }
        for (const file of this.stamps.keys()) {
            if (underDir(file, path) && !this.files.has(file))
                this.stamps.delete(file);
        }
    }

    /** addTree watches dir and every directory below it, afresh. */
    private addTree(dir: string): void {
        this.drop(dir);
        this.add(dir, dir);
        let ents: Dirent[];
        try {
            ents = readdirSync(dir, { withFileTypes: true });
        } catch (err) {
            throw watchError(dir, err);
        }
        for (const ent of ents) {
            const path = posixJoin(dir, ent.name);
            if (ent.isDirectory()) this.addTree(path);
            else if (ent.isFile() && path.endsWith(".md")) {
                this.restamp(path, lstatSync(path, { bigint: true }));
            }
        }
    }

    /**
     * add watches dir, replacing a watcher already there (the path may now
     * name a new directory); errors name `label`.
     */
    private add(dir: string, label: string): void {
        this.watchers.get(dir)?.w.close();
        this.watchers.delete(dir);
        let ino: bigint;
        let w: FSWatcher;
        try {
            ino = lstatSync(dir, { bigint: true }).ino;
            w = watch(dir, { persistent: false }, (kind, name) =>
                this.handle(dir, w, kind, name),
            );
        } catch (err) {
            throw watchError(label, err);
        }
        w.on("error", (err) => {
            if (this.watchers.get(dir)?.w === w) this.watchers.delete(dir);
            w.close();
            this.relay.warn(new Error(`watch: ${err.message}`));
        });
        this.watchers.set(dir, { w, ino });
    }

    /** size returns the number of open directory watchers. */
    get size(): number {
        return this.watchers.size;
    }

    /** underSource reports whether path lies within a directory source. */
    private underSource(path: string): boolean {
        return this.dirs.some((dir) => underDir(path, dir));
    }
}

/**
 * underDir reports whether path lies within dir or equals it, both absolute,
 * comparing whole components so a sibling like "/a/bc" is not under "/a/b"
 * (the doc server's {@link configUnderDir}).
 */
export function underDir(path: string, dir: string): boolean {
    return isAbsPosix(path) && isAbsPosix(dir) && configUnderDir(path, dir);
}

/** watchError is Go's "watch <path>: <reason>". */
function watchError(path: string, err: unknown): Error {
    const code = (err as NodeJS.ErrnoException).code;
    const reason = REASONS[code ?? ""] ?? (err as Error).message;
    return new Error(`watch ${path}: ${reason}`, { cause: err });
}

/** REASONS are Go's texts for the errnos a watch setup meets. */
const REASONS: Readonly<Record<string, string>> = {
    ENOENT: "no such file or directory",
    ENOTDIR: "not a directory",
    EACCES: "permission denied",
    ENOSPC: "no space left on device",
    EMFILE: "too many open files",
};
