// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ports of the doc server: the filesystem operations the Go server performs
// (and no more), and the log sink. Errors carry Go's `*fs.PathError` /
// `*os.LinkError` text, because the server wraps them into messages agents
// and logs see, and those must read as the Go server's do.

/** DocStat is the part of a Go `fs.FileInfo` the server reads. */
export interface DocStat {
    isFile: boolean;
    isDir: boolean;
    isSymlink: boolean;
    size: number;
    /** mtimeNs is the modification time in Unix nanoseconds. */
    mtimeNs: bigint;
    /** mode holds the permission bits (`info.Mode().Perm()`). */
    mode: number;
}

/** DocDirEntryKind is the type of a directory entry, not followed. */
export type DocDirEntryKind = "file" | "dir" | "symlink" | "other";

/** DocDirEntry is one entry of {@link DocFs.readdir}. */
export interface DocDirEntry {
    name: string;
    kind: DocDirEntryKind;
}

/** WriteStage names the step of {@link DocFs.writeAtomic} that failed. */
export type WriteStage =
    | "create"
    | "chmod"
    | "write"
    | "sync"
    | "close"
    | "rename"
    | "syncdir";

/** WriteAtomicOptions configure {@link DocFs.writeAtomic}. */
export interface WriteAtomicOptions {
    /** mode is the permission bits of the written file. */
    mode: number;
    /** tempPrefix starts the temp file's name (Go `CreateTemp` pattern). */
    tempPrefix: string;
    /** tempSuffix ends the temp file's name. */
    tempSuffix: string;
}

/**
 * DocFs is the filesystem as the doc server uses it. Paths are absolute and
 * POSIX. Every method rejects with a {@link DocFsError}.
 */
export interface DocFs {
    /** readText reads a whole file as UTF-8 (Go `os.ReadFile`). */
    readText(path: string): Promise<string>;
    /** readBytes reads a whole file (Go `os.ReadFile`). */
    readBytes(path: string): Promise<Uint8Array>;
    /** stat follows symlinks (Go `os.Stat`). */
    stat(path: string): Promise<DocStat>;
    /** lstat does not follow a final symlink (Go `os.Lstat`). */
    lstat(path: string): Promise<DocStat>;
    /** readdir lists a directory sorted by name (Go `os.ReadDir`). */
    readdir(path: string): Promise<DocDirEntry[]>;
    /** realpath resolves every symlink (Go `filepath.EvalSymlinks`). */
    realpath(path: string): Promise<string>;
    /**
     * writeAtomic replaces path durably: a temp file in the same directory
     * is created, chmod-ed to `mode`, written, fsync-ed, closed, renamed
     * over path, and the directory is fsync-ed. The temp file never
     * survives a failure. A failure carries its {@link WriteStage}.
     */
    writeAtomic(
        path: string,
        data: string | Uint8Array,
        opts: WriteAtomicOptions,
    ): Promise<void>;
    /** rename moves from to to, refusing an existing target (EEXIST). */
    rename(from: string, to: string): Promise<void>;
    /** remove deletes a file or an empty directory (Go `os.Remove`). */
    remove(path: string): Promise<void>;
    /** mkdir creates one directory (Go `os.Mkdir`); EEXIST if present. */
    mkdir(path: string, mode: number): Promise<void>;
    /** syncDir fsyncs a directory so entry changes in it are durable. */
    syncDir(path: string): Promise<void>;
    /**
     * probeWritable creates and removes a temp file named
     * `<prefix><random>` in dir, proving the directory is writable.
     */
    probeWritable(dir: string, prefix: string): Promise<void>;
}

/** Logger receives the server's log lines (no trailing newline). */
export interface Logger {
    info(line: string): void;
    warn(line: string): void;
}

/** FS_REASONS maps errno codes to the text Go prints for them. */
const FS_REASONS: Readonly<Record<string, string>> = {
    EACCES: "permission denied",
    EEXIST: "file exists",
    EIO: "input/output error",
    EISDIR: "is a directory",
    ELOOP: "too many levels of symbolic links",
    ENOENT: "no such file or directory",
    ENOSPC: "no space left on device",
    ENOTDIR: "not a directory",
    ENOTEMPTY: "directory not empty",
    EPERM: "operation not permitted",
    EROFS: "read-only file system",
};

/** DocFsErrorInit describes a {@link DocFsError}. */
export interface DocFsErrorInit {
    /** code is the errno name, e.g. "ENOENT". */
    code: string;
    /** op is Go's operation name: open, stat, lstat, read, rename, … */
    op: string;
    path: string;
    /** path2 is the rename target (Go `*os.LinkError`). */
    path2?: string;
    /** stage is set by {@link DocFs.writeAtomic}. */
    stage?: WriteStage;
    /** reason overrides the text derived from code. */
    reason?: string;
}

/**
 * DocFsError is a failed filesystem operation, its message formatted like
 * Go's `*fs.PathError` ("open /a: no such file or directory") or, for
 * rename, `*os.LinkError` ("rename /a /b: file exists").
 */
export class DocFsError extends Error {
    readonly code: string;
    readonly op: string;
    readonly path: string;
    readonly path2: string | undefined;
    readonly stage: WriteStage | undefined;
    /** reason is the text after the path, e.g. "file exists". */
    readonly reason: string;

    constructor(init: DocFsErrorInit) {
        const reason =
            init.reason ?? FS_REASONS[init.code] ?? init.code.toLowerCase();
        const where =
            init.path2 === undefined ? init.path : `${init.path} ${init.path2}`;
        super(`${init.op} ${where}: ${reason}`);
        this.name = "DocFsError";
        this.code = init.code;
        this.op = init.op;
        this.path = init.path;
        this.path2 = init.path2;
        this.stage = init.stage;
        this.reason = reason;
    }
}

/**
 * errorIs walks err and its `cause` chain (Go `errors.Is` unwrapping) and
 * reports whether any link satisfies match.
 */
export function errorIs(err: unknown, match: (e: unknown) => boolean): boolean {
    for (let cur = err, depth = 0; cur !== undefined && depth < 100; depth++) {
        if (match(cur)) return true;
        cur = cur instanceof Error ? cur.cause : undefined;
    }
    return false;
}

/** isNotExist reports a missing file (Go `errors.Is(err, fs.ErrNotExist)`). */
export function isNotExist(err: unknown): boolean {
    return errorIs(err, (e) => e instanceof DocFsError && e.code === "ENOENT");
}

/**
 * isExist reports an existing file (Go `errors.Is(err, fs.ErrExist)`, which
 * also matches ENOTEMPTY).
 */
export function isExist(err: unknown): boolean {
    return errorIs(
        err,
        (e) =>
            e instanceof DocFsError &&
            (e.code === "EEXIST" || e.code === "ENOTEMPTY"),
    );
}
