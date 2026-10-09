// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Publishing a created page: classifying restrictions against the author,
// planning which author-only page and ancestor folders to clear (refusing
// anyone else's restrictions, warning about an ancestor that still hides the
// page), and clearing them top-down with a re-check. Driven through the ports
// with the route-keyed StubHttpClient + MemFS.

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildConfig, type Config } from "../../src/config/config.ts";
import { ConfluenceClient } from "../../src/confluence/client.ts";
import type { Yaml } from "../../src/ports/yaml.ts";
import {
    type PublishDeps,
    planPublish,
    publish,
    restrictionKind,
} from "../../src/sync/publish.ts";
import { StubHttpClient } from "../support/http-stub.ts";
import { MemFS } from "../support/memfs.ts";

const H = "https://ex.atlassian.net";
const yaml: Yaml = { parse: (t) => parseYaml(t) };
const DEST = "/vault/docs/page.md";
const ME = "me";

const config = (): Config =>
    buildConfig(
        {},
        {
            site: "ex",
            account: "a@ex.com",
            token: "secret",
            syncRoot: "/vault",
        },
    );

/** Restrictions is a node's restricted operations → users (and groups). */
type Restrictions = Record<string, { users?: string[]; groups?: string[] }>;

/** AUTHOR is the restriction a create sets: read and update for the author. */
const AUTHOR: Restrictions = { read: { users: [ME] }, update: { users: [ME] } };

/** Node is one page or folder in the fake content tree. */
interface Node {
    kind: "page" | "folder";
    title: string;
    parentId?: string;
    parentType?: string;
    restrictions?: Restrictions;
}

/** restrictionURL is the restriction read a node's classification issues. */
const restrictionURL = (id: string): string =>
    `${H}/wiki/rest/api/content/${id}/restriction` +
    "?expand=restrictions.user,restrictions.group";

/** restrictionsBody renders a v1 restriction response. */
function restrictionsBody(rs: Restrictions): string {
    return JSON.stringify({
        results: Object.entries(rs).map(([operation, by]) => ({
            operation,
            restrictions: {
                user: {
                    results: (by.users ?? []).map((accountId) => ({
                        accountId,
                    })),
                },
                group: {
                    results: (by.groups ?? []).map((name) => ({ name })),
                },
            },
        })),
    });
}

/** restrict (re)registers the restriction response of node `id`. */
function restrict(http: StubHttpClient, id: string, rs: Restrictions): void {
    http.on("GET", restrictionURL(id), { body: restrictionsBody(rs) });
}

/** tree registers the current user and every node's metadata + restrictions. */
function tree(nodes: Record<string, Node>): StubHttpClient {
    const http = new StubHttpClient().on(
        "GET",
        `${H}/wiki/rest/api/user/current`,
        { body: `{"accountId":"${ME}"}` },
    );
    for (const [id, n] of Object.entries(nodes)) {
        const base = n.kind === "page" ? "pages" : "folders";
        http.on("GET", `${H}/wiki/api/v2/${base}/${id}`, {
            body: JSON.stringify({
                id,
                title: n.title,
                parentId: n.parentId ?? "",
                parentType: n.parentType ?? "",
            }),
        });
        restrict(http, id, n.restrictions ?? {});
        http.on("DELETE", `${H}/wiki/rest/api/content/${id}/restriction`, {
            body: "{}",
        });
    }
    return http;
}

/** depsFor builds the publish deps over `http` with the note at DEST. */
async function depsFor(
    http: StubHttpClient,
    note = '---\ntitle: "Page"\ndocket_page_id: "555"\n---\n\nbody\n',
): Promise<PublishDeps> {
    const fs = new MemFS();
    await fs.write(DEST, note);
    return {
        client: new ConfluenceClient(http, {
            host: H,
            account: "a@ex.com",
            token: "secret",
        }),
        fs,
        yaml,
        config: config(),
    };
}

/** cleared lists the ids whose restrictions a run deleted, in order. */
function cleared(http: StubHttpClient): string[] {
    return http.requests
        .filter((r) => r.method === "DELETE")
        .map((r) => /content\/(\w+)\/restriction/.exec(r.url)?.[1] ?? "");
}

