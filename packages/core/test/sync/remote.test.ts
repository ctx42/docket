// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildConfig, type Config } from "../../src/config/config.ts";
import { ConfluenceClient } from "../../src/confluence/client.ts";
import { obsidianFlavor } from "../../src/flavor/flavor.ts";
import { NoopReporter } from "../../src/ports/progress.ts";
import { buildLinkIndex } from "../../src/sync/linkindex.ts";
import { Puller } from "../../src/sync/pull.ts";
import {
    type PreflightClass,
    type PreflightEntry,
    splitFrontmatter,
} from "../../src/sync/push.ts";
import {
    type RemoteDeps,
    remoteBodies,
    remoteBody,
} from "../../src/sync/remote.ts";
import type { StatusReport } from "../../src/sync/status.ts";
import { StubHttpClient } from "../support/http-stub.ts";
import { MemFS } from "../support/memfs.ts";

const V2 = "https://ex.atlassian.net/wiki/api/v2";
const ADF_Q = "?body-format=atlas_doc_format";
const CACHE = "/data/cache";
const ASSETS = "/vault/_docket-media";

/** LogFS is a MemFS recording every path written. */
class LogFS extends MemFS {
    readonly writes: string[] = [];

    override write(path: string, data: Uint8Array | string): Promise<void> {
        this.writes.push(path);
        return super.write(path, data);
    }
}

function configOf(comments: boolean): Config {
    return buildConfig(
        {
            pages: {
                "notes/page.md": "/wiki/spaces/X/pages/123/Title",
                "notes/other.md": "/wiki/spaces/X/pages/456/Other",
            },
            comments,
        },
        {
            site: "ex",
            account: "a@ex.com",
            token: "secret",
            syncRoot: "/vault",
        },
    );
}

function clientOf(config: Config, stub: StubHttpClient): ConfluenceClient {
    return new ConfluenceClient(stub, {
        host: config.host,
        account: config.account,
        token: config.token,
    });
}

function depsOf(config: Config, stub: StubHttpClient, fs: MemFS): RemoteDeps {
    return {
        client: clientOf(config, stub),
        fs,
        yaml: { parse },
        config,
        cacheDir: CACHE,
        assetsDir: ASSETS,
        flavor: obsidianFlavor,
        links: buildLinkIndex(config.syncRoot, config.pages, []),
    };
}

/**
 * richADF carries what a careless render gets wrong: an image not yet on disk,
 * an inline comment anchor, and a link to another synced page.
 */
const richADF = {
    version: 1,
    type: "doc",
    content: [
        {
            type: "paragraph",
            content: [
                { type: "text", text: "hello " },
                {
                    type: "text",
                    text: "world",
                    marks: [
                        {
                            type: "annotation",
                            attrs: {
                                id: "M1",
                                annotationType: "inlineComment",
                            },
                        },
                    ],
                },
                { type: "text", text: " see " },
                {
                    type: "text",
                    text: "Other",
                    marks: [
                        {
                            type: "link",
                            attrs: {
                                href: "https://ex.atlassian.net/wiki/spaces/X/pages/456/Other",
                            },
                        },
                    ],
                },
            ],
        },
        {
            type: "mediaSingle",
            attrs: { layout: "center" },
            content: [
                {
                    type: "media",
                    attrs: {
                        type: "file",
                        id: "F1",
                        localId: "L1",
                        alt: "pic.png",
                    },
                },
            ],
        },
    ],
};

function pageBody(id: string, version: number, adf: unknown): string {
    return JSON.stringify({
        id,
        title: "Title",
        spaceId: "9",
        parentId: "7",
        version: { number: version },
        body: { atlas_doc_format: { value: JSON.stringify(adf) } },
    });
}

const plainADF = {
    version: 1,
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }],
};

/** stubOf serves page 123 at v3 (current and by version), and page 456. */
function stubOf(): StubHttpClient {
    const page = { body: pageBody("123", 3, richADF) };
    const comment = {
        type: "doc",
        content: [
            {
                type: "paragraph",
                content: [{ type: "text", text: "Where from?" }],
            },
        ],
    };
    return new StubHttpClient()
        .on("GET", `${V2}/pages/123${ADF_Q}`, page)
        .on("GET", `${V2}/pages/123${ADF_Q}&version=3`, page)
        .on("GET", `${V2}/pages/456${ADF_Q}`, {
            body: pageBody("456", 1, plainADF),
        })
        .on("GET", `${V2}/pages/123/attachments`, {
            body: JSON.stringify({
                results: [
                    {
                        fileId: "F1",
                        title: "pic.png",
                        mediaType: "image/png",
                        downloadLink: "/download/x",
                    },
                ],
                _links: {},
            }),
        })
        .on("GET", "https://ex.atlassian.net/wiki/download/x", {
            body: "PNG",
        })
        .on("GET", `${V2}/pages/123/inline-comments${ADF_Q}`, {
            body: JSON.stringify({
                results: [
                    {
                        id: "C1",
                        resolutionStatus: "open",
                        properties: { inlineMarkerRef: "M1" },
                        version: {
                            authorId: "jsmith",
                            createdAt: "2026-07-20T10:00:00Z",
                        },
                        body: {
                            atlas_doc_format: {
                                value: JSON.stringify(comment),
                            },
                        },
                    },
                ],
                _links: {},
            }),
        })
        .on("GET", `${V2}/inline-comments/C1/children${ADF_Q}`, {
            body: JSON.stringify({ results: [], _links: {} }),
        })
        .on("GET", `${V2}/pages/123/footer-comments${ADF_Q}`, {
            body: JSON.stringify({ results: [], _links: {} }),
        });
}

