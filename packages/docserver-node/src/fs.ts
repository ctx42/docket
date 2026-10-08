// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// NodeDocFs implements the docserver filesystem port on `node:fs`, with the
// durability the Go server relies on: atomic replace via temp file, fsync of
// the file and of its directory, no-overwrite rename, and mode preservation.
// Errors are re-raised as DocFsError carrying Go's operation names, so the
// server's wrapped messages read like the Go server's.

import { randomInt } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fsp from "node:fs/promises";
import { posix } from "node:path";

import { isAbsPosix, posixClean, posixJoin } from "@docket/core";

import {
    type DocDirEntry,
    type DocDirEntryKind,
    type DocFs,
    DocFsError,
    type DocStat,
    type WriteAtomicOptions,
    type WriteStage,
} from "@docket/docserver";

/**
 * slashPath returns a native path in the forward-slash form the doc server
 * works in: on Windows `C:\Vault\docs` becomes `C:/Vault/docs`, which Node's
 * filesystem calls accept too; elsewhere the path is returned as is.
 */
export function slashPath(
    path: string,
    platform: string = process.platform,
): string {
    return platform === "win32" ? path.replaceAll("\\", "/") : path;
}

/**
 * splitRoot cleans path, made absolute from "/" when relative, into its root
 * (`/` or a drive root like `C:/`) and its components.
 */
function splitRoot(path: string): [string, string[]] {
    const c = posixClean(isAbsPosix(path) ? path : `/${path}`);
    const root = c.startsWith("/") ? "/" : c.slice(0, c.indexOf("/") + 1);
    return [root, c.slice(root.length).split("/").filter(Boolean)];
}

/** MAX_LINKS bounds symlink resolution in realpath, as Go's EvalSymlinks. */
const MAX_LINKS = 255;

/** ERRNO matches a system error code such as "ENOENT". */
const ERRNO = /^E[A-Z0-9]+$/;

/** NodeDocFs is the {@link DocFs} over the real filesystem. */
export class NodeDocFs implements DocFs {
    async readText(path: string): Promise<string> {
        return Buffer.from(await this.readBytes(path)).toString("utf8");
    }

    async readBytes(path: string): Promise<Uint8Array> {
        try {
            return new Uint8Array(await fsp.readFile(path));
        } catch (err) {
            // Go opens first, then reads; a directory fails at the read.
            throw toDocFsError(
                err,
                codeOf(err) === "EISDIR" ? "read" : "open",
                path,
            );
        }
    }

    async stat(path: string): Promise<DocStat> {
        try {
            return statOf(await fsp.stat(path, { bigint: true }), false);
        } catch (err) {
            throw toDocFsError(err, "stat", path);
        }
    }

    async lstat(path: string): Promise<DocStat> {
        try {
            const st = await fsp.lstat(path, { bigint: true });
            return statOf(st, st.isSymbolicLink());
        } catch (err) {
            throw toDocFsError(err, "lstat", path);
        }
    }

