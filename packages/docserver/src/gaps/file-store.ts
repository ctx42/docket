// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// FileStore keeps one Markdown file per gap in a folder, named
// gap-NNNN-<slug>.md: a draft or an open gap at the folder's top, a filled
// or a wontfix gap in its closed subfolder. Every operation reads the gap's
// file, changes only the front-matter keys and body sections it must, and
// writes the file back atomically, so a crash leaves the previous good file.
// A mutex serialises operations. The folder must exist; the store never
// creates it, but creates its closed subfolder on first need and reads a
// missing one as empty.
//
// Both folders form one store: numbers, listings, lookups, duplicate-number
// checks, and the index cover the files of both. A file in the other folder
// than its status belongs in is valid where it is; the next write of the
// gap, or `tidy`, moves it. A write that changes the folder first renames
// the file, unchanged, then rewrites it there, so the file has one name at
// every moment.
//
// Queries rank with a BM25 index over the valid gap files, rebuilt whole:
// by `reindex`, after every write once an index exists, and by a query that
// finds the folders' state (gap file names, sizes, modification times)
// changed since the last build, so edits made outside the server are seen
// without a watcher. A failed rebuild keeps the previous index serving.
//
// An invalid gap file never fails the store: it is left out of listings and
// the index, refused by every operation naming its gap, and never rewritten
// or deleted. Each rebuild reports to `warn` the invalid files the previous
// index did not already know as such.

import { posixDir, posixJoin } from "@docket/core";
import { goQuote } from "../gocompat/strconv.ts";
import { trimSpace } from "../gocompat/strings.ts";
import { formatDateOnly, type GoTime } from "../gocompat/time.ts";
import { type DocFs, DocFsError, isExist, isNotExist } from "../ports.ts";
import { compareBytes } from "../search/bm25.ts";
import { checkSignal, type Signal } from "../util/cancel.ts";
import { Mutex } from "../util/mutex.ts";
import {
    badFile,
    claimedID,
    FileError,
    type GapFile,
    idNumber,
    KEY,
    number,
    parseGapFile,
    trimBlank,
} from "./format.ts";
import {
    type BadFile,
    CLOSED_DIR,
    checkGap,
    checkRequired,
    EC_INVALID,
    EC_NOT_FOUND,
    EC_STATUS,
    FILE_RE,
    type Fill,
    type FillRef,
    type Filter,
    filePath,
    type Gap,
    GapError,
    gapError,
    home,
    isGapError,
    type Move,
    matchFilter,
    type Patch,
    type ResolvedRef,
    type Resolver,
    type StaleReason,
    type StaleRef,
    type Status,
    type Store,
    validateFill,
    validateGap,
    validatePatch,
    validStatus,
} from "./gaps.ts";
import { nonNil, uniqueFold } from "./helpers.ts";
import { GapIndex } from "./index.ts";
import {
    dateNode,
    fillNode,
    intNode,
    listNode,
    newGapFile,
    renderGapFile,
    sectionText,
    setKey,
    setTarget,
    setTopic,
    strNode,
} from "./render.ts";

/** Modes of the files and folders the store creates. */
export const NEW_FILE_MODE = 0o644;
export const NEW_DIR_MODE = 0o755;

/** FileStoreOptions configure a {@link FileStore}. */
export interface FileStoreOptions {
    /**
     * warn receives the index rebuild failures that do not fail an
     * operation, and each invalid gap file a rebuild newly finds (a
     * {@link FileError}). By default they are dropped.
     */
    warn?: (err: Error) => void;
}

/** GapFileName is a gap file found in the folder and its name's number. */
export interface GapFileName {
    name: string;
    num: number;
}

/** GapEntry is a gap file found in the gap folder or its closed subfolder. */
export interface GapEntry {
    /** name is the file's slash-separated path within the gap folder. */
    name: string;
    /** base is the file's directory entry name. */
    base: string;
}