function entryOf(
    cls: PreflightClass,
    name: string,
    pageId: string,
    localBase: number,
    remoteVersion: number,
): PreflightEntry {
    return {
        dest: `/vault/${name}`,
        name,
        pageId,
        localBase,
        remoteVersion,
        cls,
        reason: "",
        resolves: [],
    };
}

/** pulledBody pulls the config's pages and returns page 123's note body. */
async function pulledBody(config: Config): Promise<string> {
    const fs = new MemFS();
    const stub = stubOf();
    const puller = new Puller({
        client: clientOf(config, stub),
        fs,
        config,
        reporter: new NoopReporter(),
        cacheDir: CACHE,
        assetsDir: ASSETS,
        links: buildLinkIndex(config.syncRoot, config.pages, []),
        flavor: obsidianFlavor,
    });
    const out = await puller.pullPages();
    expect(out.errors).toEqual([]);
    return splitFrontmatter(await fs.readText("/vault/notes/page.md")).body;
}

describe("remoteBody", () => {
    for (const comments of [true, false]) {
        it(`renders the body a pull writes (comments ${comments ? "on" : "off"})`, async () => {
            const config = configOf(comments);
            const fs = new LogFS();
            const e = entryOf("remote-moved", "notes/page.md", "123", 2, 3);

            const have = await remoteBody(depsOf(config, stubOf(), fs), e);

            const want = await pulledBody(config);
            expect(have).toBe(want);
            expect(have).toContain("![[");
            expect(have).toContain("other.md");
            if (comments) expect(have).toContain("[!comment]");
            else expect(have).not.toContain("[!comment]");
            expect(fs.writes).toEqual([]);
        });
    }

    it("fetches the version the status check reported", async () => {
        const config = configOf(false);
        const stub = stubOf();
        const e = entryOf("diverged", "notes/page.md", "123", 2, 3);

        await remoteBody(depsOf(config, stub, new MemFS()), e);

        const urls = stub.requests.map((r) => r.url);
        expect(urls).toContain(`${V2}/pages/123${ADF_Q}&version=3`);
        expect(urls).not.toContain(`${V2}/pages/123${ADF_Q}`);
    });

    it("reads an outgoing note's cached base render without fetching", async () => {
        const config = configOf(false);
        const fs = new MemFS();
        await fs.write(
            `${CACHE}/notes/page.v2.md`,
            "---\ntitle: T\n---\n\ncached body\n",
        );
        const stub = new StubHttpClient();
        const e = entryOf("modified", "notes/page.md", "123", 2, 2);

        const have = await remoteBody(depsOf(config, stub, fs), e);

        expect(have).toBe("cached body");
        expect(stub.requests).toEqual([]);
    });

    it("throws when an outgoing note's base render is not cached", async () => {
        const config = configOf(false);
        const e = entryOf("modified", "notes/page.md", "123", 2, 2);

        const have = remoteBody(
            depsOf(config, new StubHttpClient(), new MemFS()),
            e,
        );

        await expect(have).rejects.toThrow("base render v2 is not cached");
    });

    it("throws when the comments cannot be fetched", async () => {
        const config = configOf(true);
        const stub = stubOf().on(
            "GET",
            `${V2}/pages/123/footer-comments${ADF_Q}`,
            { status: 500 },
        );
        const e = entryOf("remote-moved", "notes/page.md", "123", 2, 3);

        const have = remoteBody(depsOf(config, stub, new MemFS()), e);

        await expect(have).rejects.toThrow();
    });
});

describe("remoteBodies", () => {
    it("renders outgoing, incoming, and diverged notes only", async () => {
        const config = configOf(false);
        const fs = new LogFS();
        await fs.write(
            `${CACHE}/notes/out.v4.md`,
            "---\ntitle: T\n---\n\nout body\n",
        );
        const stub = stubOf();
        const report: StatusReport = {
            push: [
                entryOf("modified", "notes/out.md", "777", 4, 4),
                entryOf("new", "notes/new.md", "", 0, 0),
                entryOf("refused", "notes/bad.md", "888", 1, 1),
            ],
            pull: [entryOf("remote-moved", "notes/page.md", "123", 2, 3)],
            diverged: [entryOf("diverged", "notes/both.md", "456", 1, 2)],
            warnings: [entryOf("skip", "notes/skip.md", "999", 1, 0)],
            ignored: [],
        };
        fs.writes.length = 0;

        const have = await remoteBodies(depsOf(config, stub, fs), report);

        expect([...have.keys()]).toEqual([
            "/vault/notes/out.md",
            "/vault/notes/page.md",
            "/vault/notes/both.md",
        ]);
        expect(have.get("/vault/notes/out.md")).toEqual({ body: "out body" });
        expect(have.get("/vault/notes/page.md")).toHaveProperty("body");
        // Page 456 serves no v2: that note gets the reason, the rest a body.
        expect(have.get("/vault/notes/both.md")).toEqual({
            error: "page 456: HTTP 404",
        });
        const pages = stub.requests
            .map((r) => r.url)
            .filter((u) => u.includes(ADF_Q) && !u.includes("comments"));
        expect(pages).toEqual([
            `${V2}/pages/123${ADF_Q}&version=3`,
            `${V2}/pages/456${ADF_Q}&version=2`,
        ]);
        expect(fs.writes).toEqual([]);
    });
});
