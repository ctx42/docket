// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// An in-memory full-text index that scores exactly as bleve v2.6.0 does for
// the Go server's queries: a disjunction of match queries, one per field,
// over an in-memory scorch index with BM25 scoring and the "en" analyzer.
//
// The arithmetic follows bleve operation for operation so scores are equal
// to the last bit:
//   - a match query analyzes its text into one term query per token
//     (duplicates kept) and ORs them; the match query's own boost reaches
//     only its terms;
//   - idf = ln(1 + (N − df + 0.5) / (df + 0.5)), with Go's own log (JS
//     Math.log can differ in the last bit); the "average length" is
//     ceil(distinct terms of the field / N), as scorch reports it; when that
//     is 0 (a field empty in every document) bleve falls back to TF-IDF;
//   - tf = sqrt(freq); the stored norm is float32(1/sqrt(field length)) and
//     the length is recovered as 1/norm²;
//   - one query norm 1/sqrt(Σ (boost·idf)²) over every term, applied as
//     queryWeight = boost·idf·queryNorm;
//   - each disjunction sums its matching children in bleve's searcher order
//     (ascending match count, stable) and multiplies by matched/total.
// Disjunctions of more than ten children run in bleve's heap searcher,
// whose summation order is not reproduced; such scores can differ in the
// last bits.

import { goLog } from "../gocompat/math.ts";
import { analyze } from "./analyzer.ts";

/** BM25_K1 and BM25_B are bleve's BM25 constants. */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/** IndexDoc is one document: analyzed text fields plus sort values. */
export interface IndexDoc {
    id: string;
    /** text holds the analyzed, scored fields. */
    text: Readonly<Record<string, string>>;
    /** keywords hold whole-value sort fields. */
    keywords?: Readonly<Record<string, string>>;
    /** numbers hold numeric sort fields. */
    numbers?: Readonly<Record<string, number>>;
}

/** MatchClause is one bleve match query on a field. */
export interface MatchClause {
    field: string;
    text: string;
    boost: number;
}

/** SortKey orders hits: "-_score", "<field>" or "-<field>". */
export type SortKey = string;

/** SearchOptions configure {@link Bm25Index.search}. */
export interface SearchOptions {
    /** size caps the hits returned; Infinity returns all. */
    size: number;
    sort: readonly SortKey[];
}

/** Hit is a scored document. */
export interface Hit {
    id: string;
    score: number;
}

interface FieldIndex {
    /** postings maps a term to document number → frequency. */
    postings: Map<string, Map<number, number>>;
    /** lengths holds each document's token count in the field. */
    lengths: number[];
}

interface Leaf {
    field: FieldIndex;
    postings: Map<number, number> | undefined;
    boost: number;
    idf: number;
    avg: number;
    count: number;
    weight: number;
    queryWeight: number;
}

interface Clause {
    /** leaves are in bleve's searcher order; empty for a match-none. */
    leaves: Leaf[];
    count: number;
    weight: number;
}

/** Bm25Index is a write-once index; build a new one to change it. */
export class Bm25Index {
    private readonly fields = new Map<string, FieldIndex>();
    private readonly docs: IndexDoc[] = [];

    /** @param textFields names the analyzed fields documents may carry. */
    constructor(textFields: readonly string[]) {
        for (const f of textFields)
            this.fields.set(f, { postings: new Map(), lengths: [] });
    }

    /** size returns the number of indexed documents. */
    get size(): number {
        return this.docs.length;
    }

    /** add indexes doc. */
    add(doc: IndexDoc): void {
        const num = this.docs.length;
        this.docs.push(doc);
        for (const [name, fi] of this.fields) {
            const tokens = analyze(doc.text[name] ?? "");
            fi.lengths[num] = tokens.length;
            for (const tok of tokens) {
                let docs = fi.postings.get(tok.term);
                if (docs === undefined) {
                    docs = new Map();
                    fi.postings.set(tok.term, docs);
                }
                docs.set(num, (docs.get(num) ?? 0) + 1);
            }
        }
    }

