// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The REST gap endpoints, ported from the Go restapi package's gap tests:
// a two-file corpus, a gap store whose resolver knows its documents, and
// requests sent straight to the router.

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { Engine } from "../../src/engine/engine.ts";
import { FileStore } from "../../src/gaps/file-store.ts";
import { type BadFile, emptyGap, type Gap } from "../../src/gaps/gaps.ts";
import { Glossary } from "../../src/glossary/glossary.ts";
import { gapJSON, reportGap, updatePatch } from "../../src/mcp/tools.ts";
import { OPENAPI_YAML } from "../../src/rest/openapi.ts";
import {
    FILL,
    MAX_BODY_BYTES,
    REASON,
    REPORT,
    Rest,
    type RestResponse,
    UPDATE,
} from "../../src/rest/rest.ts";
import { MapResolver, TEST_EPOCH } from "../gaps/fixtures.ts";
import { rankEngine } from "../mcp/support.ts";
import { MemDocFs } from "../support/mem-doc-fs.ts";

/** GAP_DIR is the test stores' gap folder. */
const GAP_DIR = "/gaps";

/** TEST_RESOLVER knows the documents of the {@link newRest} corpus. */
const TEST_RESOLVER = new MapResolver({
    "intro-1": "intro-1",
    "shop/intro.md": "intro-1",
    "shop/catalog/epub.md": "shop/catalog/epub.md",
    "initiatives/int7.md": "initiatives/int7.md",
});

/** TEST_GAP is a valid gap to seed a store with. */
const TEST_GAP: Gap = {
    ...emptyGap(),
    kind: "missing",
    topic: "a",
    demand: "SRD-1 needs it.",
    detail: "Never stated.",
};

/**
 * STALE_GAP is a filled gap, as import takes it, whose one filled_by entry
 * records a hash other than its section's current one.
 */
const STALE_GAP: Gap = {
    ...emptyGap(),
    id: "gap-0009",
    status: "filled",
    kind: "missing",
    hits: 1,
    created: TEST_EPOCH,
    filledBy: [{ ref: "intro-1", hash: "old" }],
    topic: "s",
    demand: "SRD-1 needs it.",
    detail: "Stated now.",
};

/** GapJSON is a gap of a GET /gaps response. */
interface GapJSON {
    id: string;
    status: string;
    ask: string[];
    asked: string;
    score?: number;
}

/** GapsResponse is a GET /gaps response body. */
interface GapsResponse {
    gaps: GapJSON[];
    invalid: BadFile[];
}

/**
 * newStore returns a FileStore over a fresh gap folder, its clock fixed to
 * TEST_EPOCH and its references checked by TEST_RESOLVER, with its fs.
 */
function newStore(): { store: FileStore; mfs: MemDocFs } {
    const mfs = new MemDocFs().mkdirp(GAP_DIR);
    const store = new FileStore(mfs, GAP_DIR, () => TEST_EPOCH, TEST_RESOLVER);
    return { store, mfs };
}

/** RestOptions select what {@link newRest} mounts. */
interface RestOptions {
    store?: FileStore;
    glossary?: boolean;
}

/**
 * newRest builds the Go tests' two-file corpus (and a glossary folder when
 * asked) and the REST router over it and the store; the document
 * "shop/intro.md" has the identity "intro-1".
 */
async function newRest(
    opts: RestOptions = {},
    make: (deps: ConstructorParameters<typeof Rest>[0]) => Rest = (deps) =>
        new Rest(deps),
): Promise<Rest> {
    const fs = new MemDocFs()
        .writeFile(
            "/c/catalog/epub.md",
            "---\ntitle: EPUB Editions\n---\n\n" +
                "Readers download book data as EPUB.\n" +
                "See https://docs.example.com/epub\n",
        )
        .writeFile(
            "/c/intro.md",
            "---\nid: intro-1\ntitle: Intro\n---\n\nThe bookshop overview.\n",
        );
    if (opts.glossary === true) {
        fs.writeFile(
            "/c/glossary/main.md",
            '---\ntitle: Main\nurl: "https://ex.com/glossary"\n---\n\n' +
                "## Stock Keeping Unit (SKU)\n\n" +
                "Identifier of a book edition.\n\n" +
                "## Backorder\n\nOrder for an out-of-stock title.\n",
        );
    }
    const engine = await Engine.create({
        fs,
        sources: [{ name: "shop", dir: "/c" }],
    });
    return make({
        engine,
        version: "x",
        ...(opts.store === undefined ? {} : { store: opts.store }),
        ...(opts.glossary === true
            ? { glossary: new Glossary(engine, "shop/glossary") }
            : {}),
    });
}

