// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The BM25 index over a gap folder's valid files, scored exactly as the Go
// server's bleve index: six analyzed fields queried at once with per-field
// boosts, equal scores in ID order.

import { Bm25Index, type MatchClause } from "../search/bm25.ts";
import type { BadFile, Gap } from "./gaps.ts";

/** Indexed gap fields; a query runs against all of them at once. */
export const FIELD_TOPIC = "topic";
export const FIELD_TERMS = "search_terms";
export const FIELD_DEMAND = "demand";
export const FIELD_DETAIL = "detail";
export const FIELD_TARGET = "target_claim";
export const FIELD_SRD_REF = "srd_ref";

/** FIELD_ID is the gap ID, a keyword used only to break score ties. */
export const FIELD_ID = "id";

/**
 * Per-field query boosts: the topic names what the gap is about, the search
 * terms are how agents looked for it, the prose sections only describe it.
 */
export const BOOST_TOPIC = 4.0;
export const BOOST_TERMS = 2.0;
export const BOOST_TARGET = 1.5;
export const BOOST_DEMAND = 1.0;
export const BOOST_DETAIL = 1.0;
export const BOOST_SRD_REF = 1.0;

/** TEXT_FIELDS are the analyzed fields in mapping order. */
const TEXT_FIELDS = [
    FIELD_TOPIC,
    FIELD_TERMS,
    FIELD_DEMAND,
    FIELD_DETAIL,
    FIELD_TARGET,
    FIELD_SRD_REF,
] as const;

/** SORT orders hits by score, then gap ID. */
const SORT = ["-_score", FIELD_ID] as const;

/** GapHit is one gap matching a query and its relevance score. */
export interface GapHit {
    id: string;
    score: number;
}

/**
 * GapIndex is a BM25 index over the valid gap files of a folder, built
 * whole from the folder's state and never updated incrementally.
 */
export class GapIndex {
    /** state is the gap folder's state the index was built from. */
    readonly state: string;
    /** count is the number of indexed gaps. */
    readonly count: number;
    /** bad are the folder's invalid files when the index was built. */
    bad: BadFile[] = [];
    private readonly idx = new Bm25Index(TEXT_FIELDS);
    private closed = false;

    /** Builds the index over list, recording state as the folder state. */
    constructor(state: string, list: readonly Gap[]) {
        this.state = state;
        this.count = list.length;
        // A bleve batch keeps the last operation for a repeated ID.
        const byID = new Map<string, Gap>();
        for (const gap of list) byID.set(gap.id, gap);
        for (const gap of byID.values()) {
            this.idx.add({
                id: gap.id,
                text: {
                    [FIELD_TOPIC]: gap.topic,
                    [FIELD_TERMS]: gap.searchTerms.join("\n"),
                    [FIELD_DEMAND]: gap.demand,
                    [FIELD_DETAIL]: gap.detail,
                    [FIELD_TARGET]: gap.targetClaim,
                    [FIELD_SRD_REF]: gap.srdRef,
                },
                keywords: { [FIELD_ID]: gap.id },
            });
        }
    }

    /**
     * search returns every indexed gap matching text, by descending BM25
     * score, equal scores in ID order; an empty index matches nothing.
     */
    search(text: string): GapHit[] {
        if (this.count === 0) return [];
        if (this.closed) throw new Error("search gaps: index is closed");
        const clauses = [
            fieldQuery(text, FIELD_TOPIC, BOOST_TOPIC),
            fieldQuery(text, FIELD_TERMS, BOOST_TERMS),
            fieldQuery(text, FIELD_TARGET, BOOST_TARGET),
            fieldQuery(text, FIELD_DEMAND, BOOST_DEMAND),
            fieldQuery(text, FIELD_DETAIL, BOOST_DETAIL),
            fieldQuery(text, FIELD_SRD_REF, BOOST_SRD_REF),
        ];
        return this.idx.search(clauses, { size: this.count, sort: SORT });
    }

    /** close releases the index; a later search fails. */
    close(): void {
        this.closed = true;
    }
}

/** fieldQuery builds a match query for text on one field, weighted by boost. */
export function fieldQuery(
    text: string,
    field: string,
    boost: number,
): MatchClause {
    return { field, text, boost };
}
