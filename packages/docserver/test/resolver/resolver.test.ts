// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { Engine } from "../../src/engine/engine.ts";
import { FileStore } from "../../src/gaps/file-store.ts";
import {
    EC_INVALID,
    emptyGap,
    type Gap,
    hash,
    isGapError,
} from "../../src/gaps/gaps.ts";
import { DocResolver } from "../../src/resolver/resolver.ts";
import { MemDocFs } from "../support/mem-doc-fs.ts";

/** caught returns what fn throws. */
async function caught(fn: () => Promise<unknown>): Promise<Error> {
    try {
        await fn();
    } catch (err) {
        return err as Error;
    }
    throw new Error("did not throw");
}

/**
 * newResolver returns a resolver over three documents: one with an id and
 * a url, one with an id only, and one with neither.
 */
async function newResolver(): Promise<DocResolver> {
    const fs = new MemDocFs()
        .writeFile(
            "/c/catalog/epub.md",
            "---\nid: epub\nurl: https://ex.com/epub\n---\n" +
                "## Download tokens\n\nValid 24h.\n",
        )
        .writeFile(
            "/c/catalog/print.md",
            "---\nid: print\n---\n## Print runs\n",
        )
        .writeFile("/c/kb/shipping.md", "# Shipping\n\n## Express times?\n");
    const eng = await Engine.create({
        fs,
        sources: [{ name: "shop", dir: "/c" }],
    });
    return new DocResolver(eng);
}

/** DOC is the path of the single document of {@link newDocEngine}. */
const DOC = "/s/a.md";

/** newDocEngine returns an engine over source s holding a.md. */
async function newDocEngine(content: string) {
    const fs = new MemDocFs().writeFile(DOC, content);
    const eng = await Engine.create({
        fs,
        sources: [{ name: "s", dir: "/s" }],
    });
    return { eng, fs };
}

/**
 * newInitiativesEngine returns an engine over source p holding the SRD
 * initiatives/int1/srd.md and kb/page.md, exempting unranked.
 */
function newInitiativesEngine(unranked: string): Promise<Engine> {
    const fs = new MemDocFs()
        .writeFile(
            "/p/initiatives/int1/srd.md",
            "---\nid: srd1\n---\n## Tokens\n",
        )
        .writeFile("/p/kb/page.md", "## Tokens\n\nValid 24h.\n");
    return Engine.create({
        fs,
        sources: [{ name: "p", dir: "/p" }],
        ranking: { unranked },
    });
}

/** NEW_GAP is the gap the store tests append. */
const NEW_GAP: Gap = {
    ...emptyGap(),
    kind: "missing",
    topic: "t",
    demand: "d",
    detail: "x",
};

/** newGapStore returns an in-memory gap store resolving with rsv. */
function newGapStore(rsv: DocResolver): FileStore {
    const fs = new MemDocFs().mkdirp("/gaps");
    const now = { unix: Date.UTC(2026, 6, 14, 10) / 1000, nsec: 0, offset: 0 };
    return new FileStore(fs, "/gaps", () => now, rsv);
}

/** filledStore returns a gap store holding gap-0001 filled by s/a.md#a. */
async function filledStore(eng: Engine): Promise<FileStore> {
    const fst = newGapStore(new DocResolver(eng));
    const id = await fst.append(NEW_GAP);
    await fst.fill(id, { refs: ["s/a.md#a"], complete: true });
    return fst;
}

describe("DocResolver", () => {
    // go: Test_NewDocResolver
    it("starts without a cache", async () => {
        // --- Given ---
        const eng = await Engine.create({ fs: new MemDocFs(), sources: [] });

        // --- When ---
        const have = new DocResolver(eng);

        // --- Then ---
        expect(have.eng).toBe(eng);
        expect(have.cache).toBeUndefined();
    });
});

