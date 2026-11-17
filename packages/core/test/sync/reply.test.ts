// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Replying to a Confluence comment from a note: the reply's Markdown becomes
// ADF and is posted under the live thread, of the thread's own kind. Driven
// through the ports with the route-keyed StubHttpClient + MemFS.

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildConfig } from "../../src/config/config.ts";
import { ConfluenceClient } from "../../src/confluence/client.ts";
import type { Yaml } from "../../src/ports/yaml.ts";
import { type ReplyDeps, replyToComment } from "../../src/sync/reply.ts";
import { StubHttpClient } from "../support/http-stub.ts";
import { MemFS } from "../support/memfs.ts";

const H = "https://ex.atlassian.net";
const V2 = `${H}/wiki/api/v2`;
const ADF = "?body-format=atlas_doc_format";
const yaml: Yaml = { parse: (t) => parseYaml(t) };
const DEST = "/vault/docs/page.md";
const NOTE = '---\ntitle: "Page"\ndocket_page_id: "555"\n---\n\nbody\n';

/** listing is a v2 comment listing of `ids`, with no next page. */
const listing = (ids: string[]): { body: string } => ({
    body: JSON.stringify({
        results: ids.map((id) => ({
            id,
            version: { authorId: "", createdAt: "", number: 1 },
            body: { atlas_doc_format: { value: '{"type":"doc"}' } },
        })),
        _links: {},
    }),
});

/**
 * page stubs page 555's comments: inline thread C1 with reply C2, and footer
 * thread F1. Every other thread has no replies.
 */
function page(): StubHttpClient {
    return new StubHttpClient()
        .on("GET", `${V2}/pages/555/inline-comments${ADF}`, listing(["C1"]))
        .on("GET", `${V2}/inline-comments/C1/children${ADF}`, listing(["C2"]))
        .on("GET", `${V2}/inline-comments/C2/children${ADF}`, listing([]))
        .on("GET", `${V2}/pages/555/footer-comments${ADF}`, listing(["F1"]))
        .on("GET", `${V2}/footer-comments/F1/children${ADF}`, listing([]))
        .on("POST", `${V2}/inline-comments`, { body: '{"id":"C9"}' })
        .on("POST", `${V2}/footer-comments`, { body: '{"id":"F9"}' });
}

/** deps builds the reply's ports over `http`, with `note` at DEST. */
async function deps(http: StubHttpClient, note = NOTE): Promise<ReplyDeps> {
    const fs = new MemFS();
    await fs.write(DEST, note);
    const config = buildConfig(
        {},
        {
            site: "ex",
            account: "a@ex.com",
            token: "secret",
            syncRoot: "/vault",
        },
    );
    const client = new ConfluenceClient(http, {
        host: H,
        account: "a@ex.com",
        token: "secret",
    });
    return { client, fs, yaml, config };
}

/** posts returns the bodies `http` received as POSTs, parsed, with their URLs. */
function posts(http: StubHttpClient): Array<{ url: string; body: unknown }> {
    return http.requests
        .filter((r) => r.method === "POST")
        .map((r) => ({ url: r.url, body: JSON.parse(String(r.body)) }));
}

describe("replyToComment", () => {
    it("posts the reply's Markdown as ADF under an inline thread", async () => {
        const http = page();

        const have = await replyToComment(
            await deps(http),
            DEST,
            "C1",
            "Only the **T2** loggers.\n\nSee the list.\n",
        );

        expect(have).toBe("C9");
        const sent = posts(http);
        expect(sent).toHaveLength(1);
        expect(sent[0]?.url).toBe(`${V2}/inline-comments`);
        const body = sent[0]?.body as {
            parentCommentId: string;
            body: { representation: string; value: string };
        };
        expect(body.parentCommentId).toBe("C1");
        expect(body.body.representation).toBe("atlas_doc_format");
        expect(JSON.parse(body.body.value)).toEqual({
            type: "doc",
            version: 1,
            content: [
                {
                    type: "paragraph",
                    content: [
                        { type: "text", text: "Only the " },
                        {
                            type: "text",
                            text: "T2",
                            marks: [{ type: "strong" }],
                        },
                        { type: "text", text: " loggers." },
                    ],
                },
                {
                    type: "paragraph",
                    content: [{ type: "text", text: "See the list." }],
                },
            ],
        });
    });

    it("posts under a footer thread to the footer endpoint", async () => {
        const http = page();

        const have = await replyToComment(await deps(http), DEST, "F1", "OK");

        expect(have).toBe("F9");
        expect(posts(http)[0]?.url).toBe(`${V2}/footer-comments`);
    });

    it("answers a reply's id with the kind of its thread", async () => {
        const http = page();

        await replyToComment(await deps(http), DEST, "C2", "OK");

        const sent = posts(http);
        expect(sent[0]?.url).toBe(`${V2}/inline-comments`);
        expect(sent[0]?.body).toMatchObject({ parentCommentId: "C2" });
    });

    it("refuses an empty reply before asking Confluence", async () => {
        const http = page();

        const have = replyToComment(await deps(http), DEST, "C1", " \n\t ");

        await expect(have).rejects.toThrow("the reply is empty");
        expect(http.requests).toHaveLength(0);
    });

    it("refuses a note that is not on Confluence", async () => {
        const http = page();
        const d = await deps(http, '---\ntitle: "Page"\n---\n\nbody\n');

        const have = replyToComment(d, DEST, "C1", "OK");

        await expect(have).rejects.toThrow(
            "docs/page.md: not on Confluence yet; push it first",
        );
        expect(http.requests).toHaveLength(0);
    });

    it("refuses a comment gone from Confluence", async () => {
        const http = page();

        const have = replyToComment(await deps(http), DEST, "C7", "OK");

        await expect(have).rejects.toThrow(
            "comment C7 is no longer on Confluence; pull the note",
        );
        expect(posts(http)).toHaveLength(0);
    });
});
