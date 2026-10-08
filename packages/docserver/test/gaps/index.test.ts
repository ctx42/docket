// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { emptyGap, type Gap } from "../../src/gaps/gaps.ts";
import {
    BOOST_DEMAND,
    BOOST_DETAIL,
    BOOST_SRD_REF,
    BOOST_TARGET,
    BOOST_TERMS,
    BOOST_TOPIC,
    FIELD_DEMAND,
    FIELD_DETAIL,
    FIELD_ID,
    FIELD_SRD_REF,
    FIELD_TARGET,
    FIELD_TERMS,
    FIELD_TOPIC,
    fieldQuery,
    GapIndex,
} from "../../src/gaps/index.ts";
import { parseTime } from "../../src/gocompat/time.ts";
import { analyze } from "../../src/search/analyzer.ts";
import { readGolden } from "../support/golden.ts";

/** gap returns a gap with id and the given fields set. */
function gap(id: string, fields: Partial<Gap> = {}): Gap {
    return { ...emptyGap(), id, ...fields };
}

/**
 * RANKED_GAPS are three gaps on distinct topics: "download token" matches
 * the second by its topic and the third only by a search term.
 */
const RANKED_GAPS: Gap[] = [
    gap("gap-0001", {
        kind: "missing",
        topic: "Shipping rates for Canada",
        demand: "SRD-2 prices parcels.",
        detail: "No rate table.",
    }),
    gap("gap-0002", {
        kind: "missing",
        srdRef: "SRD-7",
        topic: "EPUB download token lifetime",
        demand: "SRD-7 needs the token lifetime.",
        detail: "Never stated.",
    }),
    gap("gap-0003", {
        kind: "incomplete",
        srdRef: "SRD-9",
        searchTerms: ["download"],
        topic: "Gift card expiry",
        demand: "SRD-9 sells gift cards.",
        detail: "Expiry rules missing.",
    }),
];

describe("GapIndex", () => {
    // go: Test_newIndex
    it("records state and count", () => {
        // --- Given ---
        const list = [
            gap("gap-0001", { topic: "a" }),
            gap("gap-0002", { topic: "b" }),
        ];

        // --- When ---
        const have = new GapIndex("state", list);

        // --- Then ---
        expect(have.state).toBe("state");
        expect(have.count).toBe(2);
        expect(have.bad).toEqual([]);
    });

    // go: Test_index_search
    it("ranks a topic match above a search-term match", () => {
        // --- Given ---
        const ind = new GapIndex("", RANKED_GAPS);

        // --- When ---
        const have = ind.search("download token");

        // --- Then ---
        expect(have.map((h) => h.id)).toEqual(["gap-0002", "gap-0003"]);
        expect(have[0]?.score).toBeGreaterThan(have[1]?.score as number);
        expect(have[1]?.score).toBeGreaterThan(0);
    });

    // go: Test_index_search_fields_tabular
    it.each([
        ["topic", { topic: "parcel" }, "parcels"],
        ["search terms", { searchTerms: ["x", "parcel"] }, "parcel"],
        ["demand", { demand: "parcel" }, "parcel"],
        ["detail", { detail: "parcel" }, "parcel"],
        ["target claim", { targetClaim: "parcel" }, "parcel"],
        ["srd ref", { srdRef: "checkout/srd.md" }, "checkout"],
    ] as [string, Partial<Gap>, string][])(
        "searches the %s",
        (_name, fields, qry) => {
            // --- Given ---
            const ind = new GapIndex("", [gap("gap-0001", fields)]);

            // --- When ---
            const have = ind.search(qry);

            // --- Then ---
            expect(have).toHaveLength(1);
        },
    );

    // go: Test_index_search_topic_outranks_prose
    it("weights the topic above prose", () => {
        // --- Given ---
        const ind = new GapIndex("", [
            gap("gap-0001", { topic: "Gift cards", detail: "Parcel weight." }),
            gap("gap-0002", { topic: "Parcel weight", detail: "Gift cards." }),
        ]);

        // --- When ---
        const have = ind.search("parcel weight");

        // --- Then ---
        expect(have.map((h) => h.id)).toEqual(["gap-0002", "gap-0001"]);
    });

    // go: Test_index_search_equal_scores_in_id_order
    it("orders equal scores by ID", () => {
        // --- Given ---
        const ind = new GapIndex("", [
            gap("gap-0002", { topic: "Parcel weight" }),
            gap("gap-0001", { topic: "Parcel weight" }),
        ]);

        // --- When ---
        const have = ind.search("parcel");

        // --- Then ---
        expect(have.map((h) => h.id)).toEqual(["gap-0001", "gap-0002"]);
    });

    // go: Test_index_search_no_match
    it("returns no hits without a match", () => {
        // --- Given ---
        const ind = new GapIndex("", [gap("gap-0001", { topic: "a b" })]);

        // --- When ---
        const have = ind.search("parcel");

        // --- Then ---
        expect(have).toEqual([]);
    });

    // go: Test_index_search_empty_index
    it("returns no hits from an empty index", () => {
        // --- Given ---
        const ind = new GapIndex("", []);

        // --- When ---
        const have = ind.search("parcel");

        // --- Then ---
        expect(have).toEqual([]);
    });

    // go: Test_index_search_error_closed
    it("refuses a search once closed", () => {
        // --- Given ---
        const ind = new GapIndex("", [gap("gap-0001", { topic: "parcel" })]);
        ind.close();

        // --- When ---
        const have = () => ind.search("parcel");

        // --- Then ---
        expect(have).toThrow("search gaps: index is closed");
    });

    // go: Test_index_close
    it("closes an empty index", () => {
        // --- Given ---
        const ind = new GapIndex("", []);

        // --- When ---
        ind.close();

        // --- Then ---
        expect(ind.search("parcel")).toEqual([]);
    });
});

