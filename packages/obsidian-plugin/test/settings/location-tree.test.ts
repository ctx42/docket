// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
    buildTree,
    COLLAPSE_AT,
    LABEL_MAX,
    linkTitle,
    notePath,
    pageUrl,
    shortenPath,
} from "../../src/settings/location-tree.ts";
import type { Location } from "../../src/settings/locations.ts";

/** page builds a page location in space ENG. */
function page(dest: string, id = "1", slug = ""): Location {
    const tail = slug === "" ? "" : `/${slug}`;
    return { kind: "page", dest, src: `/wiki/spaces/ENG/pages/${id}${tail}` };
}

/** noTitles is a title lookup that knows no note. */
const noTitles = (): string => "";

describe("shortenPath", () => {
    it("keeps a path that fits", () => {
        const have = shortenPath("srd/a.md", 20);

        expect(have).toBe("srd/a.md");
    });

    it("keeps the first segment and the end of the last", () => {
        const have = shortenPath("int53-mtc2ui/mtc2ui-interface-srd.md", 24);

        expect(have).toBe("int53-mtc2ui/…ace-srd.md");
        expect(have).toHaveLength(24);
    });

    it("drops middle segments first", () => {
        const have = shortenPath("doc/a/b/c/d/devices.md", 18);

        expect(have).toBe("doc/…/devices.md");
    });

    it("cuts from the front when the first segment alone is too long", () => {
        const have = shortenPath("a-very-long-first-segment/x.md", 12);

        expect(have).toBe("…egment/x.md");
    });

    it("cuts a single long segment at the end", () => {
        const have = shortenPath("software-requirements-template.md", 16);

        expect(have).toBe("software-requir…");
    });
});

describe("linkTitle", () => {
    it.each<[string, Location, string]>([
        [
            "page slug, decoded",
            page("a.md", "7", "INT-381+SRD+2FA"),
            "INT-381 SRD 2FA",
        ],
        ["page without slug", page("a.md", "7"), "Page 7"],
        [
            "folder",
            { kind: "folder", dest: "g", src: "/wiki/spaces/ENG/folder/9" },
            "Folder 9",
        ],
        [
            "space",
            { kind: "space", dest: "s", src: "/wiki/spaces/ENG/overview" },
            "ENG",
        ],
        [
            "unparsable",
            { kind: "page", dest: "a.md", src: "nonsense" },
            "nonsense",
        ],
    ])("%s", (_, loc, want) => {
        const have = linkTitle(loc);

        expect(have).toBe(want);
    });
});

describe("notePath", () => {
    it("is the note itself for a page", () => {
        expect(notePath(page("srd/a.md"))).toBe("srd/a.md");
    });

    it("is the folder's _index.md for a space or folder", () => {
        const have = notePath({
            kind: "space",
            dest: "doc/user_docs",
            src: "/wiki/spaces/ID/overview",
        });

        expect(have).toBe("doc/user_docs/_index.md");
    });
});

describe("pageUrl", () => {
    it("joins the Site host and the source path", () => {
        const have = pageUrl("acme", "/wiki/spaces/ENG/pages/7/T");

        expect(have).toBe(
            "https://acme.atlassian.net/wiki/spaces/ENG/pages/7/T",
        );
    });

    it("keeps a full URL's path only", () => {
        const have = pageUrl("acme", "https://other.example/wiki/spaces/E?x=1");

        expect(have).toBe("https://acme.atlassian.net/wiki/spaces/E");
    });

    it("is empty without a Site", () => {
        expect(pageUrl("", "/wiki/spaces/E")).toBe("");
    });
});

