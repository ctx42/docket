// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// In-memory DocFs for docserver tests: directories, files, and symlinks with
// permission bits and nanosecond mtimes from an injected clock. Directory
// write bits and file read bits are enforced the way a non-root process sees
// them, so Go's chmod-based failure tests port directly; `failOn` injects any
// other failure. Errors match Go's text. Test-only code, so it may use
// `node:` freely.

import { Buffer } from "node:buffer";
import { posix } from "node:path";

import {
    type DocDirEntry,
    type DocDirEntryKind,
    type DocFs,
    DocFsError,
    type DocStat,
    type WriteAtomicOptions,
    type WriteStage,
} from "../../src/ports.ts";

/** DocFsOp names a {@link DocFs} method {@link MemDocFs.failOn} can fail. */
export type DocFsOp = keyof DocFs;

/** Fault describes an injected failure. */
export interface Fault {
    /** code is the errno name thrown; default "EIO". */
    code?: string;
    /** stage picks the writeAtomic step that fails; default "create". */
    stage?: WriteStage;
    /** once removes the fault after it fires. */
    once?: boolean;
}

/** MemDocFsOptions configure a {@link MemDocFs}. */
export interface MemDocFsOptions {
    /** clock returns the mtime (Unix ns) given to each modified node. */
    clock?: () => bigint;
}

type Node =
    | { kind: "file"; data: Uint8Array; mode: number; mtimeNs: bigint }
    | { kind: "dir"; mode: number; mtimeNs: bigint }
    | { kind: "symlink"; target: string; mtimeNs: bigint };

/** MAX_HOPS bounds symlink resolution, as Linux does (ELOOP). */
const MAX_HOPS = 40;

/** Go's operation name for each method's PathError. */
const GO_OP: Record<DocFsOp, string> = {
    readText: "open",
    readBytes: "open",
    stat: "stat",
    lstat: "lstat",
    readdir: "open",
    realpath: "lstat",
    writeAtomic: "open",
    rename: "rename",
    remove: "remove",
    mkdir: "mkdir",
    syncDir: "open",
    probeWritable: "open",
};

/** Go's operation name for each writeAtomic stage. */
const STAGE_OP: Record<WriteStage, string> = {
    create: "open",
    chmod: "chmod",
    write: "write",
    sync: "sync",
    close: "close",
    rename: "rename",
    syncdir: "sync",
};

/** MemDocFs is an in-memory {@link DocFs}. */
export class MemDocFs implements DocFs {
    /** synced lists every directory syncDir flushed, in call order. */
    readonly synced: string[] = [];

    private readonly nodes = new Map<string, Node>();
    private readonly faults = new Map<string, Fault>();
    private readonly clock: () => bigint;
    private seq = 0;

    constructor(opts: MemDocFsOptions = {}) {
        let now = 1_700_000_000_000_000_000n;
        this.clock =
            opts.clock ??
            (() => {
                now += 1_000_000n;
                return now;
            });
        this.nodes.set("/", {
            kind: "dir",
            mode: 0o755,
            mtimeNs: this.clock(),
        });
    }

    // --- Setup and inspection (synchronous, never faulted) ---

    /** mkdirp creates path and missing parents. */
    mkdirp(path: string, mode = 0o755): this {
        let cur = "/";
        for (const part of split(clean(path))) {
            cur = posix.join(cur, part);
            const node = this.nodes.get(cur);
            if (node === undefined) {
                this.nodes.set(cur, {
                    kind: "dir",
                    mode,
                    mtimeNs: this.clock(),
                });
            } else if (node.kind !== "dir") {
                throw new Error(`mkdirp ${path}: ${cur} is not a directory`);
            }
        }
        return this;
    }

    /** writeFile creates or replaces a file, creating missing parents. */
    writeFile(
        path: string,
        data: string | Uint8Array,
        opts: { mode?: number; mtimeNs?: bigint } = {},
    ): this {
        const p = clean(path);
        this.mkdirp(posix.dirname(p));
        this.nodes.set(p, {
            kind: "file",
            data: bytes(data),
            mode: opts.mode ?? 0o644,
            mtimeNs: opts.mtimeNs ?? this.clock(),
        });
        return this;
    }

    /** symlink creates path pointing at target (relative to path's dir). */
    symlink(target: string, path: string): this {
        const p = clean(path);
        this.mkdirp(posix.dirname(p));
        this.nodes.set(p, { kind: "symlink", target, mtimeNs: this.clock() });
        return this;
    }