describe("DocResolver.resolve", () => {
    // go: Test_DocResolver_Resolve_tabular
    it.each([
        ["id", "epub", "epub", "## Download tokens\n\nValid 24h.\n"],
        [
            "path normalized to id",
            "shop/catalog/epub.md",
            "epub",
            "## Download tokens\n\nValid 24h.\n",
        ],
        [
            "id anchor",
            "epub#download-tokens",
            "epub#download-tokens",
            "## Download tokens\n\nValid 24h.",
        ],
        [
            "path anchor",
            "shop/catalog/epub.md#download-tokens",
            "epub#download-tokens",
            "## Download tokens\n\nValid 24h.",
        ],
        [
            "slug anchor",
            "print#print-runs",
            "print#print-runs",
            "## Print runs",
        ],
        [
            "no id",
            "shop/kb/shipping.md",
            "shop/kb/shipping.md",
            "# Shipping\n\n## Express times?",
        ],
        [
            "no id slug anchor",
            "shop/kb/shipping.md#express-times",
            "shop/kb/shipping.md#express-times",
            "## Express times?",
        ],
    ])("resolves by %s", async (_name, ref, want, wText) => {
        // --- Given ---
        const rsv = await newResolver();

        // --- When ---
        const have = await rsv.resolve(ref);

        // --- Then ---
        expect(have).toEqual({ norm: want, hash: hash(wText) });
    });

    // go: Test_DocResolver_Resolve_error_tabular
    it.each([
        ["unknown doc", "kb/nope.md", '"kb/nope.md" names no corpus document'],
        ["unknown doc with anchor", "nope#x", '"nope" names no corpus'],
        [
            "unknown anchor",
            "epub#nope",
            'document "epub" has no heading with anchor "nope"',
        ],
        [
            "anchor not slugged",
            "epub#Download-tokens",
            'no heading with anchor "Download-tokens"',
        ],
        ["empty anchor", "print#", 'no heading with anchor ""'],
    ])("refuses an %s", async (_name, ref, want) => {
        // --- Given ---
        const rsv = await newResolver();

        // --- When ---
        const err = await caught(() => rsv.resolve(ref));

        // --- Then ---
        expect(isGapError(err, EC_INVALID)).toBe(true);
        expect(err.message).toContain(want);
    });

    // go: Test_DocResolver_Resolve_error_file_removed
    it("refuses a removed file", async () => {
        // --- Given ---
        const { eng, fs } = await newDocEngine("## A\n");
        fs.removeAll(DOC);
        const rsv = new DocResolver(eng);

        // --- When ---
        const err = await caught(() => rsv.resolve("s/a.md#a"));

        // --- Then ---
        expect(isGapError(err, EC_INVALID)).toBe(true);
        expect(err.message).toContain('"s/a.md" names no corpus document');
    });

    // go: Test_DocResolver_Resolve_error_unparsable_tabular
    it.each([
        ["section", "s/a.md#a"],
        ["document", "s/a.md"],
    ])("refuses an unparsable %s", async (_name, ref) => {
        // --- Given ---
        const { eng, fs } = await newDocEngine("## A\n");
        fs.writeFile(DOC, "---\ntitle: [\n---\n## A\n");
        const rsv = new DocResolver(eng);

        // --- When ---
        const err = await caught(() => rsv.resolve(ref));

        // --- Then ---
        expect(isGapError(err, EC_INVALID)).toBe(true);
        expect(err.message).toContain('document "s/a.md" does not parse');
    });

    // go: Test_DocResolver_Resolve_reads_headings_from_disk
    it("reads headings from disk", async () => {
        // --- Given --- a heading added after indexing.
        const { eng, fs } = await newDocEngine("## Old\n");
        fs.writeFile(DOC, "## Old\n\n## New\n");
        const rsv = new DocResolver(eng);

        // --- When ---
        const have = await rsv.resolve("s/a.md#new");

        // --- Then ---
        expect(have).toEqual({ norm: "s/a.md#new", hash: hash("## New") });
    });

    // go: Test_DocResolver_Resolve_updates_cache
    it("updates the cache", async () => {
        // --- Given --- a section cached, then edited without a reload.
        const { eng, fs } = await newDocEngine("## A\nold\n");
        const rsv = new DocResolver(eng);
        await rsv.current("s/a.md#a");
        fs.writeFile(DOC, "## A\nnew\n");

        // --- When ---
        const have = await rsv.resolve("s/a.md#a");

        // --- Then ---
        expect(have.hash).toBe(hash("## A\nnew"));
        expect(await rsv.current("s/a.md#a")).toBe(have.hash);
    });

    // go: Test_DocResolver_Resolve_srd_under_initiatives
    it("resolves an SRD for doc_id", async () => {
        // --- Given ---
        const rsv = new DocResolver(
            await newInitiativesEngine("p/initiatives"),
        );

        // --- When ---
        const have = await rsv.resolve("p/initiatives/int1/srd.md");

        // --- Then ---
        expect(have.norm).toBe("srd1");
    });

    it("passes on a read failure other than a missing file", async () => {
        // --- Given ---
        const { eng, fs } = await newDocEngine("## A\n");
        fs.failOn("readText", DOC);
        const rsv = new DocResolver(eng);

        // --- When ---
        const err = await caught(() => rsv.resolve("s/a.md"));

        // --- Then ---
        expect(isGapError(err, EC_INVALID)).toBe(false);
        expect(err.message).toMatch(/^read s\/a\.md: /);
    });
});

