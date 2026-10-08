// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The startup and reload helpers of run.ts, ported from the earlier Go
// server's tests on the real filesystem.

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
    CLOSED_DIR,
    CloseReplacedError,
    type Config,
    DocResolver,
    Engine,
    emptyConfig,
    emptyGap,
    FileStore,
    type Filter,
    fromDate,
    type Gap,
    type Move,
    type Project,
    TidyError,
} from "@docket/docserver";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NodeDocFs } from "../src/fs.ts";
import {
    checkGapDir,
    checkProject,
    engineSources,
    logConfig,
    logStale,
    newEngine,
    reindexGaps,
    reload,
    tidyGaps,
    watchPaths,
} from "../src/run.ts";

const isRoot = process.getuid?.() === 0;

let dir: string;
let serr: string;
const nfs = new NodeDocFs();
const closers: (() => Promise<void> | void)[] = [];

/** log appends line to the captured stderr, as run's logger does. */
const log = (line: string) => {
    serr += `${line}\n`;
};

beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), "run-helpers-"));
    serr = "";
});

afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    fs.rmSync(dir, { recursive: true, force: true });
});

/** tempDir makes a fresh directory under the test's temp dir. */
function tempDir(): string {
    return fs.mkdtempSync(join(dir, "d-"));
}

/** writeMD writes content to name within base, creating parent dirs. */
function writeMD(base: string, name: string, content: string): string {
    const path = join(base, name);
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, content);
    return path;
}

/** writeMCPJSON writes a .mcp.json into base registering "srd" on port. */
function writeMCPJSON(base: string, port: number): void {
    const body =
        `{"mcpServers": {"srd": ` +
        `{"type": "http", "url": "http://localhost:${port}/mcp"}}}`;
    fs.writeFileSync(join(base, ".mcp.json"), body);
}

/** corpusDir writes the shared one-document corpus and returns its dir. */
function corpusDir(): string {
    const base = tempDir();
    writeMD(
        base,
        "catalog/epub.md",
        "---\ntitle: EPUB Editions\n---\n\n" +
            "Readers download book data as EPUB.\n",
    );
    return base;
}

/** newConfig returns an empty config with fields from over. */
function newConfig(over: Partial<Config>): Config {
    return { ...emptyConfig(), ...over };
}

/** newGap returns a valid wrong-kind gap about topic. */
function newGap(topic: string): Gap {
    return {
        ...emptyGap(),
        kind: "wrong",
        topic,
        demand: "d",
        detail: "x",
    };
}

/** openEngine creates an engine, closed after the test. */
async function openEngine(
    sources: { name: string; dir: string }[],
): Promise<Engine> {
    const eng = await Engine.create({ fs: nfs, sources });
    closers.push(() => eng.close());
    return eng;
}

/**
 * gapStore builds the gap store as run() does (Go `gapStore`): resolving
 * against eng and writing each warning's message to stderr.
 */
async function gapStore(gapDir: string): Promise<FileStore> {
    const eng = await openEngine([]);
    const gst = new FileStore(
        nfs,
        gapDir,
        () => fromDate(new Date()),
        new DocResolver(eng),
        { warn: (err) => log(err.message) },
    );
    closers.push(() => gst.close());
    return gst;
}

/** names returns the sorted entry names of a directory. */
function names(path: string): string[] {
    return fs.readdirSync(path).sort();
}

describe("logConfig", () => {
    // go: Test_logConfig_plain_yaml
    it("logs the sources of a plain YAML config sorted by name", () => {
        // --- Given ---
        const cfg = newConfig({
            sources: new Map([
                ["shop", { dir: "/docs/shop", file: "" }],
                ["notes", { dir: "", file: "/notes/arch.md" }],
            ]),
        });

        // --- When ---
        logConfig(log, cfg);

        // --- Then ---
        const want =
            "source notes at /notes/arch.md\n" + "source shop at /docs/shop\n";
        expect(serr).toBe(want);
    });
});