/** send sends a method request for target with body. */
function send(
    rest: Rest,
    method: string,
    target: string,
    body = "",
): Promise<RestResponse> {
    const q = target.indexOf("?");
    return rest.handle({
        method,
        path: q < 0 ? target : target.slice(0, q),
        query: q < 0 ? "" : target.slice(q + 1),
        body: new TextEncoder().encode(body),
    });
}

/** get sends a GET for target. */
function get(rest: Rest, target: string): Promise<RestResponse> {
    return send(rest, "GET", target);
}

/** post sends a POST for target with body. */
function post(rest: Rest, target: string, body: string): Promise<RestResponse> {
    return send(rest, "POST", target, body);
}

/** decode parses a GET /gaps response body. */
function decode(res: RestResponse): GapsResponse {
    return JSON.parse(res.body) as GapsResponse;
}

/**
 * seedRanked appends three gaps on distinct topics, gap-0001 to gap-0003:
 * a query for "download token" matches gap-0002 by its topic and gap-0003
 * only by a search term.
 */
async function seedRanked(store: FileStore): Promise<void> {
    const seeds: Partial<Gap>[] = [
        { topic: "Shipping rates", srdRef: "SRD-2" },
        { topic: "EPUB download token lifetime", srdRef: "SRD-7" },
        {
            topic: "Gift card expiry",
            srdRef: "SRD-9",
            searchTerms: ["download"],
        },
    ];
    for (const seed of seeds) {
        await store.append({
            ...emptyGap(),
            ...seed,
            kind: "missing",
            demand: "d",
            detail: "x",
        });
    }
}

/**
 * seedThree seeds an open gap-0001, a draft gap-0002, and a filled
 * gap-0003.
 */
async function seedThree(store: FileStore): Promise<void> {
    await store.append(TEST_GAP);
    await store.appendDraft(TEST_GAP);
    const done = await store.append(TEST_GAP);
    await store.fill(done, { refs: ["intro-1"], complete: true });
}

describe("request conversion", () => {
    // go: Test_reportRequest_gap
    it("turns a report body into a gap", () => {
        // --- Given ---
        const input = {
            kind: "wrong",
            topic: "t",
            doc_id: "shop/a.md",
            heading_path: ["A"],
            demand: "d",
            detail: "x",
            target_claim: "c",
            search_terms: ["q"],
            srd_ref: "SRD-1",
            answer: "deferred",
            draft: true,
        };

        // --- When ---
        const have = reportGap(input);

        // --- Then ---
        const want: Gap = {
            ...emptyGap(),
            kind: "wrong",
            answer: "deferred",
            srdRef: "SRD-1",
            docID: "shop/a.md",
            headingPath: ["A"],
            searchTerms: ["q"],
            topic: "t",
            demand: "d",
            detail: "x",
            targetClaim: "c",
        };
        expect(have).toEqual(want);
    });

    // go: Test_updateRequest_patch
    it("turns an update body into a patch", () => {
        // --- Given ---
        const input = {
            kind: "wrong",
            topic: "t",
            doc_id: "shop/a.md",
            heading_path: ["A"],
            demand: "d",
            detail: "x",
            target_claim: "c",
            search_terms: ["q"],
            srd_ref: "SRD-1",
            answer: "unknown",
            add_hit: true,
        };

        // --- When ---
        const have = updatePatch(input);

        // --- Then ---
        expect(have).toStrictEqual({
            kind: "wrong",
            answer: "unknown",
            srdRef: "SRD-1",
            docID: "shop/a.md",
            headingPath: ["A"],
            searchTerms: ["q"],
            topic: "t",
            demand: "d",
            detail: "x",
            targetClaim: "c",
            addHit: true,
        });
    });

    // go: Test_updateRequest_patch_omitted_fields
    it("leaves omitted update fields out of the patch", () => {
        // --- When ---
        const have = updatePatch({ add_hit: true });

        // --- Then ---
        expect(have).toStrictEqual({ addHit: true });
    });
});

