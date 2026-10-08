// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { buildConfig, ConfluenceClient, NoopReporter } from "@docket/core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { QueueHttpClient } from "../../../core/test/support/http-queue.ts";
import { MemFS } from "../../../core/test/support/memfs.ts";
import type { PluginRuntime } from "../../src/runtime.ts";
import { runtimeDirs } from "../../src/runtime-dirs.ts";
import {
    applyStatus,
    markNever,
    preflight,
    pullNotes,
    pullVault,
    pushSelected,
    toDest,
    vaultStatus,
} from "../../src/ui/operations.ts";

/** versionsJson is one bulk fetchPageVersions response for the given id/version. */
function versionsJson(id: string, version: number): string {
    return JSON.stringify({
        results: [{ id, version: { number: version } }],
        _links: {},
    });
}
/** PAGE_SRC is a pullable single-page source for wiki/A.md. */
const PAGE_SRC = "/wiki/spaces/X/pages/1";

/** pageJson is one page-fetch response carrying a one-paragraph body. */
function pageJson(id: string, version: number): string {
    const adf = {
        version: 1,
        type: "doc",
        content: [
            { type: "paragraph", content: [{ type: "text", text: "hello" }] },
        ],
    };
    return JSON.stringify({
        id,
        title: "A",
        spaceId: "9",
        version: { number: version },
        body: { atlas_doc_format: { value: JSON.stringify(adf) } },
    });
}
function note(id: string, v: number): string {
    return `---\ntitle: P\ndocket_page_id: "${id}"\ndocket_page_version: ${v}\ndocket_mode: pull\n---\nbody\n`;
}

async function runtime(
    http: QueueHttpClient,
    fs: MemFS,
    src = "/wiki/1",
): Promise<PluginRuntime> {
    const config = buildConfig(
        { pages: { "wiki/A.md": src }, folders: {}, spaces: {} },
        { site: "ex", account: "a@b.c", token: "t", syncRoot: "." },
    );
    return {
        client: new ConfluenceClient(http, {
            host: "https://ex.atlassian.net",
            account: "a@b.c",
            token: "t",
        }),
        fs,
        yaml: { parse },
        config,
        dirs: runtimeDirs(config),
        mintLocalId: () => "id",
        withLock: (_command, fn) => fn(),
    };
}