describe("restrictionKind", () => {
    it("classifies no restrictions as none", () => {
        expect(restrictionKind([], ME)).toBe("none");
    });

    it("classifies author-only restrictions as author", () => {
        const rs = [
            { operation: "read", users: [ME], groups: [] },
            { operation: "update", users: [ME], groups: [] },
        ];
        expect(restrictionKind(rs, ME)).toBe("author");
    });

    it("classifies another user as custom", () => {
        const rs = [{ operation: "read", users: [ME, "other"], groups: [] }];
        expect(restrictionKind(rs, ME)).toBe("custom");
    });

    it("classifies any group as custom", () => {
        const rs = [{ operation: "update", users: [ME], groups: ["devs"] }];
        expect(restrictionKind(rs, ME)).toBe("custom");
    });
});

describe("planPublish", () => {
    it("plans the author-only folder chain above the page, top-down", async () => {
        const http = tree({
            "555": {
                kind: "page",
                title: "Page",
                parentId: "F2",
                parentType: "folder",
                restrictions: AUTHOR,
            },
            F2: {
                kind: "folder",
                title: "Inner",
                parentId: "F1",
                parentType: "folder",
                restrictions: AUTHOR,
            },
            F1: {
                kind: "folder",
                title: "Outer",
                parentId: "100",
                parentType: "page",
                restrictions: AUTHOR,
            },
            "100": { kind: "page", title: "Home" },
        });

        const have = await planPublish(await depsFor(http), DEST);

        expect(have).toEqual({
            dest: DEST,
            accountId: ME,
            items: [
                { id: "F1", kind: "folder", title: "Outer" },
                { id: "F2", kind: "folder", title: "Inner" },
                { id: "555", kind: "page", title: "Page" },
            ],
            warning: "",
        });
        expect(cleared(http)).toEqual([]);
    });

    it("plans only the page at a space root", async () => {
        const http = tree({
            "555": { kind: "page", title: "Page", restrictions: AUTHOR },
        });

        const have = await planPublish(await depsFor(http), DEST);

        expect(have.items).toEqual([
            { id: "555", kind: "page", title: "Page" },
        ]);
        expect(have.warning).toBe("");
    });

    it("stops at a parent that is neither a page nor a folder", async () => {
        const http = tree({
            "555": {
                kind: "page",
                title: "Page",
                parentId: "W",
                parentType: "whiteboard",
                restrictions: AUTHOR,
            },
        });

        const have = await planPublish(await depsFor(http), DEST);

        expect(have.items).toEqual([
            { id: "555", kind: "page", title: "Page" },
        ]);
    });

    it("plans the folders alone when the page is already open", async () => {
        const http = tree({
            "555": {
                kind: "page",
                title: "Page",
                parentId: "F1",
                parentType: "folder",
            },
            F1: { kind: "folder", title: "Outer", restrictions: AUTHOR },
        });

        const have = await planPublish(await depsFor(http), DEST);

        expect(have.items).toEqual([
            { id: "F1", kind: "folder", title: "Outer" },
        ]);
    });

    it("plans nothing for an open page under an open parent", async () => {
        const http = tree({
            "555": {
                kind: "page",
                title: "Page",
                parentId: "100",
                parentType: "page",
            },
            "100": { kind: "page", title: "Home" },
        });

        const have = await planPublish(await depsFor(http), DEST);

        expect(have.items).toEqual([]);
        expect(have.warning).toBe("");
    });

    it("warns about an author-only parent page and leaves it alone", async () => {
        const http = tree({
            "555": {
                kind: "page",
                title: "Page",
                parentId: "100",
                parentType: "page",
                restrictions: AUTHOR,
            },
            "100": { kind: "page", title: "Draft", restrictions: AUTHOR },
        });

        const have = await planPublish(await depsFor(http), DEST);

        expect(have.items).toEqual([
            { id: "555", kind: "page", title: "Page" },
        ]);
        expect(have.warning).toBe(
            'parent page "Draft" is still private; publish it to make this page visible',
        );
    });

    it("warns about an ancestor whose read restriction names others", async () => {
        const http = tree({
            "555": {
                kind: "page",
                title: "Page",
                parentId: "F1",
                parentType: "folder",
                restrictions: AUTHOR,
            },
            F1: {
                kind: "folder",
                title: "Team",
                restrictions: { read: { groups: ["team"] } },
            },
        });

        const have = await planPublish(await depsFor(http), DEST);

        expect(have.items).toEqual([
            { id: "555", kind: "page", title: "Page" },
        ]);
        expect(have.warning).toBe(
            'folder "Team" restricts who can view it; the page stays hidden from everyone it excludes',
        );
    });

    it("does not warn about an ancestor restricting only edits", async () => {
        const http = tree({
            "555": {
                kind: "page",
                title: "Page",
                parentId: "100",
                parentType: "page",
                restrictions: AUTHOR,
            },
            "100": {
                kind: "page",
                title: "Home",
                restrictions: { update: { users: ["other"] } },
            },
        });

        const have = await planPublish(await depsFor(http), DEST);

        expect(have.warning).toBe("");
    });

    it("refuses a page restricted to anyone but the author", async () => {
        const http = tree({
            "555": {
                kind: "page",
                title: "Page",
                restrictions: { read: { users: [ME, "other"] } },
            },
        });

        await expect(planPublish(await depsFor(http), DEST)).rejects.toThrow(
            "docs/page.md: restricted to other users or groups; " +
                "change its restrictions in Confluence",
        );
    });

    it("refuses a note without a page id", async () => {
        const http = tree({});
        const deps = await depsFor(http, '---\ntitle: "Page"\n---\n\nbody\n');

        await expect(planPublish(deps, DEST)).rejects.toThrow(
            "docs/page.md: not on Confluence yet; push it first",
        );
        expect(http.requests).toEqual([]);
    });

    it("refuses a missing note", async () => {
        const deps = await depsFor(tree({}));

        await expect(planPublish(deps, "/vault/gone.md")).rejects.toThrow(
            "gone.md: not on Confluence yet; push it first",
        );
    });
});