describe("POST /gaps", () => {
    // go: Test_server_reportGap
    it("records a gap", async () => {
        // --- Given ---
        const { store, mfs } = newStore();
        const rest = await newRest({ store });
        const body =
            '{"kind":"missing","topic":"Provisioning TTL",' +
            '"doc_id":"shop/intro.md","heading_path":["Intro"],' +
            '"demand":"SRD-7 needs the TTL.","detail":"TTL never stated.",' +
            '"target_claim":"Valid 24h.","search_terms":["ttl"],' +
            '"srd_ref":"SRD-7","answer":"deferred","ask":["Anna M","Bob"],' +
            '"asked":"2026-10-04"}';

        // --- When ---
        const have = await post(rest, "/gaps", body);

        // --- Then ---
        expect(have.status).toBe(201);
        expect(have.body).toBe('{"gap_id":"gap-0001"}\n');
        const want =
            "---\n" +
            "id: gap-0001\n" +
            "status: open\n" +
            "kind: missing\n" +
            "answer: deferred\n" +
            "ask:\n" +
            "  - Anna M\n" +
            "  - Bob\n" +
            "asked: 2026-10-04\n" +
            "srd_ref: SRD-7\n" +
            "doc_id: intro-1\n" +
            "heading_path:\n" +
            "  - Intro\n" +
            "search_terms:\n" +
            "  - ttl\n" +
            "hits: 1\n" +
            "created: 2026-07-14T10:00:00Z\n" +
            "filled_by: []\n" +
            "---\n" +
            "# Provisioning TTL\n" +
            "\n" +
            "## Demand\n" +
            "\n" +
            "SRD-7 needs the TTL.\n" +
            "\n" +
            "## Detail\n" +
            "\n" +
            "TTL never stated.\n" +
            "\n" +
            "## Target claim\n" +
            "\n" +
            "Valid 24h.\n";
        const file = mfs.readFile(`${GAP_DIR}/gap-0001-provisioning-ttl.md`);
        expect(file).toBe(want);
    });

    // go: Test_server_reportGap_draft
    it("records a draft", async () => {
        // --- Given ---
        const { store } = newStore();
        const rest = await newRest({ store });
        const body =
            '{"kind":"missing","topic":"provisioning",' +
            '"demand":"SRD-7 needs the TTL.","detail":"TTL never stated.",' +
            '"draft":true}';

        // --- When ---
        const have = await post(rest, "/gaps", body);

        // --- Then ---
        expect(have.status).toBe(201);
        expect(have.body).toBe('{"gap_id":"gap-0001"}\n');

        const stored = await store.list({});
        expect(stored[0]?.status).toBe("draft");
    });

    // go: Test_server_reportGap_error_bad_body
    it("refuses a body that is not JSON", async () => {
        // --- Given ---
        const rest = await newRest({ store: newStore().store });

        // --- When ---
        const have = await post(rest, "/gaps", "{ not json");

        // --- Then ---
        expect(have.status).toBe(400);
        expect(have.body).toContain("decode request body: invalid character");
    });

    // go: Test_server_reportGap_error_body_too_large
    it("refuses a body over the limit", async () => {
        // --- Given ---
        const { store } = newStore();
        const rest = await newRest({ store });
        const detail = "x".repeat(MAX_BODY_BYTES);
        const body =
            '{"kind":"missing","topic":"t","demand":"d","detail":"' +
            detail +
            '"}';

        // --- When ---
        const have = await post(rest, "/gaps", body);

        // --- Then ---
        expect(have.status).toBe(413);
        expect(have.body).toContain("request body too large");

        expect(await store.list({})).toHaveLength(0);
    });

    // go: Test_server_reportGap_error_invalid_gap_tabular
    it.each([
        [
            "unknown kind",
            '{"kind":"bogus","topic":"t","demand":"d","detail":"x"}',
            'unknown kind \\"bogus\\"',
        ],
        [
            "unknown doc",
            '{"kind":"wrong","topic":"t","demand":"d","detail":"x",' +
                '"doc_id":"shop/nope.md"}',
            'unknown reference \\"shop/nope.md\\"',
        ],
        [
            "removed field",
            '{"kind":"wrong","topic":"t","demand":"d","detail":"x",' +
                '"source_url":"https://x"}',
            'unknown field \\"source_url\\"',
        ],
    ])("refuses an invalid gap: %s", async (_name, body, want) => {
        // --- Given ---
        const { store } = newStore();
        const rest = await newRest({ store });

        // --- When ---
        const have = await post(rest, "/gaps", body);

        // --- Then ---
        expect(have.status).toBe(400);
        expect(have.body).toContain(want);

        expect(await store.list({})).toHaveLength(0);
    });
});

