// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Corpus retrieval ported from Go `pkg/retrieval`: the retriever contract and
// the BM25 retriever over corpus chunks. Each chunk is indexed with three
// scored fields (body text with the document-path words, title plus aliases,
// heading trail) boosted 1, 3 and 2, and two sort-only tie-breakers
// (document path, start line).

import type { Chunk, Doc } from "../corpus/corpus.ts";
import { Bm25Index } from "./bm25.ts";

/** MAX_K is the largest result count a caller may request. */
export const MAX_K = 100;

/** DEFAULT_K is the result count used when a query's k is not positive. */
export const DEFAULT_K = 10;

/** Query is a retrieval request: free text and a result cap. */
export interface Query {
    text: string;
    /** k caps the results; a non-positive k uses {@link DEFAULT_K}. */
    k?: number;
}

/** Result is one ranked chunk with the citation data callers need. */
export interface Result {
    /** docID is the front-matter id, else docPath. */
    docID: string;
    docPath: string;
    title: string;
    headingPath: string[];
    /** text is the raw Markdown of the section, heading line included. */
    text: string;
    /** sourceURL is the document's canonical URL; "" when unknown. */
    sourceURL: string;
    score: number;
    /**
     * rank is the document's trust rank, 1 the most trusted, 0 for none.
     * Retrievers leave it 0; the engine fills it in after ranking.
     */
    rank: number;
}

/** Retriever ranks corpus chunks against a {@link Query}. */
export interface Retriever {
    search(qry: Query): Promise<Result[]>;
}

/** Indexed fields and their query boosts. */
export const FIELD_TEXT = "text";
export const FIELD_TITLE = "title";
export const FIELD_HEADING = "heading";
export const BOOST_TEXT = 1.0;
export const BOOST_TITLE = 3.0;
export const BOOST_HEADING = 2.0;

/** Sort-only fields breaking score ties. */
export const FIELD_DOC_PATH = "doc_path";
export const FIELD_LINE = "line";

/** SORT orders hits by score, then document path, then start line. */
const SORT = ["-_score", FIELD_DOC_PATH, FIELD_LINE] as const;

/**
 * BM25 ranks chunks with Okapi BM25 over an in-memory index of a corpus
 * snapshot, scored exactly as the Go server's bleve index. Rebuild by
 * constructing a new one.
 */
export class BM25 implements Retriever {
    private readonly idx = new Bm25Index([
        FIELD_TEXT,
        FIELD_TITLE,
        FIELD_HEADING,
    ]);
    private readonly results = new Map<
        string,
        Omit<Result, "score" | "rank">
    >();

    /** @param docs are indexed chunk by chunk, ids `<doc path>#<n>`. */
    constructor(docs: readonly Doc[]) {
        for (const doc of docs) {
            doc.chunks.forEach((chk, i) => {
                const id = `${chk.docPath}#${i}`;
                this.idx.add({
                    id,
                    text: {
                        [FIELD_TEXT]: searchText(chk),
                        [FIELD_TITLE]: titleText(chk),
                        [FIELD_HEADING]: chk.headingPath.join(" "),
                    },
                    keywords: { [FIELD_DOC_PATH]: chk.docPath },
                    numbers: { [FIELD_LINE]: chk.startLine },
                });
                this.results.set(id, {
                    docID: chk.docID,
                    docPath: chk.docPath,
                    title: chk.title,
                    headingPath: chk.headingPath,
                    text: chk.text,
                    sourceURL: chk.sourceURL,
                });
            });
        }
    }

    /**
     * search returns at most k results by descending score, equal scores by
     * document path and then start line. The query runs against body, title
     * and heading at once, title and heading boosted.
     */
    async search(qry: Query): Promise<Result[]> {
        const k = qry.k !== undefined && qry.k > 0 ? qry.k : DEFAULT_K;
        const hits = this.idx.search(
            [
                { field: FIELD_TEXT, text: qry.text, boost: BOOST_TEXT },
                { field: FIELD_TITLE, text: qry.text, boost: BOOST_TITLE },
                { field: FIELD_HEADING, text: qry.text, boost: BOOST_HEADING },
            ],
            { size: k, sort: SORT },
        );
        const out: Result[] = [];
        for (const hit of hits) {
            const r = this.results.get(hit.id);
            if (r !== undefined) out.push({ ...r, score: hit.score, rank: 0 });
        }
        return out;
    }

    /** close releases the index; a no-op kept for the Go contract. */
    async close(): Promise<void> {}
}

/**
 * searchText is a chunk's body field: its document-path words (".md"
 * dropped; "/", "_" and "-" as spaces), a newline, then the section text.
 */
export function searchText(chk: Pick<Chunk, "docPath" | "text">): string {
    const path = chk.docPath.replace(/\.md$/, "").replace(/[/_-]/g, " ");
    return `${path}\n${chk.text}`;
}

/** titleText is a chunk's title field: the title, then any aliases. */
export function titleText(chk: Pick<Chunk, "title" | "aliases">): string {
    return chk.aliases.length === 0
        ? chk.title
        : `${chk.title} ${chk.aliases.join(" ")}`;
}
