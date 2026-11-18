// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// A pull keeps the reply drafts a note carries: each goes back right after its
// thread, and one whose thread is gone keeps its place with a mark. Driven
// end-to-end with StubHttpClient + MemFS.

import { describe, expect, it } from "vitest";
import { buildConfig } from "../../src/config/config.ts";
import { ConfluenceClient } from "../../src/confluence/client.ts";
import { obsidianFlavor } from "../../src/flavor/flavor.ts";
import { NoopReporter } from "../../src/ports/progress.ts";
import { draftBlock, upsertDraft } from "../../src/sync/drafts.ts";
import { buildLinkIndex } from "../../src/sync/linkindex.ts";
import { Puller } from "../../src/sync/pull.ts";
import { StubHttpClient } from "../support/http-stub.ts";
import { MemFS } from "../support/memfs.ts";

const H = "https://ex.atlassian.net";
const V2 = `${H}/wiki/api/v2`;
const ADF = "?body-format=atlas_doc_format";
const NOTE = "/vault/notes/page.md";

const config = buildConfig(
    {
        pages: { "notes/page.md": "/wiki/spaces/X/pages/123/Title" },
        comments: true,
    },
    { site: "ex", account: "a@ex.com", token: "secret", syncRoot: "/vault" },
);

/** page is page 123 at `version`: `intro`, then "hello world" commented M1. */
function page(version: number, intro: string): string {
    const adf = {
        version: 1,
        type: "doc",
        content: [
            { type: "paragraph", content: [{ type: "text", text: intro }] },
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
                ],
            },
        ],
    };
    return JSON.stringify({
        id: "123",
        title: "Title",
        spaceId: "9",
        parentId: "7",
        version: { number: version },
        body: { atlas_doc_format: { value: JSON.stringify(adf) } },
    });
}

/** site stubs page 123 at `version` with thread C1 in `resolution`. */
function site(
    version: number,
    intro: string,
    resolution: "open" | "resolved",
): StubHttpClient {
    const empty = { body: JSON.stringify({ results: [], _links: {} }) };
    return new StubHttpClient()
        .on("GET", `${V2}/pages/123${ADF}`, { body: page(version, intro) })
        .on("GET", `${V2}/pages/123/inline-comments${ADF}`, {
            body: JSON.stringify({
                results: [
                    {
                        id: "C1",
                        resolutionStatus: resolution,
                        properties: { inlineMarkerRef: "M1" },
                        version: {
                            authorId: "jsmith",
                            createdAt: "",
                            number: 1,
                        },
                        body: {
                            atlas_doc_format: {
                                value: JSON.stringify({
                                    type: "doc",
                                    content: [
                                        {
                                            type: "paragraph",
                                            content: [
                                                { type: "text", text: "Why?" },
                                            ],
                                        },
                                    ],
                                }),
                            },
                        },
                    },
                ],
                _links: {},
            }),
        })
        .on("GET", `${V2}/inline-comments/C1/children${ADF}`, empty)
        .on("GET", `${V2}/pages/123/footer-comments${ADF}`, empty);
}

/** pull runs one pull of page 123 against `stub` over `fs`. */
async function pull(stub: StubHttpClient, fs: MemFS): Promise<void> {
    const client = new ConfluenceClient(stub, {
        host: config.host,
        account: config.account,
        token: config.token,
    });
    const out = await new Puller({
        client,
        fs,
        config,
        reporter: new NoopReporter(),
        cacheDir: "/data/cache",
        assetsDir: "/vault/_docket-media",
        links: buildLinkIndex(config.syncRoot, config.pages, []),
        flavor: obsidianFlavor,
    }).pullPages();
    expect(out.errors).toEqual([]);
}

/** pulledWithDraft pulls v3, then adds draft `text` under thread C1. */
async function pulledWithDraft(text: string): Promise<MemFS> {
    const fs = new MemFS();
    await pull(site(3, "intro", "open"), fs);
    await fs.write(NOTE, upsertDraft(await fs.readText(NOTE), "C1", text));
    return fs;
}

/** after returns the text of `note` after the first `marker`. */
function after(note: string, marker: string): string {
    return note.slice(note.indexOf(marker));
}

describe("pull with reply drafts", () => {
    it("keeps a draft under its thread when nothing else changed", async () => {
        const fs = await pulledWithDraft("Only T2.");
        const before = await fs.readText(NOTE);

        await pull(site(3, "intro", "open"), fs);

        expect(await fs.readText(NOTE)).toBe(before);
    });

    it("keeps a draft under its thread when the page changed", async () => {
        const fs = await pulledWithDraft("Only T2.");

        await pull(site(4, "intro v4", "open"), fs);

        const note = await fs.readText(NOTE);
        expect(note).toContain("intro v4");
        expect(after(note, "> [!comment] id:C1")).toMatch(
            /^> \[!comment\] id:C1[^\n]*\n> Why\?\n\n> \[!reply\] draft\n> Only T2\.\n$/,
        );
    });

    it("keeps a draft under its thread next to a local edit", async () => {
        const fs = await pulledWithDraft("Only T2.");
        const edited = (await fs.readText(NOTE)).replace("intro", "intro mine");
        await fs.write(NOTE, edited);

        await pull(site(4, "intro", "open"), fs);

        const note = await fs.readText(NOTE);
        expect(note).toContain("intro mine");
        expect(note).toContain(`\n\n${draftBlock("Only T2.")}\n`);
    });

    it("keeps a draft whose thread was resolved, marked", async () => {
        const fs = await pulledWithDraft("Only T2.");

        await pull(site(3, "intro", "resolved"), fs);

        const note = await fs.readText(NOTE);
        expect(note).not.toContain("[!comment]");
        expect(note).toContain(
            draftBlock("Only T2.", "thread id:C1 is resolved on Confluence"),
        );
    });
});
