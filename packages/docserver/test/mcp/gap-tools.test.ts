// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { FileStore } from "../../src/gaps/file-store.ts";
import {
    type BadFile,
    EC_INVALID,
    emptyGap,
    type Gap,
    gapError,
    hash,
    type ResolvedRef,
    type Resolver,
} from "../../src/gaps/gaps.ts";
import { goQuote } from "../../src/gocompat/strconv.ts";
import {
    type GapStore,
    type RPCError,
    reportGap,
    updatePatch,
} from "../../src/mcp/tools.ts";
import { readGolden } from "../support/golden.ts";
import { MemDocFs } from "../support/mem-doc-fs.ts";
import {
    bookshop,
    connect,
    contentText,
    decode,
    newEngine,
    ROOT,
} from "./support.ts";

/** EPOCH is the test store's fixed clock. */
const EPOCH = { unix: Date.UTC(2026, 6, 14, 10) / 1000, nsec: 0, offset: 0 };

/** REFS are the references the test resolver knows, normalized. */
const REFS: Readonly<Record<string, string>> = {
    epub: "epub",
    "shop/catalog/epub.md": "epub",
    "epub#tokens": "epub#tokens",
    "shop/catalog/epub.md#tokens": "epub#tokens",
    "initiatives/int7.md#scope": "initiatives/int7.md#scope",
};

/** testResolver maps REFS and hashes a reference as its normal form. */
const testResolver: Resolver = {
    async resolve(ref: string): Promise<ResolvedRef> {
        const norm = REFS[ref];
        if (norm === undefined)
            throw gapError(EC_INVALID, `unknown reference ${goQuote(ref)}`);
        return { norm, hash: hash(norm) };
    },
    async resolveFill(ref: string): Promise<ResolvedRef> {
        const res = await this.resolve(ref);
        if (res.norm.startsWith("initiatives/")) {
            const why = `${goQuote(ref)} is under the initiatives folder`;
            throw gapError(EC_INVALID, why);
        }
        return res;
    },
    async current(ref: string): Promise<string> {
        return (await this.resolve(ref)).hash;
    },
};

/** newStore returns an empty in-memory store and its fs. */
function newStore() {
    const fs = new MemDocFs().mkdirp("/gaps");
    return { store: new FileStore(fs, "/gaps", () => EPOCH, testResolver), fs };
}

/** connectStore serves the one-file corpus with store's gap tools. */
async function connectStore(store: GapStore) {
    const { engine } = await newEngine();
    return connect({ engine, version: "0.0.0-test", store });
}

/** TEST_GAP is a valid gap to seed a store with. */
const TEST_GAP: Gap = {
    ...emptyGap(),
    kind: "missing",
    topic: "a",
    demand: "SRD-1 needs it.",
    detail: "Never stated.",
};

/** STALE_GAP is a filled gap whose one entry hashes differently now. */
const STALE_GAP: Gap = {
    ...emptyGap(),
    id: "gap-0009",
    status: "filled",
    kind: "missing",
    hits: 1,
    created: EPOCH,
    filledBy: [{ ref: "epub", hash: "old" }],
    topic: "s",
    demand: "SRD-1 needs it.",
    detail: "Stated now.",
};