describe("GET /gaps", () => {
    // go: Test_server_listGaps
    it("lists the gaps", async () => {
        // --- Given ---
        const { store } = newStore();
        const rest = await newRest({ store });
        const seed: Gap = {
            ...emptyGap(),
            kind: "missing",
            answer: "deferred",
            srdRef: "SRD-7 §4.3",
            docID: "shop/catalog/epub.md",
            headingPath: ["Catalog", "Delivery"],
            searchTerms: ["token", "ttl"],
            topic: "EPUB delivery",
            demand: "SRD-7 needs the token TTL.",
            detail: "TTL never stated.",
            targetClaim: "Token valid 24h.",
        };
        const id = await store.append(seed);
        await store.fill(id, {
            refs: ["intro-1"],
            complete: false,
            remaining: "The unit.",
        });

        // --- When ---
        const have = await get(rest, "/gaps");

        // --- Then ---
        expect(have.status).toBe(200);
        const want =
            '{"gaps":[{"id":"gap-0001","status":"open","kind":"missing",' +
            '"answer":"deferred","ask":[],"asked":"","srd_ref":"SRD-7 §4.3",' +
            '"doc_id":"shop/catalog/epub.md",' +
            '"heading_path":["Catalog","Delivery"],' +
            '"search_terms":["token","ttl"],"hits":1,' +
            '"created":"2026-07-14T10:00:00Z","filled_by":[{"ref":"intro-1",' +
            '"hash":"6f705b2dc48387acb38968dcd93911bb6eb7f40cfed9bc4068fade44ba64da56"}],' +
            '"topic":"EPUB delivery","demand":"SRD-7 needs the token TTL.",' +
            '"detail":"The unit.","target_claim":"Token valid 24h.",' +
            '"file":"gap-0001-epub-delivery.md"}],"invalid":[]}\n';
        expect(have.body).toBe(want);
    });

    // go: Test_server_listGaps_empty
    it("lists no gaps", async () => {
        // --- Given ---
        const rest = await newRest({ store: newStore().store });

        // --- When ---
        const have = await get(rest, "/gaps");

        // --- Then ---
        expect(have.status).toBe(200);
        expect(have.body).toBe('{"gaps":[],"invalid":[]}\n');
    });

    // go: Test_server_listGaps_invalid
    it("lists an invalid file the filter does not match", async () => {
        // --- Given --- a valid gap beside a broken one; the filter matches
        // neither, yet the broken one is listed.
        const { store, mfs } = newStore();
        const rest = await newRest({ store });
        await store.append(TEST_GAP);
        mfs.writeFile(`${GAP_DIR}/gap-0002-junk.md`, "junk");

        // --- When ---
        const have = await get(rest, "/gaps?status=draft");

        // --- Then ---
        expect(have.status).toBe(200);
        const want =
            '{"gaps":[],"invalid":[{"file":"gap-0002-junk.md",' +
            '"reason":"no front matter"}]}\n';
        expect(have.body).toBe(want);
    });

    // go: Test_server_listGaps_error_bad_files
    it("hides a failure to list the invalid files", async () => {
        // --- Given ---
        const logged: unknown[] = [];
        const errDiskOnFire = new Error("disk on fire");
        const { store } = newStore();
        store.badFiles = () => Promise.reject(errDiskOnFire);
        const rest = new Rest({
            engine: await rankEngine(),
            version: "x",
            store,
            logErr: (err) => logged.push(err),
        });

        // --- When ---
        const have = await get(rest, "/gaps");

        // --- Then ---
        expect(have.status).toBe(500);
        expect(have.body).toBe('{"error":"internal error"}\n');
        expect(logged).toEqual([errDiskOnFire]);
    });

    // go: Test_server_listGaps_filters_by_status
    it("filters by status", async () => {
        // --- Given ---
        const { store } = newStore();
        const rest = await newRest({ store });
        await store.append(TEST_GAP);
        const done = await store.append({
            ...TEST_GAP,
            kind: "wrong",
            topic: "b",
        });
        await store.wontfix(done, "why");

        // --- When ---
        const have = await get(rest, "/gaps?status=wontfix");

        // --- Then ---
        expect(have.status).toBe(200);
        const body = decode(have);
        expect(body.gaps).toHaveLength(1);
        expect(body.gaps[0]?.id).toBe("gap-0002");
    });

    // go: Test_server_listGaps_filters_drafts_by_srd_ref
    it("filters drafts by SRD reference", async () => {
        // --- Given ---
        const { store } = newStore();
        const rest = await newRest({ store });
        const mine = { ...TEST_GAP, srdRef: "initiatives/checkout/srd.md §2" };
        await store.append(mine);
        const id = await store.appendDraft(mine);
        await store.appendDraft({
            ...TEST_GAP,
            srdRef: "initiatives/wishlist/srd.md §2",
        });

        // --- When ---
        const have = await get(rest, "/gaps?status=draft&srd_ref=checkout");

        // --- Then ---
        expect(have.status).toBe(200);
        const body = decode(have);
        expect(body.gaps).toHaveLength(1);
        expect(body.gaps[0]?.id).toBe(id);
    });

    // go: Test_server_listGaps_filters_ask_and_asked
    it("filters by ask and asked", async () => {
        // --- Given --- gap-0001 to ask Anna, sent; gap-0002 to ask Anna,
        // not sent; gap-0003 to ask Bob, not sent.
        const { store } = newStore();
        const rest = await newRest({ store });
        await store.append({
            ...TEST_GAP,
            ask: ["Anna M"],
            asked: "2026-10-04",
        });
        const id = await store.append({ ...TEST_GAP, ask: ["Anna M"] });
        await store.append({ ...TEST_GAP, ask: ["Bob"] });

        // --- When ---
        const have = await get(rest, "/gaps?ask=ANNA&asked=false");

        // --- Then ---
        expect(have.status).toBe(200);
        const body = decode(have);
        expect(body.gaps).toHaveLength(1);
        expect(body.gaps[0]?.id).toBe(id);
        expect(body.gaps[0]?.ask).toEqual(["Anna M"]);
        expect(body.gaps[0]?.asked).toBe("");
    });

    // go: Test_server_listGaps_asked_true
    it("filters gaps whose questions went out", async () => {
        // --- Given ---
        const { store } = newStore();
        const rest = await newRest({ store });
        await store.append(TEST_GAP);
        const id = await store.append({ ...TEST_GAP, asked: "2026-10-04" });

        // --- When ---
        const have = await get(rest, "/gaps?asked=true");

        // --- Then ---
        expect(have.status).toBe(200);
        const body = decode(have);
        expect(body.gaps).toHaveLength(1);
        expect(body.gaps[0]?.id).toBe(id);
    });

    // go: Test_server_listGaps_query_ranks_by_relevance
    it("ranks a query by relevance", async () => {
        // --- Given ---
        const { store } = newStore();
        const rest = await newRest({ store });
        await seedRanked(store);

        // --- When ---
        const have = await get(rest, "/gaps?query=download+token");

        // --- Then ---
        expect(have.status).toBe(200);
        const body = decode(have);
        expect(body.gaps).toHaveLength(2);
        expect(body.gaps[0]?.id).toBe("gap-0002");
        expect(body.gaps[1]?.id).toBe("gap-0003");
        expect(body.gaps[0]?.score).toBeGreaterThan(body.gaps[1]?.score ?? 0);
        expect(have.body).toContain('"score":');
    });

    // go: Test_server_listGaps_query_with_filters
    it("combines a query with filters", async () => {
        // --- Given ---
        const { store } = newStore();
        const rest = await newRest({ store });
        await seedRanked(store);
        await store.wontfix("gap-0002", "why");

        // --- When ---
        const have = await get(
            rest,
            "/gaps?status=open&srd_ref=SRD-&query=download",
        );

        // --- Then ---
        expect(have.status).toBe(200);
        const body = decode(have);
        expect(body.gaps).toHaveLength(1);
        expect(body.gaps[0]?.id).toBe("gap-0003");
    });

    // go: Test_server_listGaps_stale
    it("filters stale gaps", async () => {
        // --- Given --- a current filled gap-0001 and a stale filled
        // gap-0009.
        const { store } = newStore();
        const rest = await newRest({ store });
        const id = await store.append(TEST_GAP);
        await store.fill(id, { refs: ["intro-1"], complete: true });
        await store.import(STALE_GAP);

        // --- When ---
        const have = await get(rest, "/gaps?stale=true");

        // --- Then ---
        expect(have.status).toBe(200);
        const body = decode(have);
        expect(body.gaps).toHaveLength(1);
        expect(body.gaps[0]?.id).toBe(STALE_GAP.id);
        expect(body.gaps[0]?.status).toBe("filled");
        expect(have.body).toContain(
            '"stale":true,"stale_refs":[{"ref":"intro-1","reason":"changed"}]',
        );
    });

    // go: Test_server_listGaps_stale_false_lists_all
    it("lists every gap for stale=false", async () => {
        // --- Given ---
        const { store } = newStore();
        const rest = await newRest({ store });
        await store.append(TEST_GAP);
        await store.import(STALE_GAP);

        // --- When ---
        const have = await get(rest, "/gaps?stale=false");

        // --- Then ---
        expect(have.status).toBe(200);
        expect(decode(have).gaps).toHaveLength(2);
    });

    // go: Test_server_listGaps_error_stale_value
    it("refuses a stale value that is not a bool", async () => {
        // --- Given ---
        const rest = await newRest({ store: newStore().store });

        // --- When ---
        const have = await get(rest, "/gaps?stale=maybe");

        // --- Then ---
        expect(have.status).toBe(400);
        expect(have.body).toBe('{"error":"stale must be true or false"}\n');
    });

    // go: Test_server_listGaps_error_asked_value
    it("refuses an asked value that is not a bool", async () => {
        // --- Given ---
        const rest = await newRest({ store: newStore().store });

        // --- When ---
        const have = await get(rest, "/gaps?asked=soon");

        // --- Then ---
        expect(have.status).toBe(400);
        expect(have.body).toBe('{"error":"asked must be true or false"}\n');
    });

    // go: Test_server_listGaps_error_unknown_status
    it("refuses an unknown status", async () => {
        // --- Given ---
        const rest = await newRest({ store: newStore().store });

        // --- When ---
        const have = await get(rest, "/gaps?status=resolved");

        // --- Then ---
        expect(have.status).toBe(400);
        expect(have.body).toContain('unknown status \\"resolved\\"');
    });
});

