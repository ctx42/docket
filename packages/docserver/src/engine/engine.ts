// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The retrieval engine ported from Go `pkg/engine`: it ingests named document
// sources (directories walked like Go's `filepath.WalkDir`, or single files)
// into corpus documents, ranks each by trust from its path, indexes the
// chunks for search, and lists the corpus. Every document gets the path
// "<source name>/<relative path>" and is reachable by that path and by its
// identity.

import {
    isAbsPosix,
    posixBase,
    posixClean,
    posixJoin,
    posixRel,
} from "@docket/core";

import { type Doc, Loader } from "../corpus/corpus.ts";
import { type DocFs, errorIs } from "../ports.ts";
import { compareBytes } from "../search/bm25.ts";
import {
    BM25,
    type Query,
    type Result,
    type Retriever,
} from "../search/retrieval.ts";
import { Mutex } from "../util/mutex.ts";

/** EC_DOC_NOT_FOUND is the stable code of {@link NotFoundError}. */
export const EC_DOC_NOT_FOUND = "ECDocNotFound";

/**
 * NotFoundError reports that a document reference is neither the identity
 * nor the path of a corpus document (Go `engine.ErrNotFound`).
 */
export class NotFoundError extends Error {
    readonly code = EC_DOC_NOT_FOUND;

    constructor(ref: string) {
        super(`document not found: ${ref}`);
        this.name = "NotFoundError";
    }
}

/** ClosedError reports a call after {@link Engine.close} (Go `ErrClosed`). */
export class ClosedError extends Error {
    constructor() {
        super("engine closed");
        this.name = "ClosedError";
    }
}

/**
 * CloseReplacedError reports that a reload swapped in the new index but
 * failed to close the one it replaced (Go `ErrCloseReplaced`).
 */
export class CloseReplacedError extends Error {
    constructor(cause: unknown) {
        super(`close replaced index: ${(cause as Error).message}`, { cause });
        this.name = "CloseReplacedError";
    }
}

/** isDocNotFound reports a {@link NotFoundError} anywhere in err's chain. */
export function isDocNotFound(err: unknown): boolean {
    return errorIs(err, (e) => e instanceof NotFoundError);
}

/** Source is one named document source: exactly one of dir or file is set. */
export interface Source {
    /** name prefixes the path of every document minted from the source. */
    name: string;
    /** dir is a directory walked recursively for Markdown files. */
    dir?: string;
    /** file is a single Markdown file. */
    file?: string;
}

/** Ranking assigns each document a trust rank from its path. */
export interface Ranking {
    /**
     * precedence lists document-path prefixes, most trusted first: a
     * document under one gets the 1-based position of the longest prefix
     * it lies under, one under none gets length + 1. Empty ranks nothing.
     */
    precedence?: readonly string[];
    /** unranked is a prefix whose documents get no rank; "" exempts none. */
    unranked?: string;
}

/** rank returns the trust rank of the document at path, 0 for none. */
export function rank(rnk: Ranking, path: string): number {
    const precedence = rnk.precedence ?? [];
    if (precedence.length === 0 || under(path, rnk.unranked ?? "")) return 0;
    let best = precedence.length + 1;
    let longest = -1;
    precedence.forEach((pfx, i) => {
        if (pfx.length > longest && under(path, pfx)) {
            best = i + 1;
            longest = pfx.length;
        }
    });
    return best;
}

/**
 * under reports whether a document path lies under prefix pfx, comparing
 * whole path segments; an empty pfx covers nothing.
 */
export function under(path: string, pfx: string): boolean {
    if (pfx === "") return false;
    return path === pfx || path.startsWith(`${pfx}/`);
}

/** DocInfo identifies one ingested document in a corpus listing. */
export interface DocInfo {
    /** id is the front-matter id, else path. */
    id: string;
    /** path is "<source-name>/<relative-path>". */
    path: string;
    /** rank is the trust rank, 1 the most trusted, 0 for none. */
    rank: number;
    title: string;
}

/** DocRef locates an ingested document and its citation metadata. */
export interface DocRef {
    id: string;
    path: string;
    rank: number;
    /** absPath is the cleaned absolute file path. */
    absPath: string;
    title: string;
    sourceURL: string;
}

/** Document is a whole corpus file with its citation metadata. */
export interface Document {
    id: string;
    path: string;
    rank: number;
    title: string;
    sourceURL: string;
    /** text is the whole source file, front matter included. */
    text: string;
}

/** ClosableRetriever is a retriever holding resources to release. */
export type ClosableRetriever = Retriever & { close?(): void | Promise<void> };

/** Snapshot is one ingested corpus. */
export interface Snapshot {
    ret: ClosableRetriever;
    /** docs maps every document path and identity to its reference. */
    docs: Map<string, DocRef>;
    /** list is the corpus listing sorted by path. */
    list: readonly DocInfo[];
    gen: number;
}