/** seedRanked appends three gaps; "download token" matches 2 then 3. */
async function seedRanked(store: FileStore): Promise<void> {
    const seeds = [
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

interface ListOut {
    gaps: {
        id: string;
        status: string;
        ask: string[];
        asked: string;
        score?: number;
    }[];
    invalid: BadFile[];
}

describe("gap tool arguments", () => {
    // go: Test_reportGapInput_gap
    it("maps report_gap arguments onto a gap", () => {
        // --- When ---
        const have = reportGap({
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
        });

        // --- Then ---
        expect(have).toEqual({
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
        });
    });

    // go: Test_updateGapInput_patch
    it("maps update_gap arguments onto a patch", () => {
        // --- When ---
        const have = updatePatch({
            gap_id: "gap-0001",
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
        });

        // --- Then ---
        expect(have).toEqual({
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

    // go: Test_updateGapInput_patch_omitted_fields
    it("leaves omitted and null fields out of the patch", () => {
        // --- When ---
        const have = updatePatch({
            gap_id: "gap-0001",
            add_hit: true,
            topic: null,
        });

        // --- Then ---
        expect(have).toEqual({ addHit: true });
    });
});

describe("report_gap", () => {
    // go: Test_gapTools_report
    it("writes a new open gap", async () => {
        // --- Given ---
        const { store, fs } = newStore();
        const client = await connectStore(store);

        // --- When ---
        const res = await client.callTool({
            name: "report_gap",
            arguments: {
                kind: "missing",
                topic: "EPUB delivery",
                doc_id: "shop/catalog/epub.md",
                demand: "SRD-7 needs the token TTL.",
                detail: "TTL never stated.",
                search_terms: ["ttl"],
                answer: "unknown",
                ask: ["Anna M", " anna m ", "Bob"],
                asked: "2026-10-04",
            },
        });

        // --- Then ---
        expect(res.isError).toBeFalsy();
        expect(contentText(res)).toBe('{"gap_id":"gap-0001"}');
        expect(fs.readFile("/gaps/gap-0001-epub-delivery.md")).toBe(
            "---\n" +
                "id: gap-0001\n" +
                "status: open\n" +
                "kind: missing\n" +
                "answer: unknown\n" +
                "ask:\n" +
                "  - Anna M\n" +
                "  - Bob\n" +
                "asked: 2026-10-04\n" +
                'srd_ref: ""\n' +
                "doc_id: epub\n" +
                "heading_path: []\n" +
                "search_terms:\n" +
                "  - ttl\n" +
                "hits: 1\n" +
                "created: 2026-07-14T10:00:00Z\n" +
                "filled_by: []\n" +
                "---\n" +
                "# EPUB delivery\n" +
                "\n" +
                "## Demand\n" +
                "\n" +
                "SRD-7 needs the token TTL.\n" +
                "\n" +
                "## Detail\n" +
                "\n" +
                "TTL never stated.\n" +
                "\n" +
                "## Target claim\n",
        );
    });

    // go: Test_gapTools_report_draft
    it("writes a draft", async () => {
        // --- Given ---
        const { store } = newStore();
        const client = await connectStore(store);

        // --- When ---
        const res = await client.callTool({
            name: "report_gap",
            arguments: {
                kind: "missing",
                topic: "EPUB delivery",
                demand: "SRD-7 needs the token TTL.",
                detail: "TTL never stated.",
                draft: true,
            },
        });

        // --- Then ---
        expect(decode(res)).toEqual({ gap_id: "gap-0001" });
        expect((await store.list({}))[0]?.status).toBe("draft");
    });

    // go: Test_gapTools_report_error_tabular
    it.each([
        [
            "unknown kind",
            { kind: "bogus", topic: "t", demand: "d", detail: "x" },
            'unknown kind "bogus"',
        ],
        [
            "unknown doc",
            {
                kind: "missing",
                topic: "t",
                doc_id: "shop/nope.md",
                demand: "d",
                detail: "x",
            },
            'unknown reference "shop/nope.md"',
        ],
    ])("refuses an %s", async (_name, args, want) => {
        // --- Given ---
        const client = await connectStore(newStore().store);

        // --- When ---
        const res = await client.callTool({
            name: "report_gap",
            arguments: args,
        });

        // --- Then ---
        expect(res.isError).toBe(true);
        expect(contentText(res)).toContain(want);
    });
});

describe("list_gaps", () => {
    // go: Test_gapTools_list
    it("lists the gaps as Go marshals them", async () => {
        // --- Given ---
        const { store } = newStore();
        await store.append(TEST_GAP);
        const done = await store.append({
            ...TEST_GAP,
            kind: "wrong",
            topic: "b",
        });
        await store.wontfix(done, "why");
        const client = await connectStore(store);

        // --- When ---
        const res = await client.callTool({
            name: "list_gaps",
            arguments: { status: "open" },
        });

        // --- Then ---
        expect(res.isError).toBeFalsy();
        expect(contentText(res)).toBe(
            '{"gaps":[{"answer":"","ask":[],"asked":"",' +
                '"created":"2026-07-14T10:00:00Z",' +
                '"demand":"SRD-1 needs it.","detail":"Never stated.","doc_id":"",' +
                '"file":"gap-0001-a.md","filled_by":[],"heading_path":[],"hits":1,' +
                '"id":"gap-0001","kind":"missing","search_terms":[],"srd_ref":"",' +
                '"status":"open","target_claim":"","topic":"a"}],"invalid":[]}',
        );
    });

    // go: Test_gapTools_list_drafts_by_srd_ref
    it("filters drafts by SRD reference", async () => {
        // --- Given ---
        const { store } = newStore();
        const mine = { ...TEST_GAP, srdRef: "initiatives/checkout/srd.md §2" };
        await store.append(mine);
        const id = await store.appendDraft(mine);
        await store.appendDraft({
            ...TEST_GAP,
            srdRef: "initiatives/wishlist/srd.md §2",
        });
        const client = await connectStore(store);

        // --- When ---
        const res = await client.callTool({
            name: "list_gaps",
            arguments: { status: "draft", srd_ref: "checkout" },
        });

        // --- Then ---
        expect(decode<ListOut>(res).gaps.map((g) => g.id)).toEqual([id]);
    });

    // go: Test_gapTools_list_ask_and_asked
    it("filters by ask and asked", async () => {
        // --- Given --- 1 asks Anna, sent; 2 asks Anna, not sent; 3 asks Bob.
        const { store } = newStore();
        const sent = { ...TEST_GAP, ask: ["Anna M"], asked: "2026-10-04" };
        const id = await store.append(sent);
        await store.append({ ...TEST_GAP, ask: ["Anna M"] });
        await store.append({ ...sent, ask: ["Bob"] });
        const client = await connectStore(store);

        // --- When ---
        const res = await client.callTool({
            name: "list_gaps",
            arguments: { ask: "anna", asked: true },
        });

        // --- Then ---
        const have = decode<ListOut>(res).gaps;
        expect(have.map((g) => g.id)).toEqual([id]);
        expect(have[0]?.ask).toEqual(["Anna M"]);
        expect(have[0]?.asked).toBe("2026-10-04");
    });

    // go: Test_gapTools_list_query_ranks_by_relevance
    it("ranks a query by relevance", async () => {
        // --- Given ---
        const { store } = newStore();
        await seedRanked(store);
        const client = await connectStore(store);

        // --- When ---
        const res = await client.callTool({
            name: "list_gaps",
            arguments: { query: "download token" },
        });

        // --- Then ---
        const have = decode<ListOut>(res).gaps;
        expect(have.map((g) => g.id)).toEqual(["gap-0002", "gap-0003"]);
        expect(have[0]?.score).toBeGreaterThan(have[1]?.score as number);
        expect(contentText(res)).toContain('"score":');
    });

    // go: Test_gapTools_list_query_with_filters
    it("filters a ranked query", async () => {
        // --- Given ---
        const { store } = newStore();
        await seedRanked(store);
        await store.wontfix("gap-0002", "why");
        const client = await connectStore(store);

        // --- When ---
        const res = await client.callTool({
            name: "list_gaps",
            arguments: { status: "open", srd_ref: "SRD-", query: "download" },
        });

        // --- Then ---
        expect(decode<ListOut>(res).gaps.map((g) => g.id)).toEqual([
            "gap-0003",
        ]);
    });

    // go: Test_gapTools_list_stale
    it("lists stale gaps", async () => {
        // --- Given --- a stale filled gap after a current one.
        const { store } = newStore();
        const id = await store.append(TEST_GAP);
        await store.fill(id, { refs: ["epub"], complete: true });
        await store.import(STALE_GAP);
        const client = await connectStore(store);

        // --- When ---
        const res = await client.callTool({
            name: "list_gaps",
            arguments: { stale: true },
        });

        // --- Then ---
        const have = decode<ListOut>(res).gaps;
        expect(have.map((g) => [g.id, g.status])).toEqual([
            ["gap-0009", "filled"],
        ]);
        expect(contentText(res)).toContain(
            '"stale":true,"stale_refs":[{"reason":"changed","ref":"epub"}]',
        );
    });

    // go: Test_gapTools_list_invalid
    it("lists invalid files whatever the filter", async () => {
        // --- Given ---
        const { store, fs } = newStore();
        await store.append(TEST_GAP);
        fs.writeFile("/gaps/gap-0002-junk.md", "junk");
        const client = await connectStore(store);

        // --- When ---
        const res = await client.callTool({
            name: "list_gaps",
            arguments: { status: "draft" },
        });

        // --- Then ---
        expect(contentText(res)).toBe(
            '{"gaps":[],"invalid":[{"file":"gap-0002-junk.md",' +
                '"reason":"no front matter"}]}',
        );
    });

    // go: Test_gapTools_list_error_bad_files
    it("hides a failing bad-file scan", async () => {
        // --- Given ---
        const { store } = newStore();
        const failing: GapStore = Object.assign(
            Object.create(store) as FileStore,
            {
                badFiles: () => Promise.reject(new Error("disk on fire")),
            },
        );
        const logged: unknown[] = [];
        const { engine } = await newEngine();
        const client = await connect({
            engine,
            version: "x",
            store: failing,
            logErr: (err) => logged.push(err),
        });

        // --- When ---
        const res = await client.callTool({ name: "list_gaps", arguments: {} });

        // --- Then ---
        expect(res.isError).toBe(true);
        expect(contentText(res)).toBe("internal error");
        expect(logged.map((e) => (e as Error).message)).toEqual([
            "disk on fire",
        ]);
    });

    // go: Test_gapTools_list_error_unknown_status
    it("refuses an unknown status", async () => {
        // --- Given ---
        const client = await connectStore(newStore().store);

        // --- When ---
        const res = await client.callTool({
            name: "list_gaps",
            arguments: { status: "resolved" },
        });

        // --- Then ---
        expect(res.isError).toBe(true);
        expect(contentText(res)).toContain('unknown status "resolved"');
    });
});

describe("update_gap", () => {
    // go: Test_gapTools_update
    it("changes the given fields", async () => {
        // --- Given ---
        const { store } = newStore();
        const id = await store.append(TEST_GAP);
        const client = await connectStore(store);

        // --- When ---
        const res = await client.callTool({
            name: "update_gap",
            arguments: {
                gap_id: id,
                doc_id: "shop/catalog/epub.md",
                detail: "States otherwise.",
                add_hit: true,
            },
        });

        // --- Then ---
        expect(contentText(res)).toBe('{"ok":true}');
        const [gap] = await store.list({});
        expect(gap?.topic).toBe("a");
        expect(gap?.docID).toBe("epub");
        expect(gap?.detail).toBe("States otherwise.");
        expect(gap?.hits).toBe(2);
    });

    // go: Test_gapTools_update_ask_and_asked
    it("sets ask and asked", async () => {
        // --- Given ---
        const { store } = newStore();
        const id = await store.append(TEST_GAP);
        const client = await connectStore(store);

        // --- When ---
        await client.callTool({
            name: "update_gap",
            arguments: {
                gap_id: id,
                ask: ["Anna M", "anna m", "Bob"],
                asked: "2026-10-04",
            },
        });

        // --- Then ---
        const [gap] = await store.list({});
        expect(gap?.ask).toEqual(["Anna M", "Bob"]);
        expect(gap?.asked).toBe("2026-10-04");
    });

    // go: Test_gapTools_update_clears_asked
    it("clears asked", async () => {
        // --- Given ---
        const { store } = newStore();
        const id = await store.append({
            ...TEST_GAP,
            ask: ["Anna M"],
            asked: "2026-10-04",
        });
        const client = await connectStore(store);

        // --- When ---
        await client.callTool({
            name: "update_gap",
            arguments: { gap_id: id, asked: "" },
        });

        // --- Then ---
        const [gap] = await store.list({});
        expect(gap?.ask).toEqual(["Anna M"]);
        expect(gap?.asked).toBe("");
    });

    // go: Test_gapTools_update_error_asked
    it("refuses a bad asked date", async () => {
        // --- Given ---
        const { store } = newStore();
        const id = await store.append(TEST_GAP);
        const client = await connectStore(store);

        // --- When ---
        const res = await client.callTool({
            name: "update_gap",
            arguments: { gap_id: id, asked: "yesterday" },
        });

        // --- Then ---
        expect(res.isError).toBe(true);
        expect(contentText(res)).toContain(
            'asked: want a YYYY-MM-DD date, have "yesterday"',
        );
    });

    // go: Test_gapTools_update_error_filled
    it("refuses a filled gap", async () => {
        // --- Given ---
        const { store } = newStore();
        const id = await store.append(TEST_GAP);
        await store.fill(id, { refs: ["epub"], complete: true });
        const client = await connectStore(store);

        // --- When ---
        const res = await client.callTool({
            name: "update_gap",
            arguments: { gap_id: id, topic: "b" },
        });

        // --- Then ---
        expect(res.isError).toBe(true);
        expect(contentText(res)).toBe(
            "update gap-0001: gap status does not allow the operation: " +
                "it is filled, the operation needs draft or open",
        );
    });
});

describe("submit_gap and discard_gap", () => {
    // go: Test_gapTools_submit
    it("submits a draft", async () => {
        // --- Given ---
        const { store } = newStore();
        const id = await store.appendDraft(TEST_GAP);
        const client = await connectStore(store);

        // --- When ---
        const res = await client.callTool({
            name: "submit_gap",
            arguments: { gap_id: id },
        });

        // --- Then ---
        expect(decode(res)).toEqual({ ok: true });
        expect((await store.list({}))[0]?.status).toBe("open");
    });

    // go: Test_gapTools_submit_error_unknown_id
    it("refuses an unknown id", async () => {
        // --- Given ---
        const client = await connectStore(newStore().store);

        // --- When ---
        const res = await client.callTool({
            name: "submit_gap",
            arguments: { gap_id: "gap-0404" },
        });

        // --- Then ---
        expect(res.isError).toBe(true);
        expect(contentText(res)).toBe("submit gap-0404: gap not found");
    });

    // go: Test_gapTools_discard
    it("discards a draft", async () => {
        // --- Given ---
        const { store } = newStore();
        const id = await store.appendDraft(TEST_GAP);
        const client = await connectStore(store);

        // --- When ---
        const res = await client.callTool({
            name: "discard_gap",
            arguments: { gap_id: id },
        });

        // --- Then ---
        expect(decode(res)).toEqual({ ok: true });
        expect(await store.list({})).toEqual([]);
    });

    // go: Test_gapTools_discard_error_not_draft
    it("refuses to discard an open gap", async () => {
        // --- Given ---
        const { store } = newStore();
        const id = await store.append(TEST_GAP);
        const client = await connectStore(store);

        // --- When ---
        const res = await client.callTool({
            name: "discard_gap",
            arguments: { gap_id: id },
        });

        // --- Then ---
        expect(res.isError).toBe(true);
        expect(contentText(res)).toContain(
            "it is open, the operation needs draft",
        );
        expect(await store.list({})).toHaveLength(1);
    });

    // go: Test_gapTools_invalid_file
    it("refuses an invalid file and keeps it", async () => {
        // --- Given ---
        const { store, fs } = newStore();
        fs.writeFile("/gaps/gap-0001-junk.md", "junk");
        const client = await connectStore(store);

        // --- When ---
        const res = await client.callTool({
            name: "submit_gap",
            arguments: { gap_id: "gap-0001" },
        });

        // --- Then ---
        expect(res.isError).toBe(true);
        expect(contentText(res)).toBe(
            "submit gap-0001: invalid gap file gap-0001-junk.md: no front matter",
        );
        expect(fs.readFile("/gaps/gap-0001-junk.md")).toBe("junk");
    });
});

describe("fill_gap", () => {
    // go: Test_gapTools_fill
    it("fills a gap completely", async () => {
        // --- Given ---
        const { store } = newStore();
        const id = await store.append(TEST_GAP);
        const client = await connectStore(store);

        // --- When ---
        const res = await client.callTool({
            name: "fill_gap",
            arguments: {
                gap_id: id,
                filled_by: ["shop/catalog/epub.md#tokens"],
                complete: true,
            },
        });

        // --- Then ---
        expect(decode(res)).toEqual({ ok: true });
        const [gap] = await store.list({});
        expect(gap?.status).toBe("filled");
        expect(gap?.filledBy).toEqual([
            { ref: "epub#tokens", hash: hash("epub#tokens") },
        ]);
    });

    // go: Test_gapTools_fill_refreshes_filled_gap
    it("refreshes a stale filled gap", async () => {
        // --- Given ---
        const { store } = newStore();
        await store.import(STALE_GAP);
        const client = await connectStore(store);

        // --- When ---
        const res = await client.callTool({
            name: "fill_gap",
            arguments: {
                gap_id: STALE_GAP.id,
                filled_by: ["epub"],
                complete: true,
            },
        });

        // --- Then ---
        expect(res.isError).toBeFalsy();
        const [gap] = await store.list({});
        expect(gap?.status).toBe("filled");
        expect(gap?.stale).toBe(false);
    });

    // go: Test_gapTools_fill_partial
    it("fills a gap partly", async () => {
        // --- Given ---
        const { store } = newStore();
        const id = await store.append(TEST_GAP);
        const client = await connectStore(store);

        // --- When ---
        await client.callTool({
            name: "fill_gap",
            arguments: {
                gap_id: id,
                filled_by: ["epub"],
                remaining: "The unit is unknown.",
            },
        });

        // --- Then ---
        const [gap] = await store.list({});
        expect(gap?.status).toBe("open");
        expect(gap?.filledBy).toEqual([{ ref: "epub", hash: hash("epub") }]);
        expect(gap?.detail).toBe("The unit is unknown.");
    });

    // go: Test_gapTools_fill_error_tabular
    it.each([
        ["empty filled_by", null, "filled_by is required"],
        ["unknown doc", ["shop/nope.md"], "unknown reference"],
        ["unknown anchor", ["epub#nope"], 'reference "epub#nope"'],
        ["url", ["https://ex.com/a"], 'unknown reference "https:'],
        [
            "under initiatives",
            ["initiatives/int7.md#scope"],
            '"initiatives/int7.md#scope" is under the initiatives folder',
        ],
    ])("refuses %s", async (_name, refs, want) => {
        // --- Given ---
        const { store } = newStore();
        const id = await store.append(TEST_GAP);
        const client = await connectStore(store);

        // --- When ---
        const res = await client.callTool({
            name: "fill_gap",
            arguments: { gap_id: id, filled_by: refs, complete: true },
        });

        // --- Then ---
        expect(res.isError).toBe(true);
        expect(contentText(res)).toContain(want);
        expect((await store.list({}))[0]?.status).toBe("open");
    });
});

describe("reopen_gap and wontfix_gap", () => {
    // go: Test_gapTools_reopen
    it("reopens a filled gap", async () => {
        // --- Given ---
        const { store } = newStore();
        const id = await store.append(TEST_GAP);
        await store.fill(id, { refs: ["epub"], complete: true });
        const client = await connectStore(store);

        // --- When ---
        const res = await client.callTool({
            name: "reopen_gap",
            arguments: { gap_id: id, reason: "Section rewritten." },
        });

        // --- Then ---
        expect(decode(res)).toEqual({ ok: true });
        const [gap] = await store.list({});
        expect(gap?.status).toBe("open");
        expect(gap?.filledBy).toEqual([{ ref: "epub", hash: hash("epub") }]);
        expect(gap?.detail).toBe(
            "Never stated.\n\nReopened 2026-07-14: Section rewritten.",
        );
    });

    // go: Test_gapTools_reopen_error_open
    it("refuses to reopen an open gap", async () => {
        // --- Given ---
        const { store } = newStore();
        const id = await store.append(TEST_GAP);
        const client = await connectStore(store);

        // --- When ---
        const res = await client.callTool({
            name: "reopen_gap",
            arguments: { gap_id: id, reason: "why" },
        });

        // --- Then ---
        expect(res.isError).toBe(true);
        expect(contentText(res)).toContain(
            "it is open, the operation needs filled",
        );
    });

    // go: Test_gapTools_wontfix
    it("closes a gap unfilled", async () => {
        // --- Given ---
        const { store } = newStore();
        const id = await store.append(TEST_GAP);
        const client = await connectStore(store);

        // --- When ---
        const res = await client.callTool({
            name: "wontfix_gap",
            arguments: { gap_id: id, reason: "Internal only." },
        });

        // --- Then ---
        expect(decode(res)).toEqual({ ok: true });
        expect((await store.list({}))[0]?.status).toBe("wontfix");
    });

    // go: Test_gapTools_wontfix_error_blank_reason
    it("refuses a blank reason", async () => {
        // --- Given ---
        const { store } = newStore();
        const id = await store.append(TEST_GAP);
        const client = await connectStore(store);

        // --- When ---
        const res = await client.callTool({
            name: "wontfix_gap",
            arguments: { gap_id: id, reason: "" },
        });

        // --- Then ---
        expect(res.isError).toBe(true);
        expect(contentText(res)).toContain("reason is required");
    });
});

interface CallCase {
    name: string;
    files?: Record<string, string>;
    calls: { name: string; arguments?: Record<string, unknown> }[];
}

/** Gap-tool call scripts and Go's raw tools/call results (oracle `call`). */
const cases = readGolden<CallCase[]>(
    new URL("testdata/call-gaps.cases.json", import.meta.url),
);
const golden = readGolden<{ name: string; results: unknown[] }[]>(
    new URL("testdata/call-gaps.golden.json", import.meta.url),
);

describe("gap tool calls", () => {
    it.each(cases.map((cs, i) => [cs.name, cs, golden[i]] as const))(
        "%s matches the Go server call by call",
        async (_name, cs, want) => {
            // --- Given ---
            const { tools } = await bookshop(
                cs.files ? { files: cs.files } : {},
            );

            // --- When ---
            const have: unknown[] = [];
            for (const call of cs.calls) {
                try {
                    have.push(await tools.call(call.name, call.arguments));
                } catch (err) {
                    const e = err as RPCError;
                    have.push({ error: { code: e.code, message: e.message } });
                }
            }

            // --- Then ---
            const norm = JSON.parse(
                JSON.stringify(have).replaceAll(ROOT, "<root>"),
            );
            (want?.results ?? []).forEach((res, i) => {
                expect([i, norm[i]]).toEqual([i, res]);
            });
            expect(norm).toHaveLength(want?.results.length ?? -1);
        },
    );
});