/** FileStore is a gap store over a folder of gap files. */
export class FileStore implements Store {
    /** dir is the gap folder. */
    readonly dir: string;
    /** clock supplies creation and reason timestamps. */
    readonly clock: () => GoTime;
    /** res checks the corpus references a gap stores; none refuses all. */
    readonly res: Resolver | undefined;
    /** warn receives failures that do not fail an operation. */
    readonly warn: (err: Error) => void;
    /** idx is the search index, undefined until first built. */
    idx: GapIndex | undefined;
    /** mu serialises the read-modify-write cycle of every operation. */
    protected readonly mu = new Mutex();

    constructor(
        readonly fs: DocFs,
        dir: string,
        clock: () => GoTime,
        res: Resolver | undefined,
        opts: FileStoreOptions = {},
    ) {
        this.dir = dir;
        this.clock = clock;
        this.res = res;
        this.warn = opts.warn ?? (() => {});
    }

    /**
     * append validates gap and records it as a new open gap, stamping the
     * store-owned fields (ID, status, hits, created, filled_by), and
     * returns the assigned ID.
     */
    append(gap: Gap, signal?: Signal): Promise<string> {
        return this.add(gap, "open", signal);
    }

    /** appendDraft records gap like {@link append}, as a draft. */
    appendDraft(gap: Gap, signal?: Signal): Promise<string> {
        return this.add(gap, "draft", signal);
    }

    /**
     * import records the fully specified gap in a new file, keeping its
     * ID, status, hits, creation time, and filled_by list, to move gaps
     * from another store into the folder. It throws ErrInvalid for a gap
     * checkGap refuses, a doc_id or filled_by entry that does not resolve,
     * or an ID whose number a file already holds. References are stored
     * normalized; a filled_by entry without a hash gets its section's
     * current hash. It returns the gap as written, its file set.
     */
    async import(input: Gap, signal?: Signal): Promise<Gap> {
        const op = `import ${input.id}`;
        let docID: string;
        const refs: FillRef[] = [];
        try {
            checkGap(input);
            docID = await this.resolveDoc(input.docID);
            for (const ref of input.filledBy) {
                const res = await this.resolveFill(trimSpace(ref.ref));
                refs.push({ ref: res.norm, hash: ref.hash || res.hash });
            }
        } catch (err) {
            throw wrap(op, err);
        }
        return this.mu.run(async () => {
            checkSignal(signal);
            const num = idNumber(input.id);
            for (const gfn of await this.scan()) {
                if (gfn.num === num) {
                    const why = `file ${gfn.name} holds its number`;
                    throw wrap(op, gapError(EC_INVALID, why));
                }
            }
            const gap: Gap = {
                ...input,
                docID,
                ask: uniqueFold(input.ask),
                headingPath: nonNil(input.headingPath),
                searchTerms: nonNil(input.searchTerms),
                filledBy: refs,
                score: 0,
                stale: false,
                staleRefs: [],
            };
            gap.file = filePath(gap);
            await this.write(
                gap.file,
                renderGapFile(newGapFile(gap.file, gap)),
            );
            await this.afterWrite();
            return gap;
        });
    }

    /**
     * update applies pch to the draft or open gap id; a new topic rewrites
     * the H1 but keeps the file name.
     */
    async update(id: string, pch: Patch, signal?: Signal): Promise<void> {
        validatePatch(pch);
        const docID =
            pch.docID === undefined ? "" : await this.resolveDoc(pch.docID);
        await this.modify("update", id, ["draft", "open"], "", signal, (gfl) =>
            applyPatch(gfl, pch, docID),
        );
    }

    /** submit makes the draft id an open gap. */
    submit(id: string, signal?: Signal): Promise<void> {
        return this.modify("submit", id, ["draft"], "open", signal, (gfl) =>
            setKey(gfl.meta, KEY.status, strNode("open")),
        );
    }