describe("checkProject", () => {
    // go: Test_checkProject_plain_yaml
    it("passes without a project", async () => {
        // --- When ---
        const have = checkProject(nfs, log, null);

        // --- Then ---
        await expect(have).resolves.toBeUndefined();
        expect(serr).toBe("");
    });

    // go: Test_checkProject_registered
    it("passes when .mcp.json registers the port", async () => {
        // --- Given ---
        const root = tempDir();
        writeMCPJSON(root, 7777);
        const prj: Project = { root, server: "srd", port: 7777 };

        // --- When ---
        const have = checkProject(nfs, log, prj);

        // --- Then ---
        await expect(have).resolves.toBeUndefined();
        expect(serr).toBe("");
    });

    // go: Test_checkProject_warns_without_mcp_json
    it("warns without .mcp.json", async () => {
        // --- Given ---
        const root = tempDir();
        const prj: Project = { root, server: "srd", port: 7777 };

        // --- When ---
        const have = checkProject(nfs, log, prj);

        // --- Then ---
        await expect(have).resolves.toBeUndefined();
        const want =
            `warning: no .mcp.json in ${root}; cannot confirm that ` +
            'mcp-server "srd" is registered on port 7777\n';
        expect(serr).toBe(want);
    });

    // go: Test_checkProject_error_mismatch
    it("fails when .mcp.json names another port", async () => {
        // --- Given ---
        const root = tempDir();
        writeMCPJSON(root, 7778);
        const prj: Project = { root, server: "srd", port: 7777 };

        // --- When ---
        const have = checkProject(nfs, log, prj);

        // --- Then ---
        await expect(have).rejects.toThrow(
            "uses port 7778, but mcp-port is 7777",
        );
        expect(serr).toBe("");
    });
});

describe("checkGapDir", () => {
    // go: Test_checkGapDir
    it("passes for a writable directory", async () => {
        // --- When ---
        const have = checkGapDir(nfs, tempDir());

        // --- Then ---
        await expect(have).resolves.toBeUndefined();
    });

    // go: Test_checkGapDir_empty_path_disables_feature
    it("passes for an empty path", async () => {
        // --- When ---
        const have = checkGapDir(nfs, "");

        // --- Then ---
        await expect(have).resolves.toBeUndefined();
    });

    // go: Test_checkGapDir_error_missing_dir
    it("fails for a missing directory", async () => {
        // --- When ---
        const have = checkGapDir(nfs, join(tempDir(), "absent"));

        // --- Then ---
        await expect(have).rejects.toThrow("gaps folder: stat ");
    });

    // go: Test_checkGapDir_error_dir_is_a_file
    it("fails for a file", async () => {
        // --- Given ---
        const file = writeMD(tempDir(), "notadir", "x");

        // --- When ---
        const have = checkGapDir(nfs, file);

        // --- Then ---
        await expect(have).rejects.toThrow("is not a directory");
    });

    // go: Test_checkGapDir_error_unwritable_dir
    it.skipIf(isRoot)("fails for an unwritable directory", async () => {
        // --- Given ---
        const ro = join(tempDir(), "ro");
        fs.mkdirSync(ro);
        fs.chmodSync(ro, 0o500);
        closers.push(() => fs.chmodSync(ro, 0o700));

        // --- When ---
        const have = checkGapDir(nfs, ro);

        // --- Then ---
        await expect(have).rejects.toThrow("is not writable");
    });
});

describe("gap store as run builds it", () => {
    // go: Test_gapStore
    it("appends gaps", async () => {
        // --- Given ---
        const gapDir = tempDir();

        // --- When ---
        const have = await gapStore(gapDir);

        // --- Then ---
        await expect(have.append(newGap("t"))).resolves.toBe("gap-0001");
    });

    // go: Test_gapStore_warns_on_stderr
    it.skipIf(isRoot)("writes rebuild warnings to stderr", async () => {
        // --- Given --- an index whose rebuild after a write meets an
        // unreadable gap file.
        const gapDir = tempDir();
        const gst = await gapStore(gapDir);
        await gst.reindex();
        await gst.append(newGap("t"));
        await gst.append(newGap("t"));
        fs.chmodSync(join(gapDir, "gap-0002-t.md"), 0o000);

        // --- When ---
        const have = gst.update("gap-0001", { addHit: true });

        // --- Then ---
        await expect(have).resolves.toBeUndefined();
        const want = "gap index: rebuild after write: read gap file: open ";
        expect(serr).toContain(want);
    });

    // go: Test_gapStore_logs_invalid_file
    it("logs an invalid gap file", async () => {
        // --- Given ---
        const gapDir = tempDir();
        fs.writeFileSync(join(gapDir, "gap-0003-x.md"), "junk");
        const gst = await gapStore(gapDir);

        // --- When ---
        const have = await gst.reindex();

        // --- Then ---
        expect(have).toBe(0);
        const want = "invalid gap file gap-0003-x.md: no front matter\n";
        expect(serr).toBe(want);
    });
});