    /** chmod sets the permission bits of a file or directory. */
    chmod(path: string, mode: number): this {
        const node = this.nodes.get(clean(path));
        if (node === undefined || node.kind === "symlink") {
            throw new Error(`chmod ${path}: no file or directory`);
        }
        node.mode = mode;
        return this;
    }

    /** removeAll deletes path and everything under it, if present. */
    removeAll(path: string): this {
        const p = clean(path);
        for (const key of [...this.nodes.keys()]) {
            if (key === p || key.startsWith(`${p}/`)) this.nodes.delete(key);
        }
        return this;
    }

    /** readFile returns a file's text, bypassing faults and permissions. */
    readFile(path: string): string {
        const node = this.nodes.get(clean(path));
        if (node?.kind !== "file") throw new Error(`readFile ${path}: no file`);
        return Buffer.from(node.data).toString("utf8");
    }

    /** modeOf returns a node's permission bits. */
    modeOf(path: string): number {
        const node = this.nodes.get(clean(path));
        if (node === undefined || node.kind === "symlink") {
            throw new Error(`modeOf ${path}: no file or directory`);
        }
        return node.mode;
    }

    /** exists reports whether path names a node (symlinks not followed). */
    exists(path: string): boolean {
        return this.nodes.has(clean(path));
    }

    /** paths lists every node's path, sorted. */
    paths(): string[] {
        return [...this.nodes.keys()].sort();
    }

    /**
     * failOn makes op on path fail with fault until {@link clearFaults} (or
     * once, with `once`). For rename, path is the source.
     */
    failOn(op: DocFsOp, path: string, fault: Fault = {}): this {
        this.faults.set(`${op}\0${clean(path)}`, fault);
        return this;
    }

    /** clearFaults removes every injected fault. */
    clearFaults(): this {
        this.faults.clear();
        return this;
    }

    // --- DocFs ---

    async readText(path: string): Promise<string> {
        const data = this.read("readText", path);
        return Buffer.from(data).toString("utf8");
    }

    async readBytes(path: string): Promise<Uint8Array> {
        return Uint8Array.from(this.read("readBytes", path));
    }

    async stat(path: string): Promise<DocStat> {
        const p = clean(path);
        this.fault("stat", p);
        return statOf(this.walk(p, true, "stat").node ?? missing("stat", p));
    }

    async lstat(path: string): Promise<DocStat> {
        const p = clean(path);
        this.fault("lstat", p);
        return statOf(this.walk(p, false, "lstat").node ?? missing("lstat", p));
    }

    async readdir(path: string): Promise<DocDirEntry[]> {
        const p = clean(path);
        this.fault("readdir", p);
        const { path: real, node } = this.walk(p, true, "open");
        if (node === undefined) missing("open", p);
        if (node.kind !== "dir") throw fsErr("ENOTDIR", "open", p);
        if ((node.mode & 0o400) === 0) throw fsErr("EACCES", "open", p);
        return this.children(real)
            .map(([name, child]) => ({ name, kind: kindOf(child) }))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }

    async realpath(path: string): Promise<string> {
        const p = clean(path);
        this.fault("realpath", p);
        return this.walk(p, true, "lstat", true).path;
    }

    async writeAtomic(
        path: string,
        data: string | Uint8Array,
        opts: WriteAtomicOptions,
    ): Promise<void> {
        const p = clean(path);
        const dir = posix.dirname(p);
        const tmp = posix.join(
            dir,
            `${opts.tempPrefix}${++this.seq}${opts.tempSuffix}`,
        );
        const fail = (stage: WriteStage, code: string): DocFsError =>
            new DocFsError({
                code,
                op: STAGE_OP[stage],
                path: stage === "syncdir" ? dir : tmp,
                ...(stage === "rename" ? { path2: p } : {}),
                stage,
            });

        const fault = this.faults.get(`writeAtomic\0${p}`);
        const failing = fault?.stage ?? (fault ? "create" : undefined);
        if (fault?.once) this.faults.delete(`writeAtomic\0${p}`);

        const parent = this.walkCode(dir, true);
        if (typeof parent === "string") throw fail("create", parent);
        if (parent.node === undefined) throw fail("create", "ENOENT");
        if (parent.node.kind !== "dir") throw fail("create", "ENOTDIR");
        if ((parent.node.mode & 0o200) === 0) throw fail("create", "EACCES");
        for (const stage of [
            "create",
            "chmod",
            "write",
            "sync",
            "close",
        ] as const) {
            if (failing === stage) throw fail(stage, fault?.code ?? "EIO");
        }
        const target = this.nodes.get(
            posix.join(parent.path, posix.basename(p)),
        );
        if (target?.kind === "dir") throw fail("rename", "EEXIST");
        if (failing === "rename") throw fail("rename", fault?.code ?? "EIO");

        this.nodes.set(posix.join(parent.path, posix.basename(p)), {
            kind: "file",
            data: bytes(data),
            mode: opts.mode,
            mtimeNs: this.clock(),
        });
        if (failing === "syncdir") throw fail("syncdir", fault?.code ?? "EIO");
        this.synced.push(dir);
    }