describe("PUT /gaps/{id}", () => {
    // go: Test_server_updateGap
    it("updates a gap", async () => {
        // --- Given ---
        const { store } = newStore();
        const rest = await newRest({ store });
        const id = await store.appendDraft(TEST_GAP);
        const body =
            '{"kind":"wrong","doc_id":"shop/intro.md",' +
            '"target_claim":"claim","add_hit":true}';

        // --- When ---
        const have = await send(rest, "PUT", `/gaps/${id}`, body);

        // --- Then ---
        expect(have.status).toBe(200);
        expect(have.body).toBe('{"ok":true}\n');

        const stored = await store.list({});
        expect(stored[0]?.kind).toBe("wrong");
        expect(stored[0]?.docID).toBe("intro-1");
        expect(stored[0]?.targetClaim).toBe("claim");
        expect(stored[0]?.hits).toBe(2);
        expect(stored[0]?.topic).toBe("a");
        expect(stored[0]?.demand).toBe("SRD-1 needs it.");
    });

    // go: Test_server_updateGap_ask_and_asked
    it("updates ask and asked", async () => {
        // --- Given ---
        const { store } = newStore();
        const rest = await newRest({ store });
        const id = await store.append(TEST_GAP);
        const body = '{"ask":["Anna M"," Bob "],"asked":"2026-10-04"}';

        // --- When ---
        const have = await send(rest, "PUT", `/gaps/${id}`, body);

        // --- Then ---
        expect(have.status).toBe(200);

        const stored = await store.list({});
        expect(stored[0]?.ask).toEqual(["Anna M", "Bob"]);
        expect(stored[0]?.asked).toBe("2026-10-04");
    });

    // go: Test_server_updateGap_error_asked
    it("refuses an asked value that is not a date", async () => {
        // --- Given ---
        const { store } = newStore();
        const rest = await newRest({ store });
        const id = await store.append(TEST_GAP);

        // --- When ---
        const have = await send(
            rest,
            "PUT",
            `/gaps/${id}`,
            '{"asked":"10/04"}',
        );

        // --- Then ---
        expect(have.status).toBe(400);
        expect(have.body).toContain("asked: want a YYYY-MM-DD date");
    });
});