describe("tidyGaps", () => {
    // go: Test_tidyGaps
    it("moves misplaced gap files and logs each move", async () => {
        // --- Given --- a filled gap at the top of the gaps folder and an
        // open gap in its closed folder.
        const gapDir = tempDir();
        const gst = new FileStore(
            nfs,
            gapDir,
            () => fromDate(new Date()),
            undefined,
        );
        closers.push(() => gst.close());
        await gst.append(newGap("a"));
        await gst.append(newGap("a"));
        await gst.wontfix("gap-0001", "why");
        const closed = join(gapDir, CLOSED_DIR);
        fs.renameSync(
            join(closed, "gap-0001-a.md"),
            join(gapDir, "gap-0001-a.md"),
        );
        fs.renameSync(
            join(gapDir, "gap-0002-a.md"),
            join(closed, "gap-0002-a.md"),
        );

        // --- When ---
        await tidyGaps(log, gst);

        // --- Then ---
        const want =
            "moved gap-0001-a.md to closed/\n" +
            "moved closed/gap-0002-a.md out of closed/\n";
        expect(serr).toBe(want);
        expect(names(gapDir)).toEqual([CLOSED_DIR, "gap-0002-a.md"]);
        expect(names(closed)).toEqual(["gap-0001-a.md"]);
    });

    // go: Test_tidyGaps_error
    it("logs the moves made before a failure and the failure", async () => {
        // --- Given ---
        const moves: Move[] = [
            { from: "gap-0001-a.md", to: "closed/gap-0001-a.md" },
        ];
        const gst = {
            tidy: (): Promise<Move[]> =>
                Promise.reject(new TidyError(moves, new Error("disk on fire"))),
        };

        // --- When ---
        await tidyGaps(log, gst);

        // --- Then ---
        const want =
            "moved gap-0001-a.md to closed/\n" +
            "gap tidy failed: disk on fire\n";
        expect(serr).toBe(want);
    });
});

describe("reindexGaps", () => {
    // go: Test_reindexGaps
    it("logs the gap count and duration", async () => {
        // --- Given ---
        const now = () => 0;
        const gst = new FileStore(
            nfs,
            tempDir(),
            () => fromDate(new Date(now())),
            undefined,
        );
        closers.push(() => gst.close());

        // --- When ---
        await reindexGaps(log, now, gst);

        // --- Then ---
        expect(serr).toBe("reindexed 0 gaps in 0s\n");
    });

    // go: Test_reindexGaps_error_keeps_index
    it("logs a failed rebuild", async () => {
        // --- Given ---
        const gst = {
            reindex: (): Promise<number> =>
                Promise.reject(new Error("disk on fire")),
        };

        // --- When ---
        await reindexGaps(log, () => 0, gst);

        // --- Then ---
        const want =
            "gap reindex failed, serving previous gap index: disk on fire\n";
        expect(serr).toBe(want);
    });
});

describe("logStale", () => {
    // go: Test_logStale
    it("logs the stale gap IDs", async () => {
        // --- Given ---
        let flt: Filter | undefined;
        const gst = {
            list: (in_: { stale: boolean }): Promise<Gap[]> => {
                flt = in_;
                return Promise.resolve([
                    { ...emptyGap(), id: "gap-0001" },
                    { ...emptyGap(), id: "gap-0003" },
                ]);
            },
        };

        // --- When ---
        await logStale(log, gst);

        // --- Then ---
        expect(serr).toBe("stale gaps (2): gap-0001, gap-0003\n");
        expect(flt).toEqual({ stale: true });
    });

    // go: Test_logStale_none
    it("logs nothing without stale gaps", async () => {
        // --- Given ---
        const gst = { list: (): Promise<Gap[]> => Promise.resolve([]) };

        // --- When ---
        await logStale(log, gst);

        // --- Then ---
        expect(serr).toBe("");
    });

    // go: Test_logStale_error
    it("logs a failed check", async () => {
        // --- Given ---
        const gst = {
            list: (): Promise<Gap[]> =>
                Promise.reject(new Error("disk on fire")),
        };

        // --- When ---
        await logStale(log, gst);

        // --- Then ---
        expect(serr).toBe("stale gap check failed: disk on fire\n");
    });
});

