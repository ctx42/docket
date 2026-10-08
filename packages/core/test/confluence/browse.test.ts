// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
    childrenLink,
    isSyncable,
    listChildren,
    spaceTopLevel,
} from "../../src/confluence/browse.ts";
import { ConfluenceClient, type Space } from "../../src/confluence/client.ts";
import { StubHttpClient } from "../support/http-stub.ts";

const host = "https://ex.atlassian.net";

const clientWith = (stub: StubHttpClient): ConfluenceClient =>
    new ConfluenceClient(stub, { host, account: "a@ex.com", token: "secret" });

/** node builds one direct-children entry. */
function node(id: string, type: string, status = "current") {
    return { id, type, title: `T${id}`, status };
}

describe("childrenLink", () => {
    it("builds the page and folder children paths", () => {
        expect(childrenLink("page", "7")).toBe(
            "/wiki/api/v2/pages/7/direct-children",
        );
        expect(childrenLink("folder", "8")).toBe(
            "/wiki/api/v2/folders/8/direct-children",
        );
    });
});

describe("isSyncable", () => {
    it("keeps live pages and folders", () => {
        expect(isSyncable(node("1", "page"))).toBe(true);
        expect(isSyncable(node("2", "folder"))).toBe(true);
        expect(isSyncable(node("3", "page", ""))).toBe(true);
    });

    it("drops other content types", () => {
        for (const type of ["whiteboard", "database", "embed", "smartlink"]) {
            expect(isSyncable(node("1", type))).toBe(false);
        }
    });

    it("drops content that is not current", () => {
        expect(isSyncable(node("1", "page", "archived"))).toBe(false);
        expect(isSyncable(node("2", "folder", "trashed"))).toBe(false);
    });
});

describe("listChildren", () => {
    it("follows the cursor and keeps only syncable children", async () => {
        const path = childrenLink("folder", "5");
        const stub = new StubHttpClient()
            .on("GET", `${host}${path}`, {
                body: JSON.stringify({
                    results: [
                        node("1", "page"),
                        node("2", "whiteboard"),
                        node("3", "folder"),
                    ],
                    _links: { next: `${path}?cursor=abc` },
                }),
            })
            .on("GET", `${host}${path}?cursor=abc`, {
                body: JSON.stringify({
                    results: [node("4", "database"), node("5", "page")],
                }),
            });

        const have = await listChildren(clientWith(stub), "folder", "5");

        expect(have.map((n) => n.id)).toEqual(["1", "3", "5"]);
    });

    it("rejects a failed listing", async () => {
        const stub = new StubHttpClient().on(
            "GET",
            `${host}${childrenLink("page", "5")}`,
            { status: 500 },
        );
        await expect(
            listChildren(clientWith(stub), "page", "5"),
        ).rejects.toThrow("children: HTTP 500");
    });
});

describe("spaceTopLevel", () => {
    const space: Space = {
        id: "42",
        key: "ENG",
        name: "Engineering",
        type: "global",
        status: "current",
        homepageId: "100",
    };
    const rootsURL = `${host}/wiki/api/v2/spaces/42/pages?depth=root&limit=250`;

    it("lists the homepage's children, then the other root pages", async () => {
        const stub = new StubHttpClient()
            .on("GET", `${host}${childrenLink("page", "100")}`, {
                body: JSON.stringify({
                    results: [node("1", "page"), node("2", "embed")],
                }),
            })
            .on("GET", rootsURL, {
                body: JSON.stringify({
                    results: [
                        { id: "100", title: "Home", status: "current" },
                        { id: "7", title: "Beside", status: "current" },
                        { id: "8", title: "Old", status: "archived" },
                    ],
                }),
            });

        const have = await spaceTopLevel(clientWith(stub), space);

        expect(have.children.map((n) => n.id)).toEqual(["1"]);
        expect(have.beside.map((n) => n.id)).toEqual(["7"]);
    });

    it("lists only root pages for a space without a homepage", async () => {
        const stub = new StubHttpClient().on("GET", rootsURL, {
            body: JSON.stringify({
                results: [{ id: "9", title: "Home", status: "current" }],
            }),
        });

        const have = await spaceTopLevel(clientWith(stub), {
            ...space,
            homepageId: "",
        });

        expect(have).toEqual({
            children: [],
            beside: [
                { id: "9", type: "page", title: "Home", status: "current" },
            ],
        });
        expect(stub.requests.map((r) => r.url)).toEqual([rootsURL]);
    });
});
