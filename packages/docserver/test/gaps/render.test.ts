// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { type Body, parseGapFile } from "../../src/gaps/format.ts";
import { emptyGap, type FillRef, type Gap } from "../../src/gaps/gaps.ts";
import {
    dateNode,
    encodeKey,
    fillNode,
    intNode,
    joinLines,
    keyNode,
    listNode,
    newGapFile,
    predecessor,
    renderGapFile,
    renderMeta,
    setKey,
    setTarget,
    setTopic,
    strNode,
    timeNode,
} from "../../src/gaps/render.ts";
import { parseTime } from "../../src/gocompat/time.ts";
import { encodeNode } from "../../src/yamlv3/encode.ts";
import { parseYaml, type YamlNode } from "../../src/yamlv3/node.ts";
import { readGolden } from "../support/golden.ts";

/** MINIMAL_FILE is a valid gap file carrying only the required keys. */
const MINIMAL_FILE =
    "---\nid: gap-0003\nstatus: open\nkind: wrong\nhits: 2\ncreated: 2026-07-14T10:00:00Z\n---\n" +
    "# Topic\n## Demand\n## Detail\n## Target claim";

/** AUTHORED_FILE is the file a new gap-0001 holds for the authored gap. */
const AUTHORED_FILE =
    "---\n" +
    "id: gap-0001\n" +
    "status: open\n" +
    "kind: missing\n" +
    "answer: deferred\n" +
    "ask: []\n" +
    'asked: ""\n' +
    "srd_ref: SRD-7 §4.3\n" +
    "doc_id: epub\n" +
    "heading_path:\n" +
    "  - Catalog\n" +
    "  - Delivery\n" +
    "search_terms:\n" +
    "  - token\n" +
    "  - ttl\n" +
    "hits: 1\n" +
    "created: 2026-07-14T10:00:00Z\n" +
    "filled_by: []\n" +
    "---\n" +
    "# EPUB download token TTL\n" +
    "\n" +
    "## Demand\n" +
    "\n" +
    "SRD-7 needs the token TTL.\n" +
    "\n" +
    "## Detail\n" +
    "\n" +
    "TTL never stated.\n" +
    "\n" +
    "## Target claim\n" +
    "\n" +
    "Token valid 24h.\n";

function emptyBody(): Body {
    return {
        lead: "",
        h1: "",
        intro: "",
        headDemand: "",
        demand: "",
        headDetail: "",
        detail: "",
        headTarget: "",
        target: "",
        tail: "",
    };
}

describe("newGapFile", () => {
    // go: Test_newGapFile
    it("renders every key and section", () => {
        // --- Given ---
        const gap: Gap = {
            ...emptyGap(),
            id: "gap-0001",
            status: "open",
            kind: "missing",
            answer: "deferred",
            srdRef: "SRD-7 §4.3",
            docID: "epub",
            headingPath: ["Catalog", "Delivery"],
            searchTerms: ["token", "ttl"],
            hits: 1,
            created: parseTime("RFC3339", "2026-07-14T10:00:00Z"),
            topic: "EPUB download token TTL",
            demand: "SRD-7 needs the token TTL.",
            detail: "TTL never stated.",
            targetClaim: "Token valid 24h.",
        };

        // --- When ---
        const have = newGapFile("gap-0001-epub-download-token-ttl.md", gap);

        // --- Then ---
        expect(renderGapFile(have)).toBe(AUTHORED_FILE);
    });
});