describe("reload", () => {
    // go: Test_reload
    it("reindexes and logs the document count", async () => {
        // --- Given ---
        const base = corpusDir();
        const eng = await openEngine([{ name: "shop", dir: base }]);
        writeMD(base, "paperback.md", "Couriers ship paperbacks.\n");

        // --- When ---
        await reload(log, () => performance.now(), eng);

        // --- Then ---
        expect(serr).toContain("reindexed 2 documents in ");
        expect(eng.listDocs()).toHaveLength(2);
    });

    // go: Test_reload_error_keeps_index
    it("keeps the previous index on failure", async () => {
        // --- Given ---
        const base = join(tempDir(), "corpus");
        writeMD(base, "a.md", "alpha\n");
        const eng = await openEngine([{ name: "shop", dir: base }]);
        fs.rmSync(base, { recursive: true, force: true });

        // --- When ---
        await reload(log, () => performance.now(), eng);

        // --- Then ---
        const want =
            "reindex failed, serving previous index: ingest source shop";
        expect(serr).toContain(want);
        expect(eng.listDocs()).toHaveLength(1);
    });

    // go: Test_reload_close_replaced_failure
    it("logs a failure to close the replaced index beside success", async () => {
        // --- Given ---
        const eng = {
            reload: (): Promise<void> =>
                Promise.reject(
                    new CloseReplacedError(new Error("disk on fire")),
                ),
            listDocs: () => [{ id: "shop/a.md" }, { id: "shop/b.md" }],
        };

        // --- When ---
        await reload(log, () => 0, eng);

        // --- Then ---
        const want =
            "reindexed 2 documents in 0s; " +
            "close replaced index: disk on fire\n";
        expect(serr).toBe(want);
    });
});

describe("sources", () => {
    // go: Test_watchPaths
    it("watchPaths splits directories and files, sorted", () => {
        // --- Given ---
        const cfg = newConfig({
            sources: new Map([
                ["zeta", { dir: "/z", file: "" }],
                ["alpha", { dir: "/a", file: "" }],
                ["notes", { dir: "", file: "/n.md" }],
            ]),
        });

        // --- When ---
        const [hDirs, hFiles] = watchPaths(cfg);

        // --- Then ---
        expect(hDirs).toEqual(["/a", "/z"]);
        expect(hFiles).toEqual(["/n.md"]);
    });

    // go: Test_NewEngine
    it("newEngine indexes the sources with the ranking", async () => {
        // --- Given ---
        const base = tempDir();
        writeMD(base, "a.md", "# A\n");
        writeMD(base, "init/b.md", "# B\n");
        const cfg = newConfig({
            sources: new Map([["kb", { dir: base, file: "" }]]),
            precedence: ["kb"],
            initiatives: "kb/init",
        });

        // --- When ---
        const have = await newEngine(nfs, cfg);

        // --- Then ---
        closers.push(() => have.close());
        const want = [
            { id: "kb/a.md", path: "kb/a.md", rank: 1, title: "a" },
            { id: "kb/init/b.md", path: "kb/init/b.md", rank: 0, title: "b" },
        ];
        expect(have.listDocs()).toEqual(want);
    });

    // go: Test_engineSources_sorted_by_name
    it("engineSources maps the sources sorted by name", () => {
        // --- Given ---
        const cfg = newConfig({
            sources: new Map([
                ["zeta", { dir: "/z", file: "" }],
                ["alpha", { dir: "", file: "/a.md" }],
            ]),
        });

        // --- When ---
        const have = engineSources(cfg);

        // --- Then ---
        const want = [
            { name: "alpha", file: "/a.md" },
            { name: "zeta", dir: "/z" },
        ];
        expect(have).toEqual(want);
    });

    // go: Test_ranking
    it("newEngine ranks by precedence and exempts initiatives", async () => {
        // --- Given --- Go's ranking(cfg) is inlined into newEngine, so the
        // mapping shows in the ranks of the indexed documents.
        const kb = tempDir();
        writeMD(kb, "a.md", "# A\n");
        const doc = tempDir();
        writeMD(doc, "catalog/d.md", "# D\n");
        writeMD(doc, "other.md", "# O\n");
        const ini = tempDir();
        writeMD(ini, "srd.md", "# S\n");
        const cfg = newConfig({
            sources: new Map([
                ["kb", { dir: kb, file: "" }],
                ["doc", { dir: doc, file: "" }],
                ["initiatives", { dir: ini, file: "" }],
            ]),
            precedence: ["kb", "doc/catalog"],
            initiatives: "initiatives",
        });

        // --- When ---
        const have = await newEngine(nfs, cfg);

        // --- Then ---
        closers.push(() => have.close());
        const ranks = Object.fromEntries(
            have.listDocs().map((d) => [d.path, d.rank]),
        );
        const want = {
            "kb/a.md": 1,
            "doc/catalog/d.md": 2,
            "doc/other.md": 3,
            "initiatives/srd.md": 0,
        };
        expect(ranks).toEqual(want);
    });
});