describe("DocResolver.resolveFill", () => {
    // go: Test_DocResolver_ResolveFill_tabular
    it.each([
        [
            "kb section",
            "p/initiatives",
            "p/kb/page.md#tokens",
            "p/kb/page.md#tokens",
            "## Tokens\n\nValid 24h.",
        ],
        [
            "srd section without initiatives",
            "",
            "p/initiatives/int1/srd.md#tokens",
            "srd1#tokens",
            "## Tokens",
        ],
        ["srd without initiatives", "", "srd1", "srd1", "## Tokens\n"],
    ])("resolves a %s", async (_name, unranked, ref, want, wText) => {
        // --- Given ---
        const rsv = new DocResolver(await newInitiativesEngine(unranked));

        // --- When ---
        const have = await rsv.resolveFill(ref);

        // --- Then ---
        expect(have).toEqual({ norm: want, hash: hash(wText) });
    });

    // go: Test_DocResolver_ResolveFill_error_tabular
    it.each([
        [
            "srd section",
            "srd1#tokens",
            '"srd1#tokens" names p/initiatives/int1/srd.md, a document ' +
                "under the initiatives folder",
        ],
        [
            "srd document by path",
            "p/initiatives/int1/srd.md",
            "names p/initiatives/int1/srd.md, a document under the " +
                "initiatives folder",
        ],
        ["unknown doc", "nope#x", '"nope" names no corpus document'],
    ])("refuses an %s", async (_name, ref, want) => {
        // --- Given ---
        const rsv = new DocResolver(
            await newInitiativesEngine("p/initiatives"),
        );

        // --- When ---
        const err = await caught(() => rsv.resolveFill(ref));

        // --- Then ---
        expect(isGapError(err, EC_INVALID)).toBe(true);
        expect(err.message).toContain(want);
        expect(rsv.cache).toBeUndefined();
    });
});

describe("DocResolver.current", () => {
    // go: Test_DocResolver_Current
    it("hashes a section", async () => {
        // --- Given ---
        const rsv = await newResolver();

        // --- When ---
        const have = await rsv.current("epub#download-tokens");

        // --- Then ---
        expect(have).toBe(hash("## Download tokens\n\nValid 24h."));
    });

    // go: Test_DocResolver_Current_cached_per_generation
    it("caches per generation", async () => {
        // --- Given --- a section cached, then edited on disk.
        const { eng, fs } = await newDocEngine("## A\nold\n");
        const rsv = new DocResolver(eng);
        await rsv.current("s/a.md#a");
        fs.writeFile(DOC, "## A\nnew\n");
        const cached = await rsv.current("s/a.md#a");
        await eng.reload();

        // --- When ---
        const have = await rsv.current("s/a.md#a");

        // --- Then ---
        expect(have).toBe(hash("## A\nnew"));
        expect(cached).toBe(hash("## A\nold"));
    });

    // go: Test_DocResolver_Current_ignores_cosmetic_changes
    it("ignores cosmetic changes", async () => {
        // --- Given --- CRLF and trailing blank lines after a reload.
        const { eng, fs } = await newDocEngine("## A\nbody\n## B\n");
        const rsv = new DocResolver(eng);
        const before = await rsv.current("s/a.md#a");
        fs.writeFile(DOC, "## A\r\nbody\r\n\r\n\r\n## B\r\n");
        await eng.reload();

        // --- When ---
        const have = await rsv.current("s/a.md#a");

        // --- Then ---
        expect(have).toBe(before);
    });

    // go: Test_DocResolver_Current_error_vanished
    it("caches a vanished section", async () => {
        // --- Given --- the heading removed after indexing.
        const { eng, fs } = await newDocEngine("## A\n");
        const rsv = new DocResolver(eng);
        fs.writeFile(DOC, "## B\n");

        // --- When ---
        const err = await caught(() => rsv.current("s/a.md#a"));

        // --- Then ---
        expect(isGapError(err, EC_INVALID)).toBe(true);
        const cached = rsv.cache?.get("s/a.md#a");
        expect(isGapError(cached?.err, EC_INVALID)).toBe(true);
        await expect(rsv.current("s/a.md#a")).rejects.toBe(err);
    });

    it("does not cache another failure", async () => {
        // --- Given ---
        const { eng, fs } = await newDocEngine("## A\n");
        const rsv = new DocResolver(eng);
        fs.failOn("readText", DOC);

        // --- When ---
        const err = await caught(() => rsv.current("s/a.md#a"));

        // --- Then ---
        expect(isGapError(err, EC_INVALID)).toBe(false);
        expect(rsv.cache).toBeUndefined();
    });

    // go: Test_DocResolver_store_skips_other_generation
    it("skips storing for another generation", async () => {
        // --- Given ---
        const { eng } = await newDocEngine("## A\n");
        const rsv = new DocResolver(eng);

        // --- When ---
        rsv.store(7, "s/a.md#a", { hash: "x" });

        // --- Then ---
        expect(rsv.cache).toBeUndefined();
    });
});

