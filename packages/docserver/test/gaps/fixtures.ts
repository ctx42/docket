// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Shared fixtures of the FileStore tests, ported from the Go package's
// all_test.go.

import { posixJoin } from "@docket/core";

import { FileStore, type FileStoreOptions } from "../../src/gaps/file-store.ts";
import {
    EC_INVALID,
    emptyGap,
    fileName,
    type Gap,
    gapError,
    hash,
    type ResolvedRef,
    type Resolver,
} from "../../src/gaps/gaps.ts";
import { newGapFile, renderGapFile } from "../../src/gaps/render.ts";
import { goQuote } from "../../src/gocompat/strconv.ts";
import type { GoTime } from "../../src/gocompat/time.ts";
import { MemDocFs } from "../support/mem-doc-fs.ts";

/** DIR is the gap folder of the test stores. */
export const DIR = "/gaps";

/** TEST_EPOCH is the fixed time the test clock reports. */
export const TEST_EPOCH: GoTime = {
    unix: Date.UTC(2026, 6, 14, 10) / 1000,
    nsec: 0,
    offset: 0,
};

/**
 * MapResolver maps each known reference to its normalized form and refuses
 * every other; a reference's text hashes as its normalized form does.
 * resolveFill also refuses a reference normalized under "initiatives/".
 */
export class MapResolver implements Resolver {
    constructor(readonly refs: Readonly<Record<string, string>>) {}

    async resolve(ref: string): Promise<ResolvedRef> {
        const norm = this.refs[ref];
        if (norm === undefined) {
            throw gapError(EC_INVALID, `unknown reference ${goQuote(ref)}`);
        }
        return { norm, hash: hash(norm) };
    }

    async resolveFill(ref: string): Promise<ResolvedRef> {
        const res = await this.resolve(ref);
        if (res.norm.startsWith("initiatives/")) {
            throw gapError(
                EC_INVALID,
                `${goQuote(ref)} is under the initiatives folder`,
            );
        }
        return res;
    }

    async current(ref: string): Promise<string> {
        return (await this.resolve(ref)).hash;
    }
}

/** TEST_RESOLVER knows the documents and sections the tests reference. */
export const TEST_RESOLVER = new MapResolver({
    "shop-docs/epub.md": "shop-docs/epub.md",
    epub: "epub",
    "docs/catalog/epub.md": "epub",
    "epub#delivery": "epub#delivery",
    "epub#tokens": "epub#tokens",
    "docs/catalog/epub.md#tokens": "epub#tokens",
    "kb/shipping.md": "kb/shipping.md",
    "kb/shipping.md#express-times": "kb/shipping.md#express-times",
    "initiatives/int7.md#scope": "initiatives/int7.md#scope",
});

/** AUTHORED is a gap with every author-supplied field set. */
export const AUTHORED: Gap = {
    ...emptyGap(),
    kind: "missing",
    answer: "deferred",
    srdRef: "SRD-7 §4.3",
    docID: "docs/catalog/epub.md",
    headingPath: ["Catalog", "Delivery"],
    searchTerms: ["token", "ttl"],
    topic: "EPUB download token TTL",
    demand: "SRD-7 needs the token TTL.",
    detail: "TTL never stated.",
    targetClaim: "Token valid 24h.",
};

/** AUTHORED_NAME is the file name Append gives AUTHORED as gap-0001. */
export const AUTHORED_NAME = "gap-0001-epub-download-token-ttl.md";

/** AUTHORED_STORED is AUTHORED as Append stores it as gap-0001. */
export const AUTHORED_STORED: Gap = {
    ...AUTHORED,
    id: "gap-0001",
    status: "open",
    docID: "epub",
    hits: 1,
    created: TEST_EPOCH,
};

/** IMPORTED is a fully specified filled gap, as Import takes it. */
export const IMPORTED: Gap = {
    ...emptyGap(),
    id: "gap-0007",
    status: "filled",
    kind: "incomplete",
    docID: "docs/catalog/epub.md",
    hits: 3,
    created: { unix: Date.UTC(2026, 4, 2, 8, 30) / 1000, nsec: 0, offset: 0 },
    filledBy: [{ ref: "docs/catalog/epub.md#tokens", hash: "ab" }],
    topic: "EPUB token lifetime",
    demand: "SRD-7 needs it.",
    detail: "Stated now.",
};

/** IMPORTED_NAME is the file name Import gives IMPORTED. */
export const IMPORTED_NAME = "gap-0007-epub-token-lifetime.md";

/**
 * RANKED_GAPS are three open gaps gap-0001 to gap-0003 on distinct topics:
 * "download token" matches the second by its topic and the third only by a
 * search term.
 */
export const RANKED_GAPS: Gap[] = [
    {
        ...emptyGap(),
        kind: "missing",
        topic: "Shipping rates for Canada",
        demand: "SRD-2 prices parcels.",
        detail: "No rate table.",
    },
    {
        ...emptyGap(),
        kind: "missing",
        srdRef: "SRD-7",
        topic: "EPUB download token lifetime",
        demand: "SRD-7 needs the token lifetime.",
        detail: "Never stated.",
    },
    {
        ...emptyGap(),
        kind: "incomplete",
        srdRef: "SRD-9",
        searchTerms: ["download"],
        topic: "Gift card expiry",
        demand: "SRD-9 sells gift cards.",
        detail: "Expiry rules missing.",
    },
].map((gap, i) => ({
    ...gap,
    id: `gap-${String(i + 1).padStart(4, "0")}`,
    status: "open" as const,
    hits: 1,
    created: TEST_EPOCH,
}));

/** gapFileText returns the file the store renders for gap. */
export function gapFileText(gap: Gap): string {
    return renderGapFile(newGapFile(fileName(gap), gap));
}

/**
 * writeGap writes gap, fully specified, to its file in the folder dir of
 * mfs as the store renders it, without resolving its references.
 */
export function writeGap(mfs: MemDocFs, dir: string, gap: Gap): void {
    mfs.writeFile(posixJoin(dir, fileName(gap)), gapFileText(gap));
}

/**
 * newStore returns an in-memory store over DIR with the test clock and
 * res, TEST_RESOLVER by default; null makes a store without a resolver.
 */
export function newStore(
    opts: FileStoreOptions = {},
    res: Resolver | null = TEST_RESOLVER,
): { fst: FileStore; mfs: MemDocFs } {
    const mfs = new MemDocFs().mkdirp(DIR);
    const fst = new FileStore(
        mfs,
        DIR,
        () => TEST_EPOCH,
        res ?? undefined,
        opts,
    );
    return { fst, mfs };
}

/** Warnings collects the errors a store reports through `warn`. */
export class Warnings {
    readonly errs: Error[] = [];
    readonly warn = (err: Error): void => {
        this.errs.push(err);
    };
}

/**
 * DriftedResolver is TEST_RESOLVER, except that current reports the hash
 * the map holds for a reference, an empty one as vanished.
 */
export class DriftedResolver extends MapResolver {
    constructor(readonly hashes: Readonly<Record<string, string>>) {
        super(TEST_RESOLVER.refs);
    }

    override async current(ref: string): Promise<string> {
        const h = this.hashes[ref];
        if (h === undefined) return super.current(ref);
        if (h === "") throw gapError(EC_INVALID, `${goQuote(ref)} vanished`);
        return h;
    }
}

/**
 * BrokenResolver is TEST_RESOLVER, except that current fails with an error
 * other than ErrInvalid.
 */
export class BrokenResolver extends MapResolver {
    constructor() {
        super(TEST_RESOLVER.refs);
    }

    override async current(): Promise<string> {
        throw new Error("disk on fire");
    }
}