    /** discard deletes the draft id's file. */
    discard(id: string, signal?: Signal): Promise<void> {
        return this.mu.run(async () => {
            checkSignal(signal);
            let gfl: GapFile;
            try {
                gfl = await this.load(id);
            } catch (err) {
                throw wrap(`discard ${id}`, err);
            }
            checkStatus("discard", gfl.gap, ["draft"]);
            const file = this.path(gfl.name);
            try {
                await this.fs.remove(file);
            } catch (err) {
                throw wrap(`discard ${id}`, err);
            }
            try {
                await this.fs.syncDir(posixDir(file));
            } catch (err) {
                throw wrap("sync gap folder", err);
            }
            await this.afterWrite();
        });
    }

    /**
     * fill records fll's references on the open gap id, normalized, hashed
     * and de-duplicated; a complete fill also accepts a filled gap and
     * makes the gap filled. A remaining text replaces the Detail section.
     */
    async fill(id: string, fll: Fill, signal?: Signal): Promise<void> {
        validateFill(fll);
        const refs: FillRef[] = [];
        for (const ref of fll.refs) {
            const res = await this.resolveFill(trimSpace(ref));
            if (!refs.some((cur) => cur.ref === res.norm))
                refs.push({ ref: res.norm, hash: res.hash });
        }
        const from: Status[] = fll.complete ? ["open", "filled"] : ["open"];
        const to = fll.complete ? "filled" : "";
        await this.modify("fill", id, from, to, signal, (gfl) => {
            setKey(gfl.meta, KEY.filledBy, fillNode(refs));
            if (fll.complete) setKey(gfl.meta, KEY.status, strNode("filled"));
            if (fll.remaining !== undefined)
                gfl.body.detail = sectionText(fll.remaining, false);
        });
    }

    /** reopen makes the filled gap id open again, noting reason in Detail. */
    async reopen(id: string, reason: string, signal?: Signal): Promise<void> {
        checkRequired("reason", reason);
        await this.modify("reopen", id, ["filled"], "open", signal, (gfl) => {
            setKey(gfl.meta, KEY.status, strNode("open"));
            appendDetail(gfl, this.note("Reopened", reason));
        });
    }

    /** wontfix closes the open gap id unfilled, noting reason in Detail. */
    async wontfix(id: string, reason: string, signal?: Signal): Promise<void> {
        checkRequired("reason", reason);
        await this.modify("wontfix", id, ["open"], "wontfix", signal, (gfl) => {
            setKey(gfl.meta, KEY.status, strNode("wontfix"));
            appendDetail(gfl, this.note("Won't fix", reason));
        });
    }

    /**
     * note returns the paragraph recording reason under label, dated from
     * the store clock: "Reopened 2026-07-14: the anchor moved.".
     */
    private note(label: string, reason: string): string {
        return `${label} ${formatDateOnly(this.clock())}: ${trimBlank(reason)}`;
    }

    /**
     * modify applies change to the gap id under the mutex and writes the
     * file back where a gap in status to belongs ("" keeps the current
     * status). A file in the other folder is first moved, unchanged, then
     * rewritten; should the rewrite fail, it is moved back. It throws
     * ErrStatus when the gap's status is not in from; errors are prefixed
     * with op and id.
     */
    private modify(
        op: string,
        id: string,
        from: readonly Status[],
        to: Status | "",
        signal: Signal | undefined,
        change: (gfl: GapFile) => void,
    ): Promise<void> {
        return this.mu.run(async () => {
            checkSignal(signal);
            let gfl: GapFile;
            try {
                gfl = await this.load(id);
            } catch (err) {
                throw wrap(`${op} ${id}`, err);
            }
            checkStatus(op, gfl.gap, from);
            change(gfl);
            const raw = renderGapFile(gfl);
            const dst = home(gfl.name, to === "" ? gfl.gap.status : to);
            try {
                await this.move(gfl.name, dst);
            } catch (err) {
                throw wrap(`${op} ${id}`, err);
            }
            try {
                await this.write(dst, raw);
            } catch (err) {
                // The file is valid in either folder; moving it back only
                // keeps a failed operation from moving it.
                await this.move(dst, gfl.name).catch(() => {});
                throw err;
            }
            await this.afterWrite();
        });
    }

