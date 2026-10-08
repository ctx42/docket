// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The MCP tests' server: the Go repo's bookshop example (frozen under
// testdata/bookshop) loaded into a MemDocFs and wired as the Go server wires
// a project: engine sources sorted by name, precedence ranking with the
// initiatives folder unranked, the gap store resolving against the corpus,
// and the glossary.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { loadProject } from "../../src/config/project.ts";
import { Engine } from "../../src/engine/engine.ts";
import { FileStore } from "../../src/gaps/file-store.ts";
import { Glossary } from "../../src/glossary/glossary.ts";
import { newMcpServer, type ToolDeps, Tools } from "../../src/mcp/tools.ts";
import { DocResolver } from "../../src/resolver/resolver.ts";
import { MemDocFs } from "../support/mem-doc-fs.ts";

/** ROOT is where the bookshop example lives in the MemDocFs. */
export const ROOT = "/bookshop";

/** EPOCH is the gap store's fixed clock. */
const EPOCH = { unix: Date.UTC(2026, 6, 14, 10) / 1000, nsec: 0, offset: 0 };

const SRC = new URL("testdata/bookshop", import.meta.url).pathname;

/** loadTree copies the directory src into mfs under dst. */
function loadTree(mfs: MemDocFs, src: string, dst: string): void {
    for (const name of readdirSync(src)) {
        const from = join(src, name);
        if (statSync(from).isDirectory()) loadTree(mfs, from, `${dst}/${name}`);
        else mfs.writeFile(`${dst}/${name}`, readFileSync(from));
    }
}

/** BookshopOptions select what the server holds. */
export interface BookshopOptions {
    /** files overlay the example, paths relative to it. */
    files?: Record<string, string>;
    store?: boolean;
    glossary?: boolean;
    logErr?: (err: unknown) => void;
}

/** bookshop returns the tool deps over the bookshop example and its fs. */
export async function bookshop(
    opts: BookshopOptions = {},
): Promise<{ deps: ToolDeps; tools: Tools; mfs: MemDocFs }> {
    const mfs = new MemDocFs();
    loadTree(mfs, SRC, ROOT);
    for (const [name, src] of Object.entries(opts.files ?? {}))
        mfs.writeFile(`${ROOT}/${name}`, src);
    const cfg = await loadProject(mfs, `${ROOT}/project-config.md`);
    const sources = [...cfg.sources.keys()].sort().map((name) => {
        const src = cfg.sources.get(name) as { dir: string; file: string };
        return src.dir !== ""
            ? { name, dir: src.dir }
            : { name, file: src.file };
    });
    const engine = await Engine.create({
        fs: mfs,
        sources,
        ranking: { precedence: cfg.precedence, unranked: cfg.initiatives },
    });
    const deps: ToolDeps = { engine, version: "0.0.0-oracle" };
    if (opts.store !== false && cfg.gaps !== "") {
        deps.store = new FileStore(
            mfs,
            cfg.gaps,
            () => EPOCH,
            new DocResolver(engine),
        );
    }
    if (opts.glossary !== false && cfg.glossary !== "")
        deps.glossary = new Glossary(engine, cfg.glossary);
    if (opts.logErr !== undefined) deps.logErr = opts.logErr;
    return { deps, tools: new Tools(deps), mfs };
}

/** connect serves deps over an in-memory transport pair; returns a client. */
export async function connect(deps: ToolDeps): Promise<Client> {
    const [srvTr, cliTr] = InMemoryTransport.createLinkedPair();
    await newMcpServer(deps).connect(srvTr);
    const client = new Client({ name: "test", version: "0.1.0" });
    await client.connect(cliTr);
    return client;
}

/** contentText concatenates the text blocks of a tool result. */
export function contentText(res: unknown): string {
    const { content } = res as { content?: { type: string; text?: string }[] };
    return (content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
}

/** decode parses a successful tool result's text content. */
export function decode<T>(res: unknown): T {
    return JSON.parse(contentText(res)) as T;
}

/** engineOver returns an engine over the files of one source "shop". */
export async function engineOver(
    files: Record<string, string>,
): Promise<{ engine: Engine; mfs: MemDocFs }> {
    const mfs = new MemDocFs();
    for (const [name, src] of Object.entries(files))
        mfs.writeFile(`/shop/${name}`, src);
    const engine = await Engine.create({
        fs: mfs,
        sources: [{ name: "shop", dir: "/shop" }],
    });
    return { engine, mfs };
}

/** newEngine is the Go tests' one-file corpus. */
export function newEngine() {
    return engineOver({
        "catalog/epub.md":
            "---\ntitle: EPUB Editions\n---\n\n" +
            "Readers download book data as EPUB.\n" +
            "See https://docs.example.com/epub\n",
    });
}

/** identityEngine holds one document with an id and a url, two sections. */
export function identityEngine() {
    const filler = "filler ".repeat(500);
    return engineOver({
        "g.md":
            '---\nid: doc-12\ntitle: G\nurl: "https://docs.example.com/g"\n---\n\n' +
            `## Overview\n\n${filler}\n\n` +
            `## License Plan\n\nA contracted service tier. ${filler}\n`,
    });
}

/** rankEngine is the Go tests' ranked project corpus. */
export async function rankEngine(): Promise<Engine> {
    const mfs = new MemDocFs()
        .writeFile("/r/kb/a.md", "turbine blade\n")
        .writeFile("/r/doc/reference/b.md", "turbine manual\n")
        .writeFile("/r/doc/misc/c.md", "turbine misc\n")
        .writeFile("/r/initiatives/srd.md", "turbine srd\n");
    return Engine.create({
        fs: mfs,
        sources: [
            { name: "doc", dir: "/r/doc" },
            { name: "initiatives", dir: "/r/initiatives" },
            { name: "kb", dir: "/r/kb" },
        ],
        ranking: {
            precedence: ["kb", "doc/handbook", "doc/catalog", "doc/reference"],
            unranked: "initiatives",
        },
    });
}

/** glossaryEngine holds a two-term glossary folder and one other doc. */
export function glossaryEngine() {
    return engineOver({
        "glossary/main.md":
            '---\ntitle: Main\nurl: "https://ex.com/glossary"\n---\n\n' +
            "## Stock Keeping Unit (SKU)\n\nIdentifier of a book edition.\n\n" +
            "## Backorder\n\nOrder for an out-of-stock title.\n",
        "other.md": "## Outside\n\nNot a term.\n",
    });
}
