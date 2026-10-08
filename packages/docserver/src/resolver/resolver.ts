// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// DocResolver resolves the corpus references a gap stores against the
// engine's corpus, reading a referenced document from disk at call time so
// a section reference is checked against the document's current headings.
// It keeps the gap store free of corpus parsing.
//
// `current` caches each reference's hash, or its failure to resolve, until
// the engine's corpus generation changes, so listing gaps reads a referenced
// document once per snapshot; `resolve` always reads the disk and updates
// the cache.

import { anchors, section } from "../corpus/corpus.ts";
import { type Engine, isDocNotFound } from "../engine/engine.ts";
import {
    EC_INVALID,
    type GapError,
    gapError,
    hash,
    isGapError,
    type ResolvedRef,
    type Resolver,
} from "../gaps/gaps.ts";
import { goQuote } from "../gocompat/strconv.ts";
import { isNotExist } from "../ports.ts";

/** Resolved is the outcome of hashing one reference. */
interface Resolved {
    hash: string;
    /** err is the ErrInvalid the reference failed with. */
    err?: Error;
}

/** Target is a reference normalized, its document path and text hash. */
interface Target {
    norm: string;
    path: string;
    hash: string;
}

/** DocResolver is a gap {@link Resolver} over an engine's corpus. */
export class DocResolver implements Resolver {
    /** gen is the engine generation the cache reflects. */
    private gen = 0;
    /** cache holds each looked-up reference's outcome. */
    cache: Map<string, Resolved> | undefined;

    constructor(readonly eng: Engine) {}

    /**
     * resolve matches a section's anchor against the document's heading
     * anchors; the hashed text is the section for a section and the body
     * without front matter for a document. A document whose file vanished
     * or whose front matter does not parse does not resolve.
     */
    resolve(ref: string): Promise<ResolvedRef> {
        return this.resolveNow(ref, false);
    }

    /**
     * resolveFill resolves ref like {@link resolve} and refuses a document
     * under the engine's unranked (initiatives) prefix: an SRD never fills
     * a gap.
     */
    resolveFill(ref: string): Promise<ResolvedRef> {
        return this.resolveNow(ref, true);
    }

    async current(ref: string): Promise<string> {
        const gen = this.eng.generation();
        const hit = this.lookup(gen, ref);
        if (hit !== undefined) {
            if (hit.err !== undefined) throw hit.err;
            return hit.hash;
        }
        try {
            const tgt = await this.target(ref);
            this.store(gen, ref, { hash: tgt.hash });
            return tgt.hash;
        } catch (err) {
            if (isGapError(err, EC_INVALID))
                this.store(gen, ref, { hash: "", err: err as Error });
            throw err;
        }
    }

    /**
     * resolveNow resolves ref from disk, refusing an unranked document when
     * fill is set, and caches the outcome of a resolved ref.
     */
    private async resolveNow(ref: string, fill: boolean): Promise<ResolvedRef> {
        const gen = this.eng.generation();
        const tgt = await this.target(ref);
        if (fill && this.eng.unranked(tgt.path)) {
            const why =
                `${goQuote(ref)} names ${tgt.path}, a document under the ` +
                "initiatives folder; only a corpus document outside it fills a gap";
            throw gapError(EC_INVALID, why);
        }
        this.store(gen, tgt.norm, { hash: tgt.hash });
        return { norm: tgt.norm, hash: tgt.hash };
    }

    /**
     * lookup returns the cached outcome for ref, dropping the cache first
     * when it reflects a generation other than gen.
     */
    private lookup(gen: number, ref: string): Resolved | undefined {
        if (this.gen !== gen) {
            this.gen = gen;
            this.cache = undefined;
        }
        return this.cache?.get(ref);
    }

    /**
     * store caches out for ref when the cache reflects gen, the generation
     * out was computed under; an outcome computed across a reload is not
     * cached.
     */
    store(gen: number, ref: string, out: Resolved): void {
        if (this.gen !== gen) return;
        this.cache ??= new Map();
        this.cache.set(ref, out);
    }

    /** target reads the document ref names and hashes the text it names. */
    private async target(ref: string): Promise<Target> {
        const at = ref.indexOf("#");
        const ident = at < 0 ? ref : ref.slice(0, at);
        let doc: Awaited<ReturnType<Engine["getDoc"]>>;
        try {
            doc = await this.eng.getDoc(ident);
        } catch (err) {
            if (isDocNotFound(err) || isNotExist(err)) {
                const why = `${goQuote(ident)} names no corpus document`;
                throw gapError(EC_INVALID, why);
            }
            throw err;
        }
        if (at < 0) {
            let body: string;
            try {
                body = anchors(doc.text).body;
            } catch (err) {
                throw unparsable(doc.id, err);
            }
            return { norm: doc.id, path: doc.path, hash: hash(body) };
        }
        const anchor = ref.slice(at + 1);
        let found: { text: string; found: boolean };
        try {
            found = section(doc.text, anchor);
        } catch (err) {
            throw unparsable(doc.id, err);
        }
        if (!found.found) {
            const why = `document ${goQuote(doc.id)} has no heading with anchor ${goQuote(anchor)}`;
            throw gapError(EC_INVALID, why);
        }
        return {
            norm: `${doc.id}#${anchor}`,
            path: doc.path,
            hash: hash(found.text),
        };
    }
}

/** unparsable is the ErrInvalid of the document ident failing to parse. */
function unparsable(ident: string, err: unknown): GapError {
    const msg = err instanceof Error ? err.message : String(err);
    const out = gapError(
        EC_INVALID,
        `document ${goQuote(ident)} does not parse: ${msg}`,
    );
    out.cause = err;
    return out;
}