    /**
     * list returns the valid gaps matching filter, each with its stale
     * verdict: by number, or, with a query, by relevance, each with its
     * score.
     */
    async list(filter: Filter, signal?: Signal): Promise<Gap[]> {
        if (filter.status && !validStatus(filter.status)) {
            const why = `unknown status ${goQuote(filter.status)}`;
            throw gapError(EC_INVALID, why);
        }
        return this.mu.run(async () => {
            checkSignal(signal);
            const out: Gap[] = [];
            for (const gap of (await this.readAll()).list) {
                const checked = await this.stale(gap);
                if (matchFilter(filter, checked)) out.push(checked);
            }
            if (trimSpace(filter.query ?? "") === "") return out;
            return this.rank(filter.query as string, out);
        });
    }

    /** badFiles returns the invalid gap files and why, by number. */
    badFiles(signal?: Signal): Promise<BadFile[]> {
        return this.mu.run(async () => {
            checkSignal(signal);
            return (await this.readAll()).bad;
        });
    }

    /**
     * tidy moves every valid gap file lying in the other folder than its
     * status belongs in to where it belongs, and returns the moves made, in
     * scan order. It never touches an invalid file. On failure it throws a
     * {@link TidyError} carrying the moves made before it.
     */
    tidy(signal?: Signal): Promise<Move[]> {
        return this.mu.run(async () => {
            checkSignal(signal);
            const { list } = await this.readAll();
            const moves: Move[] = [];
            let failure: unknown;
            for (const gap of list) {
                const dst = home(gap.file, gap.status);
                if (dst === gap.file) continue;
                try {
                    await this.move(gap.file, dst);
                } catch (err) {
                    failure = err;
                    break;
                }
                moves.push({ from: gap.file, to: dst });
            }
            if (moves.length > 0) await this.afterWrite();
            if (failure !== undefined) throw new TidyError(moves, failure);
            return moves;
        });
    }

    /**
     * stale returns gap with its stale verdict: a filled or an open gap is
     * stale when a filled_by entry records no hash, no longer resolves, or
     * records a hash other than its section's current one.
     */
    private async stale(gap: Gap): Promise<Gap> {
        if (gap.status !== "filled" && gap.status !== "open") return gap;
        const refs: StaleRef[] = [];
        for (const ref of gap.filledBy) {
            let reason: StaleReason;
            try {
                const current = await this.currentHash(ref.ref);
                if (ref.hash === "") reason = "unhashed";
                else if (ref.hash !== current) reason = "changed";
                else continue;
            } catch (err) {
                if (!isGapError(err, EC_INVALID))
                    throw wrap(`check ${gap.id}`, err);
                reason = "vanished";
            }
            refs.push({ ref: ref.ref, reason });
        }
        return { ...gap, stale: refs.length > 0, staleRefs: refs };
    }

    /**
     * rank returns the gaps of list matching text, by relevance, each with
     * its score. The caller holds the mutex.
     */
    private async rank(text: string, list: readonly Gap[]): Promise<Gap[]> {
        const hits = (await this.current()).search(text);
        const byID = new Map(list.map((gap) => [gap.id, gap]));
        const out: Gap[] = [];
        for (const hit of hits) {
            const gap = byID.get(hit.id);
            if (gap !== undefined) out.push({ ...gap, score: hit.score });
        }
        return out;
    }