    async rename(from: string, to: string): Promise<void> {
        const src = clean(from);
        const dst = clean(to);
        const err = (code: string) =>
            new DocFsError({ code, op: "rename", path: src, path2: dst });
        this.fault("rename", src, err);

        const s = this.walkCode(src, false);
        if (typeof s === "string") throw err(s);
        if (s.node === undefined) throw err("ENOENT");
        const dParent = this.walkCode(posix.dirname(dst), true);
        if (typeof dParent === "string") throw err(dParent);
        if (dParent.node === undefined) throw err("ENOENT");
        if (dParent.node.kind !== "dir") throw err("ENOTDIR");
        const realDst = posix.join(dParent.path, posix.basename(dst));
        if (this.nodes.has(realDst)) throw err("EEXIST");
        const sParent = this.nodes.get(posix.dirname(s.path)) as Node;
        if (!writable(sParent) || !writable(dParent.node)) throw err("EACCES");

        for (const [key, node] of [...this.nodes]) {
            if (key === s.path || key.startsWith(`${s.path}/`)) {
                this.nodes.delete(key);
                this.nodes.set(realDst + key.slice(s.path.length), node);
            }
        }
    }

    async remove(path: string): Promise<void> {
        const p = clean(path);
        this.fault("remove", p);
        const found = this.walkCode(p, false);
        if (typeof found === "string") throw fsErr(found, "remove", p);
        if (found.node === undefined) throw fsErr("ENOENT", "remove", p);
        if (found.node.kind === "dir" && this.children(found.path).length > 0) {
            throw fsErr("ENOTEMPTY", "remove", p);
        }
        const parent = this.nodes.get(posix.dirname(found.path)) as Node;
        if (!writable(parent)) throw fsErr("EACCES", "remove", p);
        this.nodes.delete(found.path);
    }

    async mkdir(path: string, mode: number): Promise<void> {
        const p = clean(path);
        this.fault("mkdir", p);
        const found = this.walkCode(p, false);
        if (typeof found === "string") throw fsErr(found, "mkdir", p);
        if (found.node !== undefined) throw fsErr("EEXIST", "mkdir", p);
        const parent = this.nodes.get(posix.dirname(found.path)) as Node;
        if (!writable(parent)) throw fsErr("EACCES", "mkdir", p);
        this.nodes.set(found.path, {
            kind: "dir",
            mode,
            mtimeNs: this.clock(),
        });
    }

    async syncDir(path: string): Promise<void> {
        const p = clean(path);
        this.fault("syncDir", p);
        const found = this.walkCode(p, true);
        if (typeof found === "string") throw fsErr(found, "open", p);
        if (found.node === undefined) throw fsErr("ENOENT", "open", p);
        this.synced.push(p);
    }

    async probeWritable(dir: string, prefix: string): Promise<void> {
        const d = clean(dir);
        const probe = posix.join(d, `${prefix}${++this.seq}`);
        this.fault("probeWritable", d, (code) => fsErr(code, "open", probe));
        const found = this.walkCode(d, true);
        if (typeof found === "string") throw fsErr(found, "open", probe);
        if (found.node === undefined) throw fsErr("ENOENT", "open", probe);
        if (found.node.kind !== "dir") throw fsErr("ENOTDIR", "open", probe);
        if (!writable(found.node)) throw fsErr("EACCES", "open", probe);
    }

    // --- Internals ---