    /**
     * search runs the disjunction of clauses (bleve `DisjunctionQuery` of
     * `MatchQuery`s) and returns the sorted top hits.
     */
    search(clauses: readonly MatchClause[], opts: SearchOptions): Hit[] {
        const n = this.docs.length;
        const built = clauses.map((c) => this.clause(c, n));
        if (built.length === 0) return [];
        const outer = stableByCount(built);
        let sum = 0;
        for (const c of outer) sum += c.weight;
        const queryNorm = 1.0 / Math.sqrt(sum);
        for (const c of outer) {
            for (const l of c.leaves)
                l.queryWeight = l.boost * l.idf * queryNorm;
        }

        const candidates = new Set<number>();
        for (const c of outer) {
            for (const l of c.leaves)
                for (const d of l.postings?.keys() ?? []) candidates.add(d);
        }
        const hits: { num: number; score: number }[] = [];
        for (const num of candidates) {
            let outerSum = 0;
            let outerMatched = 0;
            for (const c of outer) {
                let inner = 0;
                let matched = 0;
                for (const l of c.leaves) {
                    const freq = l.postings?.get(num);
                    if (freq === undefined) continue;
                    inner += leafScore(l, freq, l.field.lengths[num] as number);
                    matched++;
                }
                if (matched === 0) continue;
                outerSum += inner * (matched / c.leaves.length);
                outerMatched++;
            }
            hits.push({ num, score: outerSum * (outerMatched / outer.length) });
        }
        hits.sort((a, b) => this.compare(a, b, opts.sort));
        return hits.slice(0, opts.size).map((h) => ({
            id: (this.docs[h.num] as IndexDoc).id,
            score: h.score,
        }));
    }

    /** clause builds the term searchers of one match query. */
    private clause(c: MatchClause, n: number): Clause {
        const fi = this.fields.get(c.field);
        const terms =
            fi === undefined ? [] : analyze(c.text).map((t) => t.term);
        if (fi === undefined || terms.length === 0)
            return { leaves: [], count: 0, weight: 0 };
        const card = fi.postings.size;
        const avg = n === 0 && card === 0 ? 0 : Math.ceil(card / n);
        const leaves = stableByCount(
            terms.map((term): Leaf => {
                const postings = fi.postings.get(term);
                const df = postings?.size ?? 0;
                const idf =
                    avg > 0
                        ? goLog(1 + (n - df + 0.5) / (df + 0.5))
                        : 1.0 + goLog(n / (df + 1.0));
                const w = c.boost * idf;
                return {
                    field: fi,
                    postings,
                    boost: c.boost,
                    idf,
                    avg,
                    count: df,
                    weight: w * w,
                    queryWeight: 1.0,
                };
            }),
        );
        let weight = 0;
        let count = 0;
        for (const l of leaves) {
            weight += l.weight;
            count += l.count;
        }
        return { leaves, count, weight };
    }

    private compare(
        a: { num: number; score: number },
        b: { num: number; score: number },
        sort: readonly SortKey[],
    ): number {
        for (const key of sort) {
            const desc = key.startsWith("-");
            const name = desc ? key.slice(1) : key;
            let cmp: number;
            if (name === "_score") {
                cmp = a.score < b.score ? -1 : a.score > b.score ? 1 : 0;
            } else {
                const da = this.docs[a.num] as IndexDoc;
                const db = this.docs[b.num] as IndexDoc;
                const na = da.numbers?.[name];
                const nb = db.numbers?.[name];
                if (na !== undefined && nb !== undefined) {
                    cmp = na < nb ? -1 : na > nb ? 1 : 0;
                } else {
                    cmp = compareBytes(
                        da.keywords?.[name] ?? "",
                        db.keywords?.[name] ?? "",
                    );
                }
            }
            if (cmp !== 0) return desc ? -cmp : cmp;
        }
        return a.num - b.num;
    }
}

/** leafScore is bleve's TermQueryScorer.Score for one document. */
function leafScore(l: Leaf, freq: number, length: number): number {
    const tf = Math.sqrt(freq);
    const norm = Math.fround(1.0 / Math.sqrt(length));
    let score: number;
    if (l.avg > 0) {
        const fieldLength = 1 / (norm * norm);
        score =
            (l.idf * (tf * BM25_K1)) /
            (tf + BM25_K1 * (1 - BM25_B + (BM25_B * fieldLength) / l.avg));
    } else {
        score = tf * norm * l.idf;
    }
    if (l.queryWeight !== 1.0) score = score * l.queryWeight;
    return score;
}

/**
 * stableByCount sorts searchers by ascending match count as Go's sort.Sort
 * does for up to twelve elements (insertion sort, hence stable).
 */
function stableByCount<T extends { count: number }>(xs: T[]): T[] {
    return xs
        .map((x, i) => ({ x, i }))
        .sort((a, b) => a.x.count - b.x.count || a.i - b.i)
        .map((e) => e.x);
}

/** compareBytes compares strings by their UTF-8 bytes (Go string order). */
export function compareBytes(a: string, b: string): number {
    if (a === b) return 0;
    const ca = [...a];
    const cb = [...b];
    for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
        const x = (ca[i] as string).codePointAt(0) as number;
        const y = (cb[i] as string).codePointAt(0) as number;
        if (x !== y) return x < y ? -1 : 1;
    }
    return ca.length - cb.length;
}