    /**
     * add validates gap and records it in a new file in status sts,
     * stamping the store-owned fields and returning the assigned ID.
     */
    private async add(
        input: Gap,
        sts: Status,
        signal?: Signal,
    ): Promise<string> {
        validateGap(input);
        const docID = await this.resolveDoc(input.docID);
        return this.mu.run(async () => {
            checkSignal(signal);
            let high = 0;
            for (const gfn of await this.scan()) high = Math.max(high, gfn.num);
            const gap: Gap = {
                ...input,
                id: `gap-${String(high + 1).padStart(4, "0")}`,
                status: sts,
                docID,
                ask: uniqueFold(input.ask),
                headingPath: nonNil(input.headingPath),
                searchTerms: nonNil(input.searchTerms),
                hits: 1,
                created: this.clock(),
                filledBy: [],
            };
            gap.file = filePath(gap);
            await this.write(
                gap.file,
                renderGapFile(newGapFile(gap.file, gap)),
            );
            await this.afterWrite();
            return gap.id;
        });
    }

    /**
     * reindex rebuilds the search index from the folders and returns the
     * number of gaps it holds; on failure the previous index stays.
     */
    reindex(signal?: Signal): Promise<number> {
        return this.mu.run(async () => {
            checkSignal(signal);
            await this.rebuild(await this.state());
            return (this.idx as GapIndex).count;
        });
    }

    /**
     * close releases the search index. The store stays usable; the next
     * query builds a new index.
     */
    close(): Promise<void> {
        return this.mu.run(() => {
            this.idx?.close();
            this.idx = undefined;
        });
    }

    // --- References ---

    /**
     * resolveDoc returns the identity of the document docID names, or ""
     * for an empty docID.
     */
    async resolveDoc(input: string): Promise<string> {
        const docID = trimSpace(input);
        if (docID === "") return "";
        if (docID.includes("#")) {
            const why = `doc_id ${goQuote(docID)} must name a document, not a section`;
            throw gapError(EC_INVALID, why);
        }
        return (await this.resolve(docID)).norm;
    }

    /** resolve returns ref normalized and the hash of its text now. */
    resolve(ref: string): Promise<ResolvedRef> {
        if (this.res === undefined) return Promise.reject(noCorpus(ref));
        return this.res.resolve(ref);
    }

    /** resolveFill resolves a filled_by entry ref. */
    resolveFill(ref: string): Promise<ResolvedRef> {
        if (this.res === undefined) return Promise.reject(noCorpus(ref));
        return this.res.resolveFill(ref);
    }

    /** currentHash returns the hash of ref's text in the current corpus. */
    currentHash(ref: string): Promise<string> {
        if (this.res === undefined) return Promise.reject(noCorpus(ref));
        return this.res.current(ref);
    }

    // --- Index lifecycle (the caller holds the mutex) ---

    /**
     * current returns the index matching the folders' state, rebuilding it
     * when they changed. When the rebuild fails it warns and returns the
     * previous index; with none it throws the failure.
     */
    async current(): Promise<GapIndex> {
        try {
            await this.refresh();
        } catch (err) {
            if (this.idx === undefined) throw err;
            this.warn(wrap("gap index: serving previous index", err));
        }
        return this.idx as GapIndex;
    }

    /**
     * afterWrite rebuilds an existing index after a write, warning on
     * failure: the write itself succeeded, and the next query retries.
     */
    async afterWrite(): Promise<void> {
        if (this.idx === undefined) return;
        try {
            await this.refresh();
        } catch (err) {
            this.warn(wrap("gap index: rebuild after write", err));
        }
    }

    /** refresh rebuilds the index unless it reflects the folders' state. */
    async refresh(): Promise<void> {
        const state = await this.state();
        if (this.idx !== undefined && this.idx.state === state) return;
        await this.rebuild(state);
    }