    /** read implements readText/readBytes. */
    private read(op: "readText" | "readBytes", path: string): Uint8Array {
        const p = clean(path);
        this.fault(op, p);
        const { node } = this.walk(p, true, "open");
        if (node === undefined) missing("open", p);
        if (node.kind === "dir") throw fsErr("EISDIR", "read", p);
        if (node.kind !== "file" || (node.mode & 0o400) === 0) {
            throw fsErr("EACCES", "open", p);
        }
        return node.data;
    }

    /** fault throws the fault injected for op on path, if any. */
    private fault(
        op: DocFsOp,
        path: string,
        make: (code: string) => DocFsError = (code) =>
            fsErr(code, GO_OP[op], path),
    ): void {
        const key = `${op}\0${path}`;
        const fault = this.faults.get(key);
        if (fault === undefined) return;
        if (fault.once) this.faults.delete(key);
        throw make(fault.code ?? "EIO");
    }

    /** children returns the direct children of the directory at real path. */
    private children(dir: string): [string, Node][] {
        const out: [string, Node][] = [];
        for (const [key, node] of this.nodes) {
            if (key !== "/" && posix.dirname(key) === dir) {
                out.push([posix.basename(key), node]);
            }
        }
        return out;
    }

    /**
     * walk resolves path, following symlinks in every component and in the
     * last when follow is set, and throws Go's error on failure. With
     * strictLast a missing last component fails too, naming the path that
     * was looked up (Go EvalSymlinks).
     */
    private walk(
        path: string,
        follow: boolean,
        op: string,
        strictLast = false,
    ): { path: string; node: Node | undefined } {
        const res = this.resolve(path, follow);
        if ("code" in res)
            throw fsErr(res.code, op, strictLast ? res.at : path);
        if (strictLast && res.node === undefined) {
            throw fsErr("ENOENT", op, res.path);
        }
        return res;
    }

    /** walkCode is walk returning the errno code instead of throwing. */
    private walkCode(
        path: string,
        follow: boolean,
    ): { path: string; node: Node | undefined } | string {
        const res = this.resolve(path, follow);
        return "code" in res ? res.code : res;
    }

    private resolve(
        path: string,
        follow: boolean,
    ): { path: string; node: Node | undefined } | { code: string; at: string } {
        let parts = split(path);
        let cur = "/";
        let hops = 0;
        for (let i = 0; i < parts.length; i++) {
            const next = posix.join(cur, parts[i] as string);
            const node = this.nodes.get(next);
            const last = i === parts.length - 1;
            if (node === undefined) {
                if (last) return { path: next, node: undefined };
                return { code: "ENOENT", at: next };
            }
            if (node.kind === "symlink" && (!last || follow)) {
                if (++hops > MAX_HOPS) return { code: "ELOOP", at: next };
                const target = posix.isAbsolute(node.target)
                    ? node.target
                    : posix.join(cur, node.target);
                parts = [...split(clean(target)), ...parts.slice(i + 1)];
                cur = "/";
                i = -1;
                continue;
            }
            if (!last && node.kind !== "dir")
                return { code: "ENOTDIR", at: next };
            cur = next;
        }
        return { path: cur, node: this.nodes.get(cur) };
    }
}

function clean(path: string): string {
    return posix.resolve("/", path);
}

function split(path: string): string[] {
    return path.split("/").filter((p) => p !== "");
}

function bytes(data: string | Uint8Array): Uint8Array {
    return typeof data === "string"
        ? Uint8Array.from(Buffer.from(data, "utf8"))
        : Uint8Array.from(data);
}

function writable(node: Node): boolean {
    return node.kind === "dir" && (node.mode & 0o200) !== 0;
}

function kindOf(node: Node): DocDirEntryKind {
    return node.kind;
}

function statOf(node: Node): DocStat {
    return {
        isFile: node.kind === "file",
        isDir: node.kind === "dir",
        isSymlink: node.kind === "symlink",
        size:
            node.kind === "file"
                ? node.data.length
                : node.kind === "symlink"
                  ? node.target.length
                  : 0,
        mtimeNs: node.mtimeNs,
        mode: node.kind === "symlink" ? 0o777 : node.mode,
    };
}

function fsErr(code: string, op: string, path: string): DocFsError {
    return new DocFsError({ code, op, path });
}

function missing(op: string, path: string): never {
    throw fsErr("ENOENT", op, path);
}