describe("gap operations", () => {
    // go: Test_server_gap_operation_tabular
    it.each([
        ["submit", "POST", "/gaps/gap-0002/submit", "", "open"],
        [
            "fill",
            "POST",
            "/gaps/gap-0001/fill",
            '{"filled_by":["shop/intro.md"],"complete":true}',
            "filled",
        ],
        [
            "fill partial",
            "POST",
            "/gaps/gap-0001/fill",
            '{"filled_by":["intro-1"],"remaining":"More."}',
            "open",
        ],
        [
            "refresh filled",
            "POST",
            "/gaps/gap-0003/fill",
            '{"filled_by":["intro-1"],"complete":true}',
            "filled",
        ],
        [
            "reopen",
            "POST",
            "/gaps/gap-0003/reopen",
            '{"reason":"Moved."}',
            "open",
        ],
        [
            "wontfix",
            "POST",
            "/gaps/gap-0001/wontfix",
            '{"reason":"Internal."}',
            "wontfix",
        ],
    ])("runs %s", async (_name, method, target, body, want) => {
        // --- Given ---
        const { store } = newStore();
        const rest = await newRest({ store });
        await seedThree(store);
        const id = target.split("/")[2];

        // --- When ---
        const have = await send(rest, method, target, body);

        // --- Then ---
        expect(have.status).toBe(200);
        expect(have.body).toBe('{"ok":true}\n');

        const stored = await store.list({});
        expect(stored.find((gap) => gap.id === id)?.status).toBe(want);
    });

    // go: Test_server_discardGap
    it("discards a draft", async () => {
        // --- Given ---
        const { store } = newStore();
        const rest = await newRest({ store });
        const id = await store.appendDraft(TEST_GAP);

        // --- When ---
        const have = await send(rest, "DELETE", `/gaps/${id}`);

        // --- Then ---
        expect(have.status).toBe(200);
        expect(have.body).toBe('{"ok":true}\n');

        expect(await store.list({})).toHaveLength(0);
    });

    // go: Test_server_gap_operation_error_tabular
    it.each([
        [
            "update unknown id",
            "PUT",
            "/gaps/gap-0404",
            '{"add_hit":true}',
            404,
            "update gap-0404: gap not found",
        ],
        [
            "update filled",
            "PUT",
            "/gaps/gap-0003",
            '{"add_hit":true}',
            409,
            "it is filled, the operation needs draft or open",
        ],
        [
            "update invalid",
            "PUT",
            "/gaps/gap-0002",
            '{"kind":"bogus"}',
            400,
            'unknown kind \\"bogus\\"',
        ],
        [
            "update empty",
            "PUT",
            "/gaps/gap-0002",
            "{}",
            400,
            "nothing to update",
        ],
        [
            "update bad body",
            "PUT",
            "/gaps/gap-0002",
            '{"draft":true}',
            400,
            "unknown field",
        ],
        [
            "submit open",
            "POST",
            "/gaps/gap-0001/submit",
            "",
            409,
            "it is open, the operation needs draft",
        ],
        [
            "discard unknown id",
            "DELETE",
            "/gaps/gap-0404",
            "",
            404,
            "gap not found",
        ],
        [
            "discard open",
            "DELETE",
            "/gaps/gap-0001",
            "",
            409,
            "it is open, the operation needs draft",
        ],
        [
            "fill draft",
            "POST",
            "/gaps/gap-0002/fill",
            '{"filled_by":["intro-1"],"complete":true}',
            409,
            "it is draft, the operation needs open",
        ],
        [
            "fill partial on filled",
            "POST",
            "/gaps/gap-0003/fill",
            '{"filled_by":["intro-1"]}',
            409,
            "it is filled, the operation needs open",
        ],
        [
            "fill empty filled_by",
            "POST",
            "/gaps/gap-0001/fill",
            '{"filled_by":[],"complete":true}',
            400,
            "filled_by is required",
        ],
        [
            "fill unknown doc",
            "POST",
            "/gaps/gap-0001/fill",
            '{"filled_by":["shop/nope.md"],"complete":true}',
            400,
            'unknown reference \\"shop/nope.md\\"',
        ],
        [
            "fill unknown anchor",
            "POST",
            "/gaps/gap-0001/fill",
            '{"filled_by":["intro-1#nope"],"complete":true}',
            400,
            'unknown reference \\"intro-1#nope\\"',
        ],
        [
            "fill under initiatives",
            "POST",
            "/gaps/gap-0001/fill",
            '{"filled_by":["initiatives/int7.md"],"complete":true}',
            400,
            '\\"initiatives/int7.md\\" is under the initiatives folder',
        ],
        [
            "reopen open",
            "POST",
            "/gaps/gap-0001/reopen",
            '{"reason":"x"}',
            409,
            "it is open, the operation needs filled",
        ],
        [
            "reopen without reason",
            "POST",
            "/gaps/gap-0003/reopen",
            "{}",
            400,
            "reason is required",
        ],
        [
            "wontfix filled",
            "POST",
            "/gaps/gap-0003/wontfix",
            '{"reason":"x"}',
            409,
            "it is filled, the operation needs open",
        ],
    ])(
        "refuses %s",
        async (_name, method, target, body, wantCode, wantBody) => {
            // --- Given ---
            const { store } = newStore();
            const rest = await newRest({ store });
            await seedThree(store);
            const before = await store.list({});

            // --- When ---
            const have = await send(rest, method, target, body);

            // --- Then ---
            expect(have.status).toBe(wantCode);
            expect(have.body).toContain(wantBody);

            expect(await store.list({})).toEqual(before);
        },
    );

    // go: Test_server_gap_operation_error_invalid_file
    it("refuses to change an invalid gap file", async () => {
        // --- Given ---
        const { store, mfs } = newStore();
        const rest = await newRest({ store });
        mfs.writeFile(`${GAP_DIR}/gap-0001-junk.md`, "junk");

        // --- When ---
        const have = await post(
            rest,
            "/gaps/gap-0001/wontfix",
            '{"reason":"x"}',
        );

        // --- Then ---
        expect(have.status).toBe(409);
        const want =
            '{"error":"wontfix gap-0001: invalid gap file ' +
            'gap-0001-junk.md: no front matter"}\n';
        expect(have.body).toBe(want);
        expect(mfs.readFile(`${GAP_DIR}/gap-0001-junk.md`)).toBe("junk");
    });
});

