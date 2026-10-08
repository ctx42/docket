// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { DEFAULT_SETTINGS, type docketSettings } from "@docket/core";
import { describe, expect, it } from "vitest";
import {
    checkLocation,
    detectKind,
    errorDest,
    type Location,
    locations,
    putLocation,
    removeLocation,
    suggestDest,
    titleDest,
} from "../../src/settings/locations.ts";

const PAGE = "https://ex.atlassian.net/wiki/spaces/ENG/pages/123/Release+Notes";
const FOLDER = "/wiki/spaces/ENG/folder/456?x=1";
const SPACE = "https://ex.atlassian.net/wiki/spaces/ENG/overview";

/** settings builds settings holding the given maps. */
function settings(over: Partial<docketSettings>): docketSettings {
    return { ...DEFAULT_SETTINGS, ...over };
}

describe("detectKind", () => {
    it.each([
        [PAGE, "page"],
        [FOLDER, "folder"],
        [SPACE, "space"],
        ["/wiki/spaces/ENG", "space"],
        ["not a link", null],
    ])("%s → %s", (src, want) => {
        const have = detectKind(src);

        expect(have).toBe(want);
    });
});

describe("suggestDest", () => {
    it.each([
        ["page", PAGE, "Release Notes.md"],
        ["page", "/wiki/spaces/ENG/pages/123", "page-123.md"],
        ["page", "/wiki/spaces/ENG/pages/9/A%3AB", "A-B.md"],
        ["folder", FOLDER, "folder-456"],
        ["space", SPACE, "ENG"],
        ["page", "not a link", ""],
    ] as const)("%s %s → %s", (kind, src, want) => {
        const have = suggestDest(kind, src);

        expect(have).toBe(want);
    });
});

describe("locations", () => {
    it("lists pages, folders, then spaces, each sorted", () => {
        const s = settings({
            pages: { "b.md": "/p/2", "a.md": "/p/1" },
            folders: { f: "/f" },
            spaces: { s: "/s" },
        });

        const have = locations(s);

        expect(have.map((l) => `${l.kind}:${l.dest}`)).toEqual([
            "page:a.md",
            "page:b.md",
            "folder:f",
            "space:s",
        ]);
    });
});

describe("checkLocation", () => {
    const page: Location = { kind: "page", dest: "Notes.md", src: PAGE };

    it("accepts a valid new location", () => {
        const have = checkLocation(settings({}), page, null);

        expect(have).toBe("");
    });

    it.each([
        ["an empty link", { ...page, src: "" }, "Paste a Confluence link."],
        [
            "an empty path",
            { ...page, dest: "" },
            "Choose where in the vault it goes.",
        ],
        [
            "a link of another kind",
            { ...page, src: SPACE },
            "This link is a space, not a page.",
        ],
        [
            "a page path without .md",
            { ...page, dest: "Notes" },
            'page destination "Notes" must end in .md',
        ],
        [
            "a folder path with .md",
            { kind: "folder", dest: "x.md", src: FOLDER },
            'root destination "x.md" must not end in .md',
        ],
    ] as const)("rejects %s", (_, next, want) => {
        const have = checkLocation(settings({}), next, null);

        expect(have).toBe(want);
    });

    it("rejects a destination in use, except by the entry being edited", () => {
        const s = settings({ pages: { "Notes.md": PAGE } });

        expect(checkLocation(s, page, null)).toBe(
            "Notes.md is already a synced location.",
        );
        expect(checkLocation(s, page, page)).toBe("");
    });
});

describe("putLocation / removeLocation", () => {
    it("moves an edited entry to its new kind and path", () => {
        const prev: Location = { kind: "page", dest: "a.md", src: "/p/1" };
        const s = settings({ pages: { "a.md": "/p/1" } });

        const have = putLocation(
            s,
            { kind: "folder", dest: "f", src: FOLDER },
            prev,
        );

        expect(have.pages).toEqual({});
        expect(have.folders).toEqual({ f: FOLDER });
        expect(s.pages).toEqual({ "a.md": "/p/1" });
    });

    it("removes a location", () => {
        const s = settings({ spaces: { s: "/s", t: "/t" } });

        const have = removeLocation(s, { kind: "space", dest: "s", src: "/s" });

        expect(have.spaces).toEqual({ t: "/t" });
    });
});

describe("errorDest", () => {
    it.each([
        ['config: page destination "a/b" must end in .md', "a/b"],
        ["config: site is required", ""],
    ])("%s → %s", (msg, want) => {
        const have = errorDest(msg);

        expect(have).toBe(want);
    });
});

describe("titleDest", () => {
    it.each([
        ["page", "Release: Q3", "Release- Q3.md"],
        ["space", "Engineering", "Engineering"],
        ["folder", "  ", ""],
    ] as const)("%s %s → %s", (kind, title, want) => {
        const have = titleDest(kind, title);

        expect(have).toBe(want);
    });
});