describe("buildTree", () => {
    it("groups by the first folder, top-level rows first", () => {
        const list = [page("srd/b.md"), page("top.md"), page("doc/a.md")];

        const have = buildTree(list, noTitles, "", new Map());

        expect(have.map((g) => g.name)).toEqual(["", "doc", "srd"]);
        expect(have[0]?.rows.map((r) => r.label)).toEqual(["top.md"]);
        expect(have[1]?.rows.map((r) => r.label)).toEqual(["a.md"]);
    });

    it("sorts rows by vault path", () => {
        const list = [page("srd/z.md"), page("srd/a.md")];

        const have = buildTree(list, noTitles, "", new Map());

        expect(have[0]?.rows.map((r) => r.loc.dest)).toEqual([
            "srd/a.md",
            "srd/z.md",
        ]);
    });

    it("shortens long labels", () => {
        const dest = `srd/${"x".repeat(LABEL_MAX)}/n.md`;

        const have = buildTree([page(dest)], noTitles, "", new Map());

        expect(have[0]?.rows[0]?.label).toHaveLength(LABEL_MAX);
    });

    it("prefers the note title over the link", () => {
        const list = [page("a.md", "1", "Slug"), page("b.md", "2", "Other")];
        const title = (l: Location): string =>
            l.dest === "a.md" ? "From note" : "";

        const have = buildTree(list, title, "", new Map());

        const rows = have[0]?.rows ?? [];
        expect(rows.map((r) => [r.title, r.titleSource])).toEqual([
            ["From note", "note"],
            ["Other", "link"],
        ]);
    });

    it("reads each row's space key and a group's shared key", () => {
        const other: Location = {
            kind: "page",
            dest: "mix/b.md",
            src: "/wiki/spaces/OPS/pages/2",
        };
        const list = [
            page("srd/a.md"),
            page("srd/b.md"),
            page("mix/a.md"),
            other,
        ];

        const have = buildTree(list, noTitles, "", new Map());

        const mix = have.find((g) => g.name === "mix");
        const srd = have.find((g) => g.name === "srd");
        expect(srd?.space).toBe("ENG");
        expect(mix?.space).toBe("");
        expect(mix?.rows.map((r) => r.space)).toEqual(["ENG", "OPS"]);
    });

    it("folds a group with more than COLLAPSE_AT rows", () => {
        const many = Array.from({ length: COLLAPSE_AT + 1 }, (_, i) =>
            page(`srd/p${i}.md`),
        );
        const few = [page("doc/a.md")];

        const have = buildTree([...many, ...few], noTitles, "", new Map());

        expect(have.map((g) => [g.name, g.open])).toEqual([
            ["doc", true],
            ["srd", false],
        ]);
    });

    it("lets a toggled state override the default", () => {
        const list = [page("doc/a.md")];

        const have = buildTree(list, noTitles, "", new Map([["doc", false]]));

        expect(have[0]?.open).toBe(false);
    });

    it("keeps the group holding the invalid location open", () => {
        const list = [page("doc/a.md"), page("srd/bad.md")];

        const have = buildTree(
            list,
            noTitles,
            "",
            new Map([["srd", false]]),
            "srd/bad.md",
        );

        expect(have.map((g) => [g.name, g.open])).toEqual([
            ["doc", true],
            ["srd", true],
        ]);
    });

    it("filters by title, vault path, or space key, case-insensitive", () => {
        const list = [
            page("srd/a.md", "1", "Alarm+Routing"),
            page("srd/b.md", "2", "Battery"),
            { kind: "page", dest: "ops/c.md", src: "/wiki/spaces/OPS/pages/3" },
        ] satisfies Location[];

        const byTitle = buildTree(list, noTitles, "alarm", new Map());
        const byPath = buildTree(list, noTitles, " B.MD ", new Map());
        const bySpace = buildTree(list, noTitles, "ops", new Map());

        const dests = (gs: typeof byTitle): string[] =>
            gs.flatMap((g) => g.rows.map((r) => r.loc.dest));
        expect(dests(byTitle)).toEqual(["srd/a.md"]);
        expect(dests(byPath)).toEqual(["srd/b.md"]);
        expect(dests(bySpace)).toEqual(["ops/c.md"]);
    });

    it("opens every matching group while filtering, and drops empty ones", () => {
        const many = Array.from({ length: COLLAPSE_AT + 1 }, (_, i) =>
            page(`srd/p${i}.md`),
        );

        const have = buildTree(
            [...many, page("doc/a.md")],
            noTitles,
            "p1",
            new Map([["srd", false]]),
        );

        expect(have.map((g) => [g.name, g.open])).toEqual([["srd", true]]);
    });
});