    /**
     * rebuild replaces the index with one built from the valid gap files
     * now in the folders, recording state, and warns of each invalid file
     * the previous index did not know as invalid for the same reason. On
     * failure the previous index stays.
     */
    async rebuild(state: string): Promise<void> {
        const { list, bad } = await this.readAll();
        const ind = new GapIndex(state, list);
        ind.bad = bad;
        const known = this.idx?.bad ?? [];
        this.idx?.close();
        this.idx = ind;
        for (const bfl of bad) {
            const seen = known.some(
                (k) => k.file === bfl.file && k.reason === bfl.reason,
            );
            if (!seen) this.warn(badFile(bfl.file, new Error(bfl.reason)));
        }
    }

    /**
     * state returns a fingerprint of the gap files of both folders: each
     * one's path, size, and modification time, in {@link entries} order.
     */
    async state(): Promise<string> {
        let out = "";
        for (const ent of await this.entries()) {
            let info: Awaited<ReturnType<DocFs["lstat"]>>;
            try {
                info = await this.fs.lstat(this.path(ent.name));
            } catch (err) {
                if (isNotExist(err)) continue;
                throw wrap("stat gap file", err);
            }
            out += `${ent.name}\0${info.size}\0${info.mtimeNs}\n`;
        }
        return out;
    }

    /**
     * readAll returns the gaps of the valid files, by number, and the
     * invalid files with why, by number, then name. A file gone since the
     * folder was read is in neither.
     */
    async readAll(): Promise<{ list: Gap[]; bad: BadFile[] }> {
        const files = await this.scan();
        const list: Gap[] = [];
        const bad: BadFile[] = [];
        for (const gfn of files) {
            try {
                const gfl = await this.read(gfn.name, peers(gfn, files));
                list.push(gfl.gap);
            } catch (err) {
                if (err instanceof FileError) {
                    bad.push(err.entry());
                } else if (!isGapError(err, EC_NOT_FOUND)) {
                    throw err;
                }
            }
        }
        return { list, bad };
    }

    // --- Files ---

    /**
     * scan returns the gap files of both folders, by number, then path. A
     * file counts by its name alone, valid or not, so a broken file still
     * holds its number.
     */
    async scan(): Promise<GapFileName[]> {
        const out = (await this.entries()).map((ent) => ({
            name: ent.name,
            num: number(
                (FILE_RE.exec(ent.base) as RegExpExecArray)[1] as string,
            ),
        }));
        return out.sort(
            (a, b) => a.num - b.num || compareBytes(a.name, b.name),
        );
    }

    /**
     * entries returns the gap files of the gap folder, in name order, then
     * those of its closed subfolder, in name order; a missing closed
     * subfolder holds none.
     */
    async entries(): Promise<GapEntry[]> {
        const out: GapEntry[] = [];
        for (const sub of ["", CLOSED_DIR]) {
            let ents: Awaited<ReturnType<DocFs["readdir"]>>;
            try {
                ents = await this.fs.readdir(posixJoin(this.dir, sub));
            } catch (err) {
                if (sub !== "" && isNotExist(err)) continue;
                throw wrap("read gap folder", err);
            }
            for (const ent of ents) {
                if (ent.kind === "dir" || !FILE_RE.test(ent.name)) continue;
                const name = sub === "" ? ent.name : `${sub}/${ent.name}`;
                out.push({ name, base: ent.name });
            }
        }
        return out;
    }

    /**
     * load reads and parses the file of gap id. It throws ErrBadFile when
     * the file carrying the id's number is invalid or shares the number, or
     * when no file carries it but an invalid file's front matter states the
     * id; else ErrNotFound when no file carries the number or its id
     * differs.
     */
    async load(id: string): Promise<GapFile> {
        const num = idNumber(id);
        if (num < 0) throw gapError(EC_NOT_FOUND);
        const files = await this.scan();
        const gfn = files.find((f) => f.num === num);
        if (gfn === undefined) return this.claimant(files, id);
        const gfl = await this.read(gfn.name, peers(gfn, files));
        if (gfl.gap.id !== id) throw gapError(EC_NOT_FOUND);
        return gfl;
    }