describe("renderMeta", () => {
    // go: Test_frontMatter_render_adds_key_after_predecessor
    it("adds a key after its predecessor", () => {
        // --- Given ---
        const gfl = parseGapFile("gap-0003-t.md", MINIMAL_FILE);
        setKey(gfl.meta, "answer", strNode("unknown"));
        setKey(gfl.meta, "filled_by", fillNode([{ ref: "epub", hash: "" }]));
        setKey(gfl.meta, "zz", strNode("last"));

        // --- When ---
        const have = renderMeta(gfl.meta);

        // --- Then ---
        expect(have).toBe(
            "id: gap-0003\n" +
                "status: open\n" +
                "kind: wrong\n" +
                "answer: unknown\n" +
                "hits: 2\n" +
                "created: 2026-07-14T10:00:00Z\n" +
                "filled_by:\n" +
                "  - ref: epub\n" +
                "zz: last\n",
        );
    });

    // go: Test_frontMatter_render_flow_mapping
    it("re-encodes a flow mapping whole", () => {
        // --- Given ---
        const src =
            "---\n" +
            "{id: gap-0003, status: open, kind: wrong, hits: 1,\n" +
            " created: 2026-07-14T10:00:00Z, x: y}\n" +
            "---\n" +
            "# T\n## Demand\n## Detail\n## Target claim\n";
        const gfl = parseGapFile("gap-0003-t.md", src);
        setKey(gfl.meta, "status", strNode("wontfix"));
        setKey(gfl.meta, "srd_ref", strNode("SRD-1"));

        // --- When ---
        const have = renderMeta(gfl.meta);

        // --- Then ---
        expect(have).toBe(
            "{id: gap-0003, status: wontfix, kind: wrong, hits: 1, created: " +
                "'2026-07-14T10:00:00Z', x: y, srd_ref: SRD-1}\n",
        );
    });

    it("keeps the last value set for a key", () => {
        // --- Given ---
        const gfl = parseGapFile("gap-0003-t.md", MINIMAL_FILE);
        setKey(gfl.meta, "status", strNode("wontfix"));
        setKey(gfl.meta, "status", strNode("filled"));

        // --- When ---
        const have = renderMeta(gfl.meta);

        // --- Then ---
        expect(have).toContain("status: filled\n");
        expect(gfl.meta.edits).toHaveLength(1);
    });
});

describe("renderGapFile", () => {
    it("names the file when encoding fails", () => {
        // --- Given ---
        const gfl = parseGapFile("gap-0003-t.md", MINIMAL_FILE);
        setKey(gfl.meta, "zz", { ...strNode("x"), anchor: "a.b" });

        // --- When ---
        const have = () => renderGapFile(gfl);

        // --- Then ---
        expect(have).toThrow(
            "encode gap-0003-t.md: yaml: anchor value must contain " +
                "alphanumerical characters only",
        );
    });
});

describe("predecessor", () => {
    // go: Test_predecessor_tabular
    it.each([
        ["first", "id", ""],
        ["after id", "status", "id"],
        ["skips absent", "srd_ref", "kind"],
        ["ask after kind", "asked", "kind"],
        ["unknown key", "zz", ""],
    ])("%s", (_name, key, want) => {
        // --- Given ---
        const present = new Set(["id", "kind", "x"]);

        // --- When ---
        const have = predecessor(key, present);

        // --- Then ---
        expect(have).toBe(want);
    });
});

describe("dateNode", () => {
    // go: Test_dateNode_tabular
    it.each([
        ["date", "2026-10-04", "asked: 2026-10-04\n"],
        ["empty", "", 'asked: ""\n'],
    ])("%s", (_name, val, want) => {
        // --- When ---
        const have = dateNode(val);

        // --- Then ---
        expect(joinLines(encodeKey("asked", have))).toBe(want);
    });
});

describe("setTarget", () => {
    // go: Test_body_setTarget_tabular
    it.each([
        ["last", "", "c", "\nc\n"],
        ["last empty", "", "", ""],
        ["before tail", "## Notes\n", "c", "\nc\n\n"],
        ["empty before tail", "## Notes\n", " ", "\n"],
    ])("%s", (_name, tail, text, want) => {
        // --- Given ---
        const bdy = { ...emptyBody(), tail };

        // --- When ---
        setTarget(bdy, text);

        // --- Then ---
        expect(bdy.target).toBe(want);
    });

    it("ends an unterminated heading", () => {
        // --- Given ---
        const bdy = { ...emptyBody(), headTarget: "## Target claim" };

        // --- When ---
        setTarget(bdy, "c");

        // --- Then ---
        expect(bdy.headTarget).toBe("## Target claim\n");
    });
});

