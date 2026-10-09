// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The client calls publish builds on: reading and clearing a page's or folder's
// direct restrictions (v1 restriction endpoint) and fetching a node's parent
// (v2 page/folder endpoint). Driven with the sequential QueueHttpClient.

import { describe, expect, it } from "vitest";
import { ConfluenceClient } from "../../src/confluence/client.ts";
import { QueueHttpClient } from "../support/http-queue.ts";

const H = "https://ex.atlassian.net";
const client = (q: QueueHttpClient): ConfluenceClient =>
    new ConfluenceClient(q, { host: H, account: "a@ex.com", token: "secret" });

/** restrictionsBody renders a v1 restriction response from operation → names. */
function restrictionsBody(
    ops: Record<string, { users?: string[]; groups?: string[] }>,
): string {
    return JSON.stringify({
        results: Object.entries(ops).map(([operation, by]) => ({
            operation,
            restrictions: {
                user: {
                    results: (by.users ?? []).map((accountId) => ({
                        type: "known",
                        accountId,
                    })),
                },
                group: {
                    results: (by.groups ?? []).map((name) => ({
                        type: "group",
                        name,
                    })),
                },
            },
        })),
    });
}

describe("ConfluenceClient.fetchRestrictions", () => {
    it("returns each restricted operation's users and groups", async () => {
        const q = new QueueHttpClient().rsp(
            200,
            restrictionsBody({
                read: { users: ["acc-1"] },
                update: { users: ["acc-1", "acc-2"], groups: ["devs"] },
            }),
        );

        const have = await client(q).fetchRestrictions("555");

        expect(have).toEqual([
            { operation: "read", users: ["acc-1"], groups: [] },
            {
                operation: "update",
                users: ["acc-1", "acc-2"],
                groups: ["devs"],
            },
        ]);
        expect(q.requests[0]?.method).toBe("GET");
        expect(q.requests[0]?.url).toBe(
            `${H}/wiki/rest/api/content/555/restriction` +
                "?expand=restrictions.user,restrictions.group",
        );
    });

    it("omits operations open to everyone", async () => {
        const q = new QueueHttpClient().rsp(
            200,
            restrictionsBody({ read: {}, update: {} }),
        );

        const have = await client(q).fetchRestrictions("555");

        expect(have).toEqual([]);
    });

    it("falls back to a group's id when it has no name", async () => {
        const body = JSON.stringify({
            results: [
                {
                    operation: "read",
                    restrictions: { group: { results: [{ id: "g-1" }] } },
                },
            ],
        });
        const q = new QueueHttpClient().rsp(200, body);

        const have = await client(q).fetchRestrictions("555");

        expect(have).toEqual([
            { operation: "read", users: [], groups: ["g-1"] },
        ]);
    });

    it("errors on a non-2xx status", async () => {
        const q = new QueueHttpClient().rsp(403);
        await expect(client(q).fetchRestrictions("555")).rejects.toThrow(
            "restrictions of 555: HTTP 403",
        );
    });

    it("errors on an undecodable body", async () => {
        const q = new QueueHttpClient().rsp(200, "not json");
        await expect(client(q).fetchRestrictions("555")).rejects.toThrow(
            "decoding restrictions of 555",
        );
    });
});

describe("ConfluenceClient.clearRestrictions", () => {
    it("deletes every restriction on the content", async () => {
        const q = new QueueHttpClient().rsp(200, "{}");

        await client(q).clearRestrictions("555");

        expect(q.requests[0]?.method).toBe("DELETE");
        expect(q.requests[0]?.url).toBe(
            `${H}/wiki/rest/api/content/555/restriction`,
        );
    });

    it("errors on a non-2xx status", async () => {
        const q = new QueueHttpClient().rsp(403);
        await expect(client(q).clearRestrictions("555")).rejects.toThrow(
            "clear restrictions of 555: HTTP 403",
        );
    });
});

describe("ConfluenceClient.fetchNode", () => {
    it("returns a page's title and parent", async () => {
        const q = new QueueHttpClient().rsp(
            200,
            '{"id":"555","title":"Page","parentId":"77","parentType":"folder"}',
        );

        const have = await client(q).fetchNode("page", "555");

        expect(have).toEqual({
            id: "555",
            title: "Page",
            parentId: "77",
            parentType: "folder",
        });
        expect(q.requests[0]?.url).toBe(`${H}/wiki/api/v2/pages/555`);
    });

    it("reads a folder from the folder endpoint", async () => {
        const q = new QueueHttpClient().rsp(200, '{"id":"77","title":"F"}');

        const have = await client(q).fetchNode("folder", "77");

        expect(have).toEqual({
            id: "77",
            title: "F",
            parentId: "",
            parentType: "",
        });
        expect(q.requests[0]?.url).toBe(`${H}/wiki/api/v2/folders/77`);
    });

    it("errors on a non-2xx status", async () => {
        const q = new QueueHttpClient().rsp(404);
        await expect(client(q).fetchNode("folder", "77")).rejects.toThrow(
            "folder 77: HTTP 404",
        );
    });

    it("errors on an undecodable body", async () => {
        const q = new QueueHttpClient().rsp(200, "nope");
        await expect(client(q).fetchNode("page", "555")).rejects.toThrow(
            "decoding page 555",
        );
    });
});
