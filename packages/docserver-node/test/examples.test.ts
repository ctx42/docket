// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The bookshop example (a frozen copy of the Go repo's examples/bookshop)
// loads and serves under both of its configs.

import { fileURLToPath } from "node:url";

import {
    DocResolver,
    FileStore,
    fromDate,
    Glossary,
    loadConfig,
} from "@docket/docserver";
import { describe, expect, it } from "vitest";

import { NodeDocFs } from "../src/fs.ts";
import { checkGapDir, checkProject, newEngine } from "../src/run.ts";

/** BOOKSHOP is the example project's folder. */
const BOOKSHOP = fileURLToPath(new URL("testdata/bookshop/", import.meta.url));

describe("bookshop example", () => {
    // go: Test_examples_bookshop_project_config
    it("serves the project config", async () => {
        // --- Given ---
        const fs = new NodeDocFs();
        const logged: string[] = [];
        const cfg = await loadConfig(fs, `${BOOKSHOP}project-config.md`);

        // --- When ---
        const have = checkProject(fs, (line) => logged.push(line), cfg.project);

        // --- Then ---
        await expect(have).resolves.toBeUndefined();
        expect(logged).toEqual([]);

        await checkGapDir(fs, cfg.gaps);
        const eng = await newEngine(fs, cfg);
        expect(eng.listDocs()).toHaveLength(5);

        const store = new FileStore(
            fs,
            cfg.gaps,
            () => fromDate(new Date()),
            new DocResolver(eng),
        );
        const list = await store.list({});
        expect(list).toHaveLength(1);
        const ref = list[0]?.filledBy[0]?.ref as string;
        expect((await new DocResolver(eng).resolve(ref)).norm).toBe(ref);
        expect(list[0]?.stale).toBe(false);

        const res = await eng.search({ text: "EPUB download link" });
        expect(res[0]?.docID).toBe("epub-delivery");
        expect(res[0]?.docPath).toBe("docs/catalog/epub_delivery.md");
        expect(res[0]?.rank).toBe(3);

        expect((await eng.getDoc("kb/shipping_times.md")).rank).toBe(1);
        expect((await eng.getDoc("srd-wishlist-sharing")).rank).toBe(0);

        const terms = await new Glossary(eng, cfg.glossary).terms("");
        expect(terms).toHaveLength(3);
        await eng.close();
    });

    // go: Test_examples_bookshop_yaml
    it("serves the plain YAML config", async () => {
        // --- Given ---
        const fs = new NodeDocFs();

        // --- When ---
        const cfg = await loadConfig(fs, `${BOOKSHOP}bookshop.yaml`);

        // --- Then ---
        await checkGapDir(fs, cfg.gaps);
        const eng = await newEngine(fs, cfg);
        expect(eng.listDocs()).toHaveLength(5);
        expect(eng.listDocs()[0]?.rank).toBe(0);

        const res = await eng.search({ text: "gift card" });
        expect(res[0]?.docID).toBe("docs/ordering/checkout.md");
        await eng.close();
    });
});
