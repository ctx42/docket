// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// A doc server watcher fed by Obsidian's vault events instead of `fs.watch`:
// the plugin forwards every vault create, modify, delete and rename here as
// disk paths, and each notifier signals its debounce loop under the same
// rules as the server's filesystem watcher. Under a directory source a
// change to a "*.md" note signals, as do a new folder and any removal or
// rename (which may take notes with it); a new file of another kind does
// not. A file source signals on any event naming it. No Obsidian imports,
// so it is unit-tested.

import { realpath } from "node:fs";
import { readdir } from "node:fs/promises";
import { posix } from "node:path";

import { Relay, relIn, underDir } from "@docket/docserver";
import {
    slashPath,
    type Watcher,
    type WatcherFactory,
} from "@docket/docserver-node";

/** VaultEventKind is the vault event a change arrived as. */
export type VaultEventKind = "create" | "modify" | "delete" | "rename";

/** VaultEvent is one vault event, its paths resolved to disk paths. */
export interface VaultEvent {
    kind: VaultEventKind;
    /** path is the entry's disk path (its new one after a rename). */
    path: string;
    /** folder tells a folder from a file. */
    folder: boolean;
    /** oldPath is the disk path before a rename. */
    oldPath?: string;
}

/** VaultNotifier is a {@link Watcher} over directory and file sources. */
export class VaultNotifier implements Watcher {
    private readonly relay = new Relay();
    private readonly dirs: string[];
    private readonly files: Set<string>;
    private closed = false;

    /**
     * Starts watching the directory sources dirs and the file sources
     * files, given as absolute disk paths; feed it with {@link event} and
     * release it with close.
     */
    constructor(
        dirs: readonly string[],
        files: readonly string[] = [],
        private readonly onClose: (ntf: VaultNotifier) => void = () => {},
    ) {
        this.dirs = dirs.map((d) => posix.normalize(d));
        this.files = new Set(files.map((f) => posix.normalize(f)));
    }

    listen(...args: Parameters<Relay["listen"]>): void {
        this.relay.listen(...args);
    }

    /** close stops delivery and reports closed; later calls do nothing. */
    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.relay.close();
        this.onClose(this);
    }

    /** event signals when ev affects a watched source. */
    event(ev: VaultEvent): void {
        if (this.closed) return;
        if (this.affects(ev)) this.relay.signal();
    }

    /** affects reports whether ev changes what the sources hold. */
    private affects(ev: VaultEvent): boolean {
        const paths =
            ev.oldPath === undefined ? [ev.path] : [ev.path, ev.oldPath];
        if (paths.some((p) => this.files.has(posix.normalize(p)))) return true;
        if (!paths.some((p) => this.underSource(p))) return false;
        switch (ev.kind) {
            case "delete":
            case "rename":
                return true;
            case "create":
                return ev.folder || ev.path.endsWith(".md");
            case "modify":
                return !ev.folder && ev.path.endsWith(".md");
        }
    }

    /** underSource reports whether path lies within a directory source. */
    private underSource(path: string): boolean {
        return this.dirs.some((d) => underDir(path, d));
    }
}

/**
 * underVault reports whether every path lies within the vault at disk path
 * base and outside the dot-folders Obsidian does not index, so vault events
 * see all its changes.
 */
export function underVault(base: string, paths: readonly string[]): boolean {
    if (base === "") return false;
    return paths.every((path) => {
        const [rel, ok] = relIn(path, base);
        if (!ok) return false;
        return (
            rel === "." || !rel.split("/").some((seg) => seg.startsWith("."))
        );
    });
}

/**
 * PathProbe is the filesystem access {@link VaultWatchers} needs, all
 * asynchronous so a large source tree never blocks Obsidian.
 */
export interface PathProbe {
    /** canonical returns path as the disk spells it, symlinks resolved. */
    canonical(path: string): Promise<string>;
    /**
     * hidden reports whether the tree at dir holds a dot-named folder or
     * note, which Obsidian does not index but the server does.
     */
    hidden(dir: string): Promise<boolean>;
}

/** NODE_PROBE is {@link PathProbe} over the local filesystem. */
export const NODE_PROBE: PathProbe = {
    canonical: (path) =>
        new Promise((resolve, reject) => {
            realpath.native(path, (err, out) =>
                err ? reject(err) : resolve(slashPath(out)),
            );
        }),
    async hidden(dir) {
        const ents = await readdir(dir, { withFileTypes: true });
        for (const ent of ents) {
            if (ent.isDirectory()) {
                if (ent.name.startsWith(".")) return true;
                if (await this.hidden(posix.join(dir, ent.name))) return true;
            } else if (ent.name.startsWith(".") && ent.name.endsWith(".md")) {
                return true;
            }
        }
        return false;
    },
};

/**
 * VaultWatchers hands the server watchers for its sources: a
 * {@link VaultNotifier} when Obsidian indexes everything under them, so
 * vault events (forwarded with {@link event}) drive it, else the fallback
 * (the filesystem watcher). Sources outside the vault, under a dot-folder,
 * holding a dot-named folder or note (Obsidian indexes none of these), or whose
 * paths cannot be resolved take the fallback. Paths are compared as the
 * disk spells them, so a symlinked vault or a case-insensitive disk still
 * matches.
 */
export class VaultWatchers {
    private readonly live = new Set<VaultNotifier>();
    /** root is the vault's canonical disk path, once a notifier needed it. */
    private root = "";

    constructor(
        private readonly base: () => string,
        private readonly fallback: WatcherFactory,
        private readonly probe: PathProbe = NODE_PROBE,
    ) {}

    /** factory is the server's {@link WatcherFactory}. */
    readonly factory: WatcherFactory = async (dirs, files) => {
        let root: string;
        let cdirs: string[];
        let cfiles: string[];
        try {
            const base = this.base();
            if (base === "") return this.fallback(dirs, files);
            root = await this.probe.canonical(base);
            cdirs = await Promise.all(dirs.map((d) => this.probe.canonical(d)));
            cfiles = await Promise.all(
                files.map((f) => this.probe.canonical(f)),
            );
            if (!underVault(root, [...cdirs, ...cfiles])) {
                return this.fallback(dirs, files);
            }
            for (const d of cdirs) {
                if (await this.probe.hidden(d))
                    return this.fallback(dirs, files);
            }
        } catch {
            return this.fallback(dirs, files);
        }
        this.root = root;
        const ntf = new VaultNotifier(cdirs, cfiles, (n) =>
            this.live.delete(n),
        );
        this.live.add(ntf);
        return ntf;
    };

    /** size is the number of open vault notifiers. */
    get size(): number {
        return this.live.size;
    }

    /**
     * event forwards a vault event to every open notifier; its paths are
     * vault-relative, as Obsidian gives them.
     */
    event(ev: VaultEvent): void {
        if (this.live.size === 0) return;
        const abs: VaultEvent = {
            kind: ev.kind,
            path: posix.join(this.root, ev.path),
            folder: ev.folder,
            ...(ev.oldPath === undefined
                ? {}
                : { oldPath: posix.join(this.root, ev.oldPath) }),
        };
        for (const ntf of this.live) ntf.event(abs);
    }
}