    /**
     * claimant throws the ErrBadFile error of the first of files whose
     * front matter states id though its name carries another number, or
     * ErrNotFound when none does.
     */
    async claimant(files: readonly GapFileName[], id: string): Promise<never> {
        for (const gfn of files) {
            let raw: string;
            try {
                raw = await this.fs.readText(this.path(gfn.name));
            } catch (err) {
                if (isNotExist(err)) continue;
                throw wrap("read gap file", err);
            }
            if (claimedID(raw) !== id) continue;
            parseGapFile(gfn.name, raw);
        }
        throw gapError(EC_NOT_FOUND);
    }

    /**
     * read reads and parses the gap file name; peers names the other files
     * carrying its number, which make it invalid.
     */
    async read(name: string, others: readonly string[]): Promise<GapFile> {
        let raw: string;
        try {
            raw = await this.fs.readText(this.path(name));
        } catch (err) {
            if (isNotExist(err)) throw gapError(EC_NOT_FOUND);
            throw wrap("read gap file", err);
        }
        const gfl = parseGapFile(name, raw);
        if (others.length === 0) return gfl;
        const dup = `duplicate id ${gfl.gap.id}, also in ${others.join(", ")}`;
        throw badFile(name, new Error(dup));
    }

    /**
     * write replaces the gap file name with raw via a temp file (named not
     * to end in ".md") and an atomic rename, then syncs the folder. An
     * existing file keeps its mode; a new one gets {@link NEW_FILE_MODE}. A
     * missing closed subfolder is created.
     */
    async write(name: string, raw: string): Promise<void> {
        await this.ensureDir(name);
        const file = this.path(name);
        let mode = NEW_FILE_MODE;
        try {
            mode = (await this.fs.stat(file)).mode;
        } catch {
            // A new file.
        }
        try {
            await this.fs.writeAtomic(file, raw, {
                mode,
                tempPrefix: ".gap-",
                tempSuffix: ".tmp",
            });
        } catch (err) {
            const stage = err instanceof DocFsError ? err.stage : undefined;
            throw wrap(WRITE_STAGES[stage ?? "create"], err);
        }
    }

    /**
     * move renames the gap file from to to, creating a missing closed
     * subfolder, then syncs both folders. It does nothing when from equals
     * to, and refuses to replace an existing file.
     */
    async move(from: string, to: string): Promise<void> {
        if (from === to) return;
        await this.ensureDir(to);
        const src = this.path(from);
        const dst = this.path(to);
        let exists = true;
        try {
            await this.fs.lstat(dst);
        } catch (err) {
            if (!isNotExist(err)) throw wrap(`move gap file ${from}`, err);
            exists = false;
        }
        if (exists) throw new Error(`move gap file ${from}: ${to} exists`);
        try {
            await this.fs.rename(src, dst);
        } catch (err) {
            throw wrap("move gap file", err);
        }
        for (const dir of [posixDir(dst), posixDir(src)]) {
            try {
                await this.fs.syncDir(dir);
            } catch (err) {
                throw wrap("sync gap folder", err);
            }
        }
    }

    /**
     * ensureDir creates the closed subfolder, syncing the gap folder, when
     * name lies in it and it does not exist yet.
     */
    async ensureDir(name: string): Promise<void> {
        if (posixDir(name) !== CLOSED_DIR) return;
        try {
            await this.fs.mkdir(posixJoin(this.dir, CLOSED_DIR), NEW_DIR_MODE);
        } catch (err) {
            if (isExist(err)) return;
            throw wrap("create closed gap folder", err);
        }
        try {
            await this.fs.syncDir(this.dir);
        } catch (err) {
            throw wrap("sync gap folder", err);
        }
    }

    /** path returns the filesystem path of name, a path in the folder. */
    path(name: string): string {
        return posixJoin(this.dir, name);
    }
}

