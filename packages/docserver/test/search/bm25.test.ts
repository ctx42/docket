// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    Bm25Index,
    compareBytes,
    type MatchClause,
} from "../../src/search/bm25.ts";
import { readGolden } from "../support/golden.ts";

interface ScoreCase {
    name: string;
    text: string[];
    keywords: string[];
    numbers: string[];
    docs: { id: string; fields: Record<string, string | number> }[];
    queries: {
        clauses: MatchClause[];
        size: number;
        sort: string[];
        want: { id: string; score: number }[];
    }[];
}

/** Indexes and queries with the hits bleve returned (oracle `score`). */
const golden = readGolden<ScoreCase[]>(
    new URL("testdata/score.golden.json", import.meta.url),
);

/** build indexes a golden case's documents. */
function build(c: ScoreCase): Bm25Index {
    const idx = new Bm25Index(c.text);
    for (const d of c.docs) {
        const text: Record<string, string> = {};
        const keywords: Record<string, string> = {};
        const numbers: Record<string, number> = {};
        for (const [k, v] of Object.entries(d.fields)) {
            if (c.text.includes(k)) text[k] = String(v);
            if (c.keywords.includes(k)) keywords[k] = String(v);
            if (c.numbers.includes(k)) numbers[k] = Number(v);
        }
        idx.add({ id: d.id, text, keywords, numbers });
    }
    return idx;
}

/**
 * HEAP_TERMS is the clause size from which bleve sums in its heap searcher,
 * whose order follows scorch's run-dependent document numbering; Go itself
 * then varies in the last bits, so those scores are compared within 1e-12.
 */
const HEAP_TERMS = 11;

describe("Bm25Index against bleve", () => {
    const rows = golden.flatMap((c) =>
        c.queries.map(
            (q, i) =>
                [
                    `${c.name} #${i} ${JSON.stringify(q.clauses[0]?.text)}`,
                    c,
                    q,
                ] as const,
        ),
    );

    it.each(rows)("matches bleve for %s", (_, c, q) => {
        const have = build(c).search(q.clauses, { size: q.size, sort: q.sort });

        expect(have.map((h) => h.id)).toEqual(q.want.map((h) => h.id));
        const heap = q.clauses.some(
            (cl) => cl.text.split(/\s+/).length >= HEAP_TERMS,
        );
        for (const [i, h] of have.entries()) {
            const want = q.want[i]?.score as number;
            if (heap)
                expect(Math.abs(h.score - want) / want).toBeLessThan(1e-12);
            else expect(h.score).toBe(want);
        }
    });
});

describe("Bm25Index", () => {
    it("returns nothing for no clauses, an empty index, or an unknown field", () => {
        const idx = new Bm25Index(["text"]);

        expect(idx.search([], { size: 10, sort: ["-_score"] })).toEqual([]);
        expect(
            idx.search([{ field: "text", text: "x", boost: 1 }], {
                size: 10,
                sort: [],
            }),
        ).toEqual([]);

        idx.add({ id: "a", text: { text: "apple" } });
        expect(idx.size).toBe(1);
        expect(
            idx.search([{ field: "nope", text: "apple", boost: 1 }], {
                size: 10,
                sort: [],
            }),
        ).toEqual([]);
    });

    it("sorts by descending keyword and falls back to insertion order", () => {
        const idx = new Bm25Index(["text"]);
        idx.add({ id: "a", text: { text: "apple" }, keywords: { k: "x" } });
        idx.add({ id: "b", text: { text: "apple" }, keywords: { k: "y" } });
        idx.add({ id: "c", text: { text: "apple" } });
        const q = [{ field: "text", text: "apple", boost: 1 }];

        expect(
            idx.search(q, { size: 10, sort: ["-k"] }).map((h) => h.id),
        ).toEqual(["b", "a", "c"]);
        expect(idx.search(q, { size: 10, sort: [] }).map((h) => h.id)).toEqual([
            "a",
            "b",
            "c",
        ]);
    });
});

describe("compareBytes", () => {
    it.each([
        ["a", "a", 0],
        ["a", "b", -1],
        ["b", "a", 1],
        ["a", "ab", -1],
        ["￿", "😀", -1],
        ["é", "z", 1],
    ])("orders %j and %j like Go", (a, b, want) => {
        expect(Math.sign(compareBytes(a, b))).toBe(want);
    });
});