    async readdir(path: string): Promise<DocDirEntry[]> {
        let ents: Dirent[];
        try {
            ents = await fsp.readdir(path, { withFileTypes: true });
        } catch (err) {
            throw toDocFsError(err, "open", path);
        }
        // Go sorts by name bytes; compare the UTF-8 encodings.
        return ents
            .map((ent) => ({ name: ent.name, kind: kindOf(ent) }))
            .sort((a, b) =>
                Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)),
            );
    }

    async realpath(path: string): Promise<string> {
        // Walk component by component like Go's EvalSymlinks, so a failure
        // names the resolved path that is missing.
        let [dest, rest] = splitRoot(slashPath(path));
        let links = 0;
        while (rest.length > 0) {
            const part = rest.shift() as string;
            const next = posixJoin(dest, part);
            let st: Awaited<ReturnType<typeof fsp.lstat>>;
            try {
                st = await fsp.lstat(next);
            } catch (err) {
                throw toDocFsError(err, "lstat", next);
            }
            if (!st.isSymbolicLink()) {
                dest = next;
                continue;
            }
            if (++links > MAX_LINKS) {
                throw new DocFsError({
                    code: "ELOOP",
                    op: "lstat",
                    path: next,
                });
            }
            const link = slashPath(await fsp.readlink(next));
            const target = isAbsPosix(link) ? link : posixJoin(dest, link);
            const [root, parts] = splitRoot(target);
            rest = [...parts, ...rest];
            dest = root;
        }
        return dest;
    }

    async writeAtomic(
        path: string,
        data: string | Uint8Array,
        opts: WriteAtomicOptions,
    ): Promise<void> {
        const dir = posix.dirname(path);
        let stage: WriteStage = "create";
        let tmp = "";
        let fh: fsp.FileHandle | undefined;
        try {
            [tmp, fh] = await createTemp(dir, opts.tempPrefix, opts.tempSuffix);
            stage = "chmod";
            await fh.chmod(opts.mode);
            stage = "write";
            await fh.writeFile(data);
            stage = "sync";
            await fh.sync();
            stage = "close";
            const open = fh;
            fh = undefined;
            await open.close();
            stage = "rename";
            await fsp.rename(tmp, path);
            tmp = "";
            stage = "syncdir";
            await this.syncDir(dir);
        } catch (err) {
            await fh?.close().catch(() => undefined);
            if (tmp !== "") await fsp.rm(tmp, { force: true });
            if (err instanceof DocFsError) {
                throw new DocFsError({
                    code: err.code,
                    op: err.op,
                    path: err.path,
                    stage,
                    reason: err.reason,
                });
            }
            throw stageError(err, stage, tmp, path, dir);
        }
    }

    async rename(from: string, to: string): Promise<void> {
        try {
            await fsp.lstat(to);
        } catch (err) {
            if (codeOf(err) !== "ENOENT") {
                throw toDocFsError(err, "rename", from, to);
            }
            try {
                await fsp.rename(from, to);
            } catch (err2) {
                throw toDocFsError(err2, "rename", from, to);
            }
            return;
        }
        throw new DocFsError({
            code: "EEXIST",
            op: "rename",
            path: from,
            path2: to,
        });
    }

    async remove(path: string): Promise<void> {
        // Go's os.Remove: unlink, then rmdir; report rmdir's error unless it
        // says the path is not a directory.
        try {
            await fsp.unlink(path);
        } catch (err) {
            try {
                await fsp.rmdir(path);
            } catch (err2) {
                const use = codeOf(err2) === "ENOTDIR" ? err : err2;
                throw toDocFsError(use, "remove", path);
            }
        }
    }

    async mkdir(path: string, mode: number): Promise<void> {
        try {
            await fsp.mkdir(path, { mode });
        } catch (err) {
            throw toDocFsError(err, "mkdir", path);
        }
    }

    async syncDir(path: string): Promise<void> {
        let fh: fsp.FileHandle;
        try {
            fh = await fsp.open(path, "r");
        } catch (err) {
            throw toDocFsError(err, "open", path);
        }
        try {
            await fh.sync();
        } catch (err) {
            throw toDocFsError(err, "sync", path);
        } finally {
            await fh.close();
        }
    }

    async probeWritable(dir: string, prefix: string): Promise<void> {
        const [name, fh] = await createTemp(dir, prefix, "");
        await fh.close();
        await fsp.rm(name, { force: true });
    }
}

/**
 * createTemp creates a new file `<prefix><random><suffix>` in dir with mode
 * 0600, like Go's os.CreateTemp, retrying on a name clash.
 */
async function createTemp(
    dir: string,
    prefix: string,
    suffix: string,
): Promise<[string, fsp.FileHandle]> {
    for (let i = 0; ; i++) {
        const name = posix.join(
            dir,
            `${prefix}${randomInt(2 ** 32 - 1)}${suffix}`,
        );
        try {
            return [name, await fsp.open(name, "wx", 0o600)];
        } catch (err) {
            if (codeOf(err) !== "EEXIST" || i >= 100) {
                throw toDocFsError(err, "open", name);
            }
        }
    }
}

/** stageError converts a non-port failure of writeAtomic's stage. */
function stageError(
    err: unknown,
    stage: WriteStage,
    tmp: string,
    path: string,
    dir: string,
): DocFsError {
    const ops: Record<WriteStage, string> = {
        create: "open",
        chmod: "chmod",
        write: "write",
        sync: "sync",
        close: "close",
        rename: "rename",
        syncdir: "sync",
    };
    return toDocFsError(
        err,
        ops[stage],
        stage === "syncdir" ? dir : tmp,
        stage === "rename" ? path : undefined,
        stage,
    );
}

/** codeOf returns a Node error's code, if any. */
function codeOf(err: unknown): string | undefined {
    const code = (err as { code?: unknown } | null)?.code;
    return typeof code === "string" ? code : undefined;
}

/**
 * toDocFsError converts a Node fs error into a {@link DocFsError} with Go's
 * operation name. A non-errno failure keeps its own message as the reason.
 */
export function toDocFsError(
    err: unknown,
    op: string,
    path: string,
    path2?: string,
    stage?: WriteStage,
): DocFsError {
    const code = codeOf(err);
    const errno = code !== undefined && ERRNO.test(code);
    return new DocFsError({
        code: errno ? code : "EIO",
        op,
        path,
        ...(path2 === undefined ? {} : { path2 }),
        ...(stage === undefined ? {} : { stage }),
        ...(errno
            ? {}
            : { reason: err instanceof Error ? err.message : String(err) }),
    });
}

function kindOf(ent: Dirent): DocDirEntryKind {
    if (ent.isSymbolicLink()) return "symlink";
    if (ent.isDirectory()) return "dir";
    if (ent.isFile()) return "file";
    return "other";
}

function statOf(
    st: {
        isFile(): boolean;
        isDirectory(): boolean;
        size: bigint;
        mtimeNs: bigint;
        mode: bigint;
    },
    isSymlink: boolean,
): DocStat {
    return {
        isFile: st.isFile(),
        isDir: st.isDirectory(),
        isSymlink,
        size: Number(st.size),
        mtimeNs: st.mtimeNs,
        mode: Number(st.mode & 0o777n),
    };
}