describe("DocResolver with the gap store", () => {
    // go: Test_DocResolver_gap_staleness_after_reload_tabular
    it.each([
        ["unchanged", "## A\nbody\n\n## B\n", []],
        ["crlf and trailing blanks", "## A\r\nbody\r\n\r\n\r\n## B\r\n", []],
        [
            "section edited",
            "## A\nnew body\n\n## B\n",
            [{ ref: "s/a.md#a", reason: "changed" }],
        ],
        [
            "heading deleted",
            "body\n\n## B\n",
            [{ ref: "s/a.md#a", reason: "vanished" }],
        ],
        ["other section edited", "## A\nbody\n\n## B\nmore\n", []],
    ])("marks staleness after a reload: %s", async (_name, edit, want) => {
        // --- Given ---
        const { eng, fs } = await newDocEngine("## A\nbody\n\n## B\n");
        const fst = await filledStore(eng);
        await fst.list({});
        fs.writeFile(DOC, edit);
        await eng.reload();

        // --- When ---
        const have = await fst.list({});

        // --- Then ---
        expect(have[0]?.status).toBe("filled");
        expect(have[0]?.staleRefs).toEqual(want);
        expect(have[0]?.stale).toBe(want.length > 0);
    });

    // go: Test_DocResolver_gap_refresh_clears_stale
    it("clears staleness by refreshing the fill", async () => {
        // --- Given --- the filling section edited and reloaded.
        const { eng, fs } = await newDocEngine("## A\nbody\n");
        const fst = await filledStore(eng);
        fs.writeFile(DOC, "## A\nnew body\n");
        await eng.reload();
        const stale = await fst.list({ stale: true });

        // --- When ---
        await fst.fill("gap-0001", { refs: ["s/a.md#a"], complete: true });

        // --- Then ---
        expect(stale).toHaveLength(1);
        const have = await fst.list({});
        expect(have[0]?.status).toBe("filled");
        expect(have[0]?.stale).toBe(false);
        expect(have[0]?.filledBy).toEqual([
            { ref: "s/a.md#a", hash: hash("## A\nnew body") },
        ]);
    });

    // go: Test_DocResolver_gap_fill_initiatives_tabular
    it.each([
        ["kb section", "p/initiatives", "p/kb/page.md#tokens"],
        ["srd without initiatives", "", "srd1#tokens"],
    ])("fills from a %s", async (_name, unranked, ref) => {
        // --- Given ---
        const fst = newGapStore(
            new DocResolver(await newInitiativesEngine(unranked)),
        );
        const id = await fst.append(NEW_GAP);

        // --- When ---
        await fst.fill(id, { refs: [ref], complete: true });

        // --- Then ---
        const have = await fst.list({});
        expect(have[0]?.status).toBe("filled");
    });

    // go: Test_DocResolver_gap_fill_error_initiatives
    it("refuses a fill from an SRD", async () => {
        // --- Given ---
        const fst = newGapStore(
            new DocResolver(await newInitiativesEngine("p/initiatives")),
        );
        const id = await fst.append(NEW_GAP);

        // --- When ---
        const err = await caught(() =>
            fst.fill(id, { refs: ["srd1#tokens"], complete: true }),
        );

        // --- Then ---
        expect(isGapError(err, EC_INVALID)).toBe(true);
        expect(err.message).toContain("under the initiatives folder");
        const have = await fst.list({});
        expect(have[0]?.status).toBe("open");
        expect(have[0]?.filledBy).toEqual([]);
    });

    // go: Test_DocResolver_gap_import_error_initiatives
    it("refuses an import filled by an SRD", async () => {
        // --- Given --- a filled gap about the SRD, filled by its section.
        const fst = newGapStore(
            new DocResolver(await newInitiativesEngine("p/initiatives")),
        );
        const gap: Gap = {
            ...NEW_GAP,
            id: "gap-0001",
            status: "filled",
            hits: 1,
            created: { unix: 1_700_000_000, nsec: 0, offset: 0 },
            docID: "srd1",
            filledBy: [{ ref: "srd1#tokens", hash: "" }],
        };

        // --- When ---
        const err = await caught(() => fst.import(gap));

        // --- Then ---
        expect(isGapError(err, EC_INVALID)).toBe(true);
        expect(err.message).toMatch(
            /^import gap-0001: .*under the initiatives folder/,
        );
    });
});