/** WRITE_STAGES are Go's messages for each failing step of a write. */
const WRITE_STAGES = {
    create: "create temp gap file",
    chmod: "chmod temp gap file",
    write: "write temp gap file",
    sync: "sync temp gap file",
    close: "close temp gap file",
    rename: "replace gap file",
    syncdir: "sync gap folder",
} as const;

/** TidyError is a failed tidy and the moves it made before failing. */
export class TidyError extends Error {
    constructor(
        readonly moves: Move[],
        cause: unknown,
    ) {
        super(cause instanceof Error ? cause.message : String(cause), {
            cause,
        });
        this.name = "TidyError";
    }
}

/**
 * checkStatus throws ErrStatus for operation op on gap when its status is
 * not one of from.
 */
export function checkStatus(
    op: string,
    gap: Gap,
    from: readonly Status[],
): void {
    if ((from as readonly string[]).includes(gap.status)) return;
    const why = `it is ${gap.status}, the operation needs ${from.join(" or ")}`;
    const err = gapError(EC_STATUS, why);
    throw new GapError(EC_STATUS, `${op} ${gap.id}: ${err.message}`);
}

/** applyPatch applies pch to the file, docID the resolved Patch.docID. */
export function applyPatch(gfl: GapFile, pch: Patch, docID: string): void {
    const fm = gfl.meta;
    if (pch.kind !== undefined) setKey(fm, KEY.kind, strNode(pch.kind));
    if (pch.answer !== undefined) setKey(fm, KEY.answer, strNode(pch.answer));
    if (pch.ask !== undefined)
        setKey(fm, KEY.ask, listNode(uniqueFold(pch.ask)));
    if (pch.asked !== undefined) setKey(fm, KEY.asked, dateNode(pch.asked));
    if (pch.srdRef !== undefined) setKey(fm, KEY.srdRef, strNode(pch.srdRef));
    if (pch.docID !== undefined) setKey(fm, KEY.docID, strNode(docID));
    if (pch.headingPath !== undefined)
        setKey(fm, KEY.headingPath, listNode(pch.headingPath));
    if (pch.searchTerms !== undefined)
        setKey(fm, KEY.searchTerms, listNode(pch.searchTerms));
    if (pch.addHit === true) setKey(fm, KEY.hits, intNode(gfl.gap.hits + 1));
    if (pch.topic !== undefined) setTopic(gfl.body, pch.topic);
    if (pch.demand !== undefined)
        gfl.body.demand = sectionText(pch.demand, false);
    if (pch.detail !== undefined)
        gfl.body.detail = sectionText(pch.detail, false);
    if (pch.targetClaim !== undefined) setTarget(gfl.body, pch.targetClaim);
}

/** appendDetail appends the paragraph note to the Detail section. */
export function appendDetail(gfl: GapFile, note: string): void {
    const detail =
        gfl.gap.detail === "" ? note : `${gfl.gap.detail}\n\n${note}`;
    gfl.body.detail = sectionText(detail, false);
}

/** noCorpus is the ErrInvalid a store without a resolver throws for ref. */
function noCorpus(ref: string): GapError {
    const why = `cannot resolve ${goQuote(ref)}: no corpus to resolve against`;
    return gapError(EC_INVALID, why);
}

/**
 * peers returns the names of the files of files other than gfn that carry
 * its number.
 */
export function peers(
    gfn: GapFileName,
    files: readonly GapFileName[],
): string[] {
    return files
        .filter((cur) => cur.num === gfn.num && cur.name !== gfn.name)
        .map((cur) => cur.name);
}

/**
 * wrap prefixes err's message, as Go's `fmt.Errorf("prefix: %w", err)`
 * does, keeping a gap error's code and err as the cause.
 */
export function wrap(prefix: string, err: unknown): Error {
    const msg = `${prefix}: ${err instanceof Error ? err.message : String(err)}`;
    if (err instanceof GapError)
        return new GapError(err.code, msg, { cause: err });
    return new Error(msg, { cause: err });
}