describe("publish", () => {
    it("clears every planned item top-down", async () => {
        const http = tree({
            "555": {
                kind: "page",
                title: "Page",
                parentId: "F1",
                parentType: "folder",
                restrictions: AUTHOR,
            },
            F1: { kind: "folder", title: "Outer", restrictions: AUTHOR },
        });
        const deps = await depsFor(http);
        const plan = await planPublish(deps, DEST);

        const have = await publish(deps.client, plan);

        expect(have).toEqual(plan.items);
        expect(cleared(http)).toEqual(["F1", "555"]);
    });

    it("skips an item opened since the plan", async () => {
        const http = tree({
            "555": {
                kind: "page",
                title: "Page",
                parentId: "F1",
                parentType: "folder",
                restrictions: AUTHOR,
            },
            F1: { kind: "folder", title: "Outer", restrictions: AUTHOR },
        });
        const deps = await depsFor(http);
        const plan = await planPublish(deps, DEST);
        restrict(http, "F1", {});

        const have = await publish(deps.client, plan);

        expect(have).toEqual([{ id: "555", kind: "page", title: "Page" }]);
        expect(cleared(http)).toEqual(["555"]);
    });

    it("stops at an item whose restrictions changed to name others", async () => {
        const http = tree({
            "555": {
                kind: "page",
                title: "Page",
                parentId: "F1",
                parentType: "folder",
                restrictions: AUTHOR,
            },
            F1: { kind: "folder", title: "Outer", restrictions: AUTHOR },
        });
        const deps = await depsFor(http);
        const plan = await planPublish(deps, DEST);
        restrict(http, "555", { read: { groups: ["team"] } });

        await expect(publish(deps.client, plan)).rejects.toThrow(
            'page "Page": restrictions changed since the check; not cleared',
        );
        expect(cleared(http)).toEqual(["F1"]);
    });

    it("surfaces a failed clear", async () => {
        const http = tree({
            "555": { kind: "page", title: "Page", restrictions: AUTHOR },
        });
        const deps = await depsFor(http);
        const plan = await planPublish(deps, DEST);
        http.on("DELETE", `${H}/wiki/rest/api/content/555/restriction`, {
            status: 403,
        });

        await expect(publish(deps.client, plan)).rejects.toThrow(
            "clear restrictions of 555: HTTP 403",
        );
    });
});