describe("gap routes", () => {
    // go: Test_server_gap_endpoints_absent_without_store
    it("are absent without a store", async () => {
        // --- Given --- a retrieval-only router: no gap store, so no gap
        // routes.
        const rest = await newRest();

        // --- When ---
        const have = [
            await post(rest, "/gaps", "{}"),
            await get(rest, "/gaps"),
            await send(rest, "PUT", "/gaps/gap-0001", "{}"),
            await send(rest, "DELETE", "/gaps/gap-0001"),
            await post(rest, "/gaps/gap-0001/submit", ""),
            await post(rest, "/gaps/gap-0001/fill", "{}"),
            await post(rest, "/gaps/gap-0001/reopen", "{}"),
            await post(rest, "/gaps/gap-0001/wontfix", "{}"),
            await get(rest, "/glossary"),
        ];

        // --- Then ---
        expect(have.map((res) => res.status)).toEqual(Array(9).fill(404));
    });

    // go: Test_server_gap_routes_removed
    it("leave out the removed operations", async () => {
        // --- Given ---
        const rest = await newRest({ store: newStore().store });

        // --- When ---
        const kb = await post(rest, "/gaps/gap-0001/kb", "{}");
        const resolve = await post(rest, "/gaps/gap-0001/resolve", "{}");

        // --- Then ---
        expect(kb.status).toBe(404);
        expect(resolve.status).toBe(404);
    });
});