/**
 * RetrieverFactory builds the retriever over the ingested corpus; the
 * default builds {@link BM25}.
 */
export type RetrieverFactory = (
    docs: Doc[],
) => ClosableRetriever | Promise<ClosableRetriever>;

/** EngineOptions configure {@link Engine.create}. */
export interface EngineOptions {
    fs: DocFs;
    sources: readonly Source[];
    ranking?: Ranking;
    /** newRetriever replaces the BM25 retriever (a test seam). */
    newRetriever?: RetrieverFactory;
}

/** Engine serves retrieval over the ingested sources. */
export class Engine {
    /** reloadMu serializes reload and close; closed is guarded by it. */
    private readonly reloadMu = new Mutex();
    private closed = false;
    private snap: Snapshot;
    /** users counts the calls using each snapshot. */
    private readonly users = new Map<Snapshot, number>();
    /** idle wakes a reload waiting for a snapshot's calls to finish. */
    private readonly idle = new Map<Snapshot, () => void>();

    private constructor(
        private readonly opts: EngineOptions,
        snap: Snapshot,
    ) {
        this.snap = snap;
    }

    /**
     * create ingests every Markdown file of the sources in order, ranks each
     * document, and indexes the chunks.
     */
    static async create(opts: EngineOptions): Promise<Engine> {
        return new Engine(opts, await ingest(opts));
    }

    /**
     * reload re-ingests the sources and swaps the new snapshot in; on error
     * the previous snapshot keeps serving. The replaced snapshot's index is
     * closed once calls still using it return; a failure to close it is a
     * {@link CloseReplacedError}, with the new snapshot already serving.
     * After {@link close} it throws {@link ClosedError}.
     */
    reload(): Promise<void> {
        return this.reloadMu.run(async () => {
            if (this.closed) throw new ClosedError();
            const snap = await ingest(this.opts);
            const old = this.snap;
            snap.gen = old.gen + 1;
            this.snap = snap;
            await this.drained(old);
            try {
                await old.ret.close?.();
            } catch (err) {
                throw new CloseReplacedError(err);
            }
        });
    }

    /**
     * search ranks corpus sections against qry; results carry their
     * document's trust rank, which never changes the order.
     */
    search(qry: Query): Promise<Result[]> {
        return this.using(async (snap) => {
            const hits = await snap.ret.search(qry);
            for (const hit of hits)
                hit.rank = snap.docs.get(hit.docPath)?.rank ?? 0;
            return hits;
        });
    }

    /**
     * getDoc returns the whole file whose identity or path is ref, read from
     * disk now, with its citation metadata. It throws {@link NotFoundError}
     * when ref names no document; ref is never joined into a file path.
     */
    async getDoc(ref: string): Promise<Document> {
        const dref = this.snap.docs.get(ref);
        if (dref === undefined) throw new NotFoundError(ref);
        let text: string;
        try {
            text = await this.opts.fs.readText(dref.absPath);
        } catch (err) {
            throw new Error(`read ${dref.path}: ${(err as Error).message}`, {
                cause: err,
            });
        }
        return {
            id: dref.id,
            path: dref.path,
            rank: dref.rank,
            title: dref.title,
            sourceURL: dref.sourceURL,
            text,
        };
    }

    /**
     * generation returns the number of the snapshot now serving: 0 after
     * create, one more after each successful reload.
     */
    generation(): number {
        return this.snap.gen;
    }

    /**
     * unranked reports whether a document path lies under the ranking's
     * unranked prefix, comparing whole segments.
     */
    unranked(path: string): boolean {
        return under(path, this.opts.ranking?.unranked ?? "");
    }

    /** listDocs returns every document sorted by path; do not modify it. */
    listDocs(): readonly DocInfo[] {
        return this.snap.list;
    }

    /**
     * close releases the retriever's index once in-flight calls return. It
     * waits for a reload in progress; later calls are no-ops.
     */
    close(): Promise<void> {
        return this.reloadMu.run(async () => {
            if (this.closed) return;
            this.closed = true;
            await this.drained(this.snap);
            await this.snap.ret.close?.();
        });
    }

    /** using runs fn on the current snapshot, counted as a user. */
    private async using<T>(fn: (snap: Snapshot) => Promise<T>): Promise<T> {
        const snap = this.snap;
        this.users.set(snap, (this.users.get(snap) ?? 0) + 1);
        try {
            return await fn(snap);
        } finally {
            const n = (this.users.get(snap) ?? 1) - 1;
            if (n > 0) {
                this.users.set(snap, n);
            } else {
                this.users.delete(snap);
                this.idle.get(snap)?.();
                this.idle.delete(snap);
            }
        }
    }

    /** drained resolves once no call uses snap. */
    private drained(snap: Snapshot): Promise<void> {
        if (!this.users.has(snap)) return Promise.resolve();
        return new Promise((resolve) => this.idle.set(snap, resolve));
    }
}