describe("operations", () => {
    it("toDest cleans an active-file path", () => {
        expect(toDest("./wiki/A.md")).toBe("wiki/A.md");
    });

    it("preflight over one note classifies against remote", async () => {
        const fs = new MemFS();
        await fs.write("wiki/A.md", note("1", 3));
        const http = new QueueHttpClient().rsp(200, versionsJson("1", 9));
        const rt = await runtime(http, fs);
        // The note matches its cached base render: no local change.
        await fs.write(`${rt.dirs.cacheDir}/wiki/A.v3.md`, note("1", 3));
        const out = await preflight(rt, {
            kind: "notes",
            dests: ["wiki/A.md"],
        });
        expect(out).toHaveLength(1);
        expect(out[0]?.cls).toBe("remote-moved");
        expect(out[0]?.remoteVersion).toBe(9);
    });

    it("preflight over one note rejects a non-managed note", async () => {
        const fs = new MemFS();
        const rt = await runtime(new QueueHttpClient(), fs);
        await expect(
            preflight(rt, { kind: "notes", dests: ["not/managed.md"] }),
        ).rejects.toThrow("not a managed page: not/managed.md");
    });

    it("preflight over notes keeps only the managed ones", async () => {
        const fs = new MemFS();
        await fs.write("wiki/A.md", note("1", 3));
        const http = new QueueHttpClient().rsp(200, versionsJson("1", 3));
        const rt = await runtime(http, fs);
        await fs.write(`${rt.dirs.cacheDir}/wiki/A.v3.md`, note("1", 3));

        const have = await preflight(rt, {
            kind: "notes",
            dests: ["wiki/A.md", "not/managed.md"],
        });

        expect(have.map((e) => e.dest)).toEqual(["wiki/A.md"]);
    });

    it("preflight over a folder keeps the managed notes under it", async () => {
        const fs = new MemFS();
        await fs.write("wiki/A.md", note("1", 3));
        await fs.write("other/B.md", note("2", 1));
        const http = new QueueHttpClient().rsp(200, versionsJson("1", 3));
        const rt = await runtime(http, fs);
        await fs.write(`${rt.dirs.cacheDir}/wiki/A.v3.md`, note("1", 3));

        const have = await preflight(rt, { kind: "folder", path: "wiki" });

        expect(have.map((e) => e.dest)).toEqual(["wiki/A.md"]);
    });

    it("pullNotes collects a failing note and goes on", async () => {
        const fs = new MemFS();
        const rt = await runtime(new QueueHttpClient(), fs);

        const have = await pullNotes(rt, new NoopReporter(), [
            "not/managed.md",
        ]);

        expect(have.tally.updated).toBe(0);
        expect(have.errors).toHaveLength(1);
        expect(have.errors[0]).toMatch(/^not\/managed\.md: /);
    });

    it("markNever writes the ignore-push marker into each note", async () => {
        const fs = new MemFS();
        await fs.write("wiki/N.md", "---\ntitle: N\n---\nx\n");
        const rt = await runtime(new QueueHttpClient(), fs);

        await markNever(rt, ["wiki/N.md"]);

        expect(await fs.readText("wiki/N.md")).toContain(
            "docket_mode: ignore-push",
        );
    });

    it("vaultStatus reports the vault and fails when Confluence is down", async () => {
        const fs = new MemFS();
        await fs.write("wiki/A.md", note("1", 3));
        const up = await runtime(
            new QueueHttpClient().rsp(200, versionsJson("1", 9)),
            fs,
        );
        await fs.write(`${up.dirs.cacheDir}/wiki/A.v3.md`, note("1", 3));

        const have = await vaultStatus(up);

        expect(have.report.pull.map((e) => e.name)).toEqual(["wiki/A.md"]);
        expect([...have.bodies.keys()]).toEqual(["wiki/A.md"]);
        const down = await runtime(new QueueHttpClient().rsp(503), fs);
        await expect(vaultStatus(down)).rejects.toThrow("503");
    });

    it("applyStatus runs the chosen row actions", async () => {
        const fs = new MemFS();
        await fs.write("wiki/N.md", "---\ntitle: N\n---\nx\n");
        const rt = await runtime(new QueueHttpClient(), fs);

        const have = await applyStatus(rt, new NoopReporter(), [
            {
                row: {
                    dest: "wiki/N.md",
                    name: "wiki/N.md",
                    kind: "new",
                    detail: "",
                },
                action: "never",
            },
        ]);

        expect(have.map((r) => r.ok)).toEqual([true]);
        expect(await fs.readText("wiki/N.md")).toContain(
            "docket_mode: ignore-push",
        );
    });

    it("pullNotes pulls each managed note and tallies it", async () => {
        const fs = new MemFS();
        const http = new QueueHttpClient().rsp(200, pageJson("1", 4));
        const rt = await runtime(http, fs, PAGE_SRC);

        const have = await pullNotes(rt, new NoopReporter(), ["wiki/A.md"]);

        expect(have).toEqual({
            tally: {
                added: 1,
                updated: 0,
                unchanged: 0,
                conflict: 0,
                deleted: 0,
            },
            errors: [],
        });
        expect(await fs.readText("wiki/A.md")).toContain("hello");
    });

    it("pullVault pulls every configured page", async () => {
        const fs = new MemFS();
        const http = new QueueHttpClient()
            .rsp(200, versionsJson("1", 4))
            .rsp(200, pageJson("1", 4));
        const rt = await runtime(http, fs, PAGE_SRC);

        const have = await pullVault(rt, new NoopReporter());

        expect(have.errors).toEqual([]);
        expect(have.stats.added).toBe(1);
        expect(await fs.readText("wiki/A.md")).toContain("hello");
    });

    it("preflight over the vault or its root folder takes every note", async () => {
        const fs = new MemFS();
        await fs.write("wiki/A.md", note("1", 3));
        const rt = await runtime(
            new QueueHttpClient()
                .rsp(200, versionsJson("1", 3))
                .rsp(200, versionsJson("1", 3)),
            fs,
        );
        await fs.write(`${rt.dirs.cacheDir}/wiki/A.v3.md`, note("1", 3));

        const vault = await preflight(rt, { kind: "vault" });
        const root = await preflight(rt, { kind: "folder", path: "." });

        expect(vault.map((e) => e.dest)).toEqual(["wiki/A.md"]);
        expect(root.map((e) => e.dest)).toEqual(["wiki/A.md"]);
    });

    it("preflight over notes none of which is managed fails", async () => {
        const rt = await runtime(new QueueHttpClient(), new MemFS());

        const have = preflight(rt, { kind: "notes", dests: ["a.md", "b.md"] });

        await expect(have).rejects.toThrow(
            "none of the selected notes is a managed page",
        );
    });

    it("pushSelected pushes nothing for no notes", async () => {
        const rt = await runtime(new QueueHttpClient(), new MemFS());

        const have = await pushSelected(rt, new NoopReporter(), []);

        expect(have).toEqual({
            log: "",
            pushed: 0,
            unchanged: 0,
            total: 0,
            errors: [],
            warnings: [],
        });
    });
});