describe("OpenAPI description", () => {
    // go: Test_openAPISpec_covers_registered_routes
    it("covers the registered routes", async () => {
        // --- Given ---
        const spec = parse(OPENAPI_YAML) as {
            openapi: string;
            paths: Record<string, Record<string, unknown>>;
        };
        const registered: string[] = [];
        class Recorder extends Rest {
            override add(...args: Parameters<Rest["add"]>): void {
                const [method, pattern] = args;
                registered.push(
                    `${method} ${pattern.replace("{id...}", "{id}")}`,
                );
                super.add(...args);
            }
        }
        await newRest(
            { store: newStore().store, glossary: true },
            (deps) => new Recorder(deps),
        );

        // --- When ---
        const have = spec.paths;

        // --- Then ---
        expect(spec.openapi).toBe("3.2.0");

        expect(Object.keys(have).sort()).toEqual(
            [
                "/healthz",
                "/search",
                "/docs",
                "/docs/{id}",
                "/openapi.yaml",
                "/glossary",
                "/gaps",
                "/gaps/{id}",
                "/gaps/{id}/submit",
                "/gaps/{id}/fill",
                "/gaps/{id}/reopen",
                "/gaps/{id}/wontfix",
            ].sort(),
        );
        const methods = ["get", "put", "post", "delete", "patch", "head"];
        const described = Object.entries(have).flatMap(([path, item]) =>
            Object.keys(item)
                .filter((key) => methods.includes(key))
                .map((key) => `${key.toUpperCase()} ${path}`),
        );
        expect(described.sort()).toEqual(registered.sort());
    });

    // go: Test_openAPISpec_gap_schemas_match_json_tabular
    describe("gap schemas match the JSON", async () => {
        const spec = parse(OPENAPI_YAML) as {
            components: {
                schemas: Record<string, { properties: object }>;
            };
        };
        const gap = gapJSON({
            ...emptyGap(),
            score: 1,
            stale: true,
            filledBy: [{ ref: "", hash: "h" }],
            staleRefs: [{ ref: "", reason: "changed" }],
        });
        const { store } = newStore();
        store.badFiles = () => Promise.resolve([{ file: "f", reason: "r" }]);
        const list = JSON.parse(
            (await get(await newRest({ store }), "/gaps")).body,
        ) as { invalid: object[] };
        const rows: [string, object][] = [
            ["Gap", gap],
            ["FillRef", (gap["filled_by"] as object[])[0] as object],
            ["StaleRef", (gap["stale_refs"] as object[])[0] as object],
            ["BadFile", list.invalid[0] as object],
            ["GapList", list],
            ["ReportGapRequest", REPORT.fields],
            ["UpdateGapRequest", UPDATE.fields],
            ["FillGapRequest", FILL.fields],
            ["ReasonRequest", REASON.fields],
        ];

        it.each(rows)("%s", (schema, fields) => {
            // --- When ---
            const have = spec.components.schemas[schema]?.properties ?? {};

            // --- Then ---
            const want = Object.keys(fields).sort();
            expect(Object.keys(have).sort()).toEqual(want);
        });
    });
});