describe("fieldQuery", () => {
    // go: Test_fieldQuery
    it("builds a boosted match on one field", () => {
        // --- When ---
        const have = fieldQuery("parcel", FIELD_TOPIC, BOOST_TOPIC);

        // --- Then ---
        expect(have).toEqual({ field: "topic", text: "parcel", boost: 4 });
    });
});

describe("index mapping", () => {
    // go: Test_indexMapping
    it("indexes six boosted text fields and the ID keyword", () => {
        expect([
            FIELD_TOPIC,
            FIELD_TERMS,
            FIELD_DEMAND,
            FIELD_DETAIL,
            FIELD_TARGET,
            FIELD_SRD_REF,
            FIELD_ID,
        ]).toEqual([
            "topic",
            "search_terms",
            "demand",
            "detail",
            "target_claim",
            "srd_ref",
            "id",
        ]);
        expect([
            BOOST_TOPIC,
            BOOST_TERMS,
            BOOST_DEMAND,
            BOOST_DETAIL,
            BOOST_TARGET,
            BOOST_SRD_REF,
        ]).toEqual([4, 2, 1, 1, 1.5, 1]);
    });
});

interface GoldenGap {
    id: string;
    srd_ref: string;
    search_terms: string[] | null;
    topic: string;
    demand: string;
    detail: string;
    target_claim: string;
    created: string;
}

interface GoldenSet {
    gaps: GoldenGap[];
    results: {
        query: string;
        hits: { id: string; score: number }[];
    }[];
}

/** Gap sets, queries, and Go's gap index hits (oracle `gapscore`). */
const golden = readGolden<GoldenSet[]>(
    new URL("testdata/gapscore.golden.json", import.meta.url),
);

/**
 * heap reports a query whose match clauses exceed ten terms: bleve scores
 * those in its heap searcher, whose summation order is not deterministic.
 */
function heap(query: string): boolean {
    return analyze(query).length > 10;
}

describe("gapscore golden", () => {
    const rows = golden.flatMap((set, s) =>
        set.results.map((res) => [s, res.query, set, res] as const),
    );

    it.each(rows)("set %i query %j ranks like Go", (_s, query, set, res) => {
        // --- Given ---
        const ind = new GapIndex(
            "",
            set.gaps.map((g) =>
                gap(g.id, {
                    srdRef: g.srd_ref,
                    searchTerms: g.search_terms ?? [],
                    topic: g.topic,
                    demand: g.demand,
                    detail: g.detail,
                    targetClaim: g.target_claim,
                    created: parseTime("RFC3339", g.created),
                }),
            ),
        );

        // --- When ---
        const have = ind.search(query);

        // --- Then ---
        expect(have.map((h) => h.id)).toEqual(res.hits.map((h) => h.id));
        if (heap(query)) {
            have.forEach((h, i) => {
                const want = res.hits[i]?.score as number;
                expect(Math.abs(h.score - want)).toBeLessThan(1e-12);
            });
        } else {
            expect(have).toEqual(res.hits);
        }
    });
});