describe("setTopic", () => {
    // go: Test_body_setTopic
    it("replaces the H1", () => {
        // --- Given ---
        const bdy = { ...emptyBody(), h1: "#  Old\n" };

        // --- When ---
        setTopic(bdy, "New");

        // --- Then ---
        expect(bdy.h1).toBe("# New\n");
    });
});

/** NodeSpec is the oracle's node constructor selector. */
interface NodeSpec {
    str?: string;
    int?: number;
    time?: string;
    date?: string;
    list?: string[];
    fill?: { ref: string; hash?: string }[];
    key?: string;
}

interface GoldenGap {
    id: string;
    status: string;
    kind: string;
    answer: string;
    ask: string[] | null;
    asked: string;
    srd_ref: string;
    doc_id: string;
    heading_path: string[] | null;
    search_terms: string[] | null;
    hits: number;
    created: string;
    filled_by: FillRef[] | null;
    topic: string;
    demand: string;
    detail: string;
    target_claim: string;
}

interface GoldenCase {
    key?: string;
    node?: NodeSpec;
    yaml?: string;
    name?: string;
    src?: string;
    new?: GoldenGap;
    sets?: { key: string; node: NodeSpec }[];
    topic?: string;
    target?: string;
    out?: string;
    err?: string;
}

/** specNode builds the node the oracle's spec selects. */
function specNode(spec: NodeSpec): YamlNode {
    if (spec.str !== undefined) return strNode(spec.str);
    if (spec.int !== undefined) return intNode(spec.int);
    if (spec.time !== undefined)
        return timeNode(parseTime("RFC3339", spec.time));
    if (spec.date !== undefined) return dateNode(spec.date);
    if (spec.list !== undefined) return listNode(spec.list);
    if (spec.fill !== undefined) {
        return fillNode(
            spec.fill.map((f) => ({ ref: f.ref, hash: f.hash ?? "" })),
        );
    }
    return keyNode(spec.key as string);
}

/** goldenGap converts the oracle's JSON gap. */
function goldenGap(raw: GoldenGap): Gap {
    return {
        ...emptyGap(),
        id: raw.id,
        status: raw.status as Gap["status"],
        kind: raw.kind as Gap["kind"],
        answer: raw.answer as Gap["answer"],
        ask: raw.ask ?? [],
        asked: raw.asked,
        srdRef: raw.srd_ref,
        docID: raw.doc_id,
        headingPath: raw.heading_path ?? [],
        searchTerms: raw.search_terms ?? [],
        hits: raw.hits,
        created: parseTime("RFC3339", raw.created),
        filledBy: (raw.filled_by ?? []).map((f) => ({
            ref: f.ref,
            hash: f.hash ?? "",
        })),
        topic: raw.topic,
        demand: raw.demand,
        detail: raw.detail,
        targetClaim: raw.target_claim,
    };
}

/** run renders the case as the oracle does. */
function run(tc: GoldenCase): string {
    if (tc.node !== undefined)
        return joinLines(encodeKey(tc.key ?? "", specNode(tc.node)));
    if (tc.yaml !== undefined)
        return encodeNode(parseYaml(tc.yaml) as YamlNode);
    const gfl =
        tc.new !== undefined
            ? newGapFile(tc.name ?? "", goldenGap(tc.new))
            : parseGapFile(tc.name ?? "", tc.src ?? "");
    for (const set of tc.sets ?? [])
        setKey(gfl.meta, set.key, specNode(set.node));
    if (tc.topic !== undefined) setTopic(gfl.body, tc.topic);
    if (tc.target !== undefined) setTarget(gfl.body, tc.target);
    return renderGapFile(gfl);
}

/** Render cases and the bytes Go produced (oracle `gapfmt`). */
const golden = readGolden<GoldenCase[]>(
    new URL("testdata/gapfmt.golden.json", import.meta.url),
);

describe("gapfmt golden", () => {
    it("holds enough cases", () => {
        expect(golden.length).toBeGreaterThanOrEqual(40);
    });

    it.each(golden.map((tc, i) => [i, tc] as const))(
        "case %i renders like Go",
        (_i, tc) => {
            // --- When ---
            const have = run(tc);

            // --- Then ---
            expect(have).toBe(tc.out);
        },
    );
});