/** ingest walks and indexes the sources into a new snapshot. */
export async function ingest(opts: EngineOptions): Promise<Snapshot> {
    const { docs, refs } = await loadSources(
        opts.fs,
        opts.sources,
        opts.ranking ?? {},
    );
    let ret: Retriever;
    try {
        ret = opts.newRetriever
            ? await opts.newRetriever(docs)
            : new BM25(docs);
    } catch (err) {
        throw new Error(`build index: ${(err as Error).message}`, {
            cause: err,
        });
    }
    return { ret, docs: refs, list: docList(refs), gen: 0 };
}

/**
 * loadSources ingests every source in order, returning the documents and
 * the references keyed by every path and identity. A path minted twice, two
 * documents sharing an identity, or an identity equal to another document's
 * path is an error.
 */
export async function loadSources(
    fs: DocFs,
    sources: readonly Source[],
    rnk: Ranking,
): Promise<{ docs: Doc[]; refs: Map<string, DocRef> }> {
    const ldr = new Loader(fs);
    const docs: Doc[] = [];
    const refs = new Map<string, DocRef>();

    const add = async (docPath: string, path: string): Promise<void> => {
        const abs = posixClean(isAbsPosix(path) ? path : `/${path}`);
        const prev = refs.get(docPath);
        if (prev !== undefined) {
            throw new Error(
                `duplicate document path ${docPath}: ${prev.absPath} and ${abs}`,
            );
        }
        const doc = await ldr.file(docPath, path);
        docs.push(doc);
        refs.set(docPath, {
            id: doc.id,
            path: doc.path,
            rank: rank(rnk, doc.path),
            absPath: abs,
            title: doc.title,
            sourceURL: doc.sourceURL,
        });
    };

    for (const src of sources) {
        try {
            await loadSource(fs, src, add);
        } catch (err) {
            throw new Error(
                `ingest source ${src.name}: ${(err as Error).message}`,
                {
                    cause: err,
                },
            );
        }
    }
    addIdentities(docs, refs);
    return { docs, refs };
}

/**
 * addIdentities adds a reference under the identity of every document whose
 * identity differs from its path; an identity already taken is an error
 * naming both files.
 */
function addIdentities(docs: readonly Doc[], refs: Map<string, DocRef>): void {
    for (const doc of docs) {
        if (doc.id === doc.path) continue;
        const ref = refs.get(doc.path) as DocRef;
        const prev = refs.get(doc.id);
        if (prev !== undefined) {
            throw new Error(
                `document id ${doc.id} of ${ref.absPath} is taken by ${prev.absPath}`,
            );
        }
        refs.set(doc.id, ref);
    }
}

/**
 * loadSource calls add with the document path and file path of every
 * Markdown file of src, walking a directory like Go's `filepath.WalkDir`:
 * the root is lstat-ed (a symlinked root is not entered), entries go in
 * name order, symlinked directories are not followed, and a "*.md" entry
 * counts only when it is a regular file or a symlink to one.
 */
async function loadSource(
    fs: DocFs,
    src: Source,
    add: (docPath: string, path: string) => Promise<void>,
): Promise<void> {
    if (src.file !== undefined && src.file !== "") {
        await add(`${src.name}/${posixBase(src.file)}`, src.file);
        return;
    }
    const root = src.dir ?? "";
    const visitFile = async (path: string, kind: string): Promise<void> => {
        if (!path.endsWith(".md")) return;
        if (!(await regularFile(fs, path, kind))) return;
        await add(`${src.name}/${posixRel(root, path)}`, path);
    };
    const info = await fs.lstat(root);
    if (!info.isDir) {
        await visitFile(
            root,
            info.isSymlink ? "symlink" : info.isFile ? "file" : "other",
        );
        return;
    }
    const walk = async (dir: string): Promise<void> => {
        for (const ent of await fs.readdir(dir)) {
            const path = posixJoin(dir, ent.name);
            if (ent.kind === "dir") await walk(path);
            else await visitFile(path, ent.kind);
        }
    };
    await walk(root);
}

/**
 * regularFile reports whether a walked entry is a regular file or a symlink
 * resolving to one; a dangling symlink (an editor lock file) is skipped.
 */
async function regularFile(
    fs: DocFs,
    path: string,
    kind: string,
): Promise<boolean> {
    if (kind !== "symlink") return kind === "file";
    try {
        return (await fs.stat(path)).isFile;
    } catch {
        return false;
    }
}

/** docList returns the listing of refs sorted by path. */
function docList(refs: ReadonlyMap<string, DocRef>): DocInfo[] {
    const list: DocInfo[] = [];
    for (const [key, ref] of refs) {
        if (key !== ref.path) continue;
        list.push({
            id: ref.id,
            path: ref.path,
            rank: ref.rank,
            title: ref.title,
        });
    }
    return list.sort((a, b) => compareBytes(a.path, b.path));
}
