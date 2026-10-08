// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Ported from pkg/adf/markdown_test.go (Test_ADF_frontmatter_*, Test_ADF_mentions),
// pkg/adf/adf_test.go (Test_ADF_MarshallMarkdown), and example_test.go
// (ExampleADF_MarshallMarkdown). Frontmatter fields are dialect-stable and port
// 1:1; bodies that contain mentions/media/TOC are re-baselined to the Obsidian
// dialect. The `root_page_1.v5.json` input is reused verbatim; its rendered
// golden is re-baselined via `toMatchFileSnapshot` and reviewed by hand.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { marshallMarkdownAssets } from "../../../src/adf/lens/sourcemap.ts";
import { goQuote, noteURL } from "../../../src/adf/render/frontmatter.ts";
import { newADF } from "../../../src/models/adf.ts";

const render = (data: string, assets: Record<string, string> = {}): string =>
    marshallMarkdownAssets(newADF(data), assets);

const here = fileURLToPath(new URL(".", import.meta.url));

describe("frontmatter", () => {
    it("renders the page path from the name", () => {
        const data = `{
           "name": "docs/my-page.md",
           "title": "My Page",
           "adf": { "type": "doc", "content": [] }
        }`;
        expect(render(data)).toBe(
            '---\ndocket_mode: pull\nid: ""\ntitle: "My Page"\ndocket_page_path: "docs/my-page.md"\n' +
                'docket_page_id: ""\ndocket_page_version: 0\ndocket_space_id: ""\n---\n',
        );
    });

    it("renders the space key after the space id when set", () => {
        const data = `{
           "name": "docs/my-page.md", "title": "My Page",
           "space_id": "42", "space_key": "RZTST",
           "adf": { "type": "doc", "content": [] }
        }`;
        expect(render(data)).toBe(
            '---\ndocket_mode: pull\nid: ""\ntitle: "My Page"\ndocket_page_path: "docs/my-page.md"\n' +
                'docket_page_id: ""\ndocket_page_version: 0\ndocket_space_id: "42"\ndocket_space_key: "RZTST"\n---\n',
        );
    });

    it("omits the space key when unset", () => {
        const data = `{
           "name": "docs/my-page.md", "title": "My Page",
           "adf": { "type": "doc", "content": [] }
        }`;
        expect(render(data)).not.toContain("space_key");
    });

    it("renders parent_id after space_id when set", () => {
        const data = `{
           "name": "docs/my-page.md", "title": "My Page",
           "space_id": "42", "parent_id": "77",
           "adf": { "type": "doc", "content": [] }
        }`;
        expect(render(data)).toBe(
            '---\ndocket_mode: pull\nid: ""\ntitle: "My Page"\ndocket_page_path: "docs/my-page.md"\n' +
                'docket_page_id: ""\ndocket_page_version: 0\ndocket_space_id: "42"\ndocket_parent_id: "77"\n---\n',
        );
    });

    it("renders parent_id before space_key when both are set", () => {
        const data = `{
           "name": "docs/my-page.md", "title": "My Page",
           "space_id": "42", "parent_id": "77", "space_key": "RZTST",
           "adf": { "type": "doc", "content": [] }
        }`;
        expect(render(data)).toBe(
            '---\ndocket_mode: pull\nid: ""\ntitle: "My Page"\ndocket_page_path: "docs/my-page.md"\n' +
                'docket_page_id: ""\ndocket_page_version: 0\ndocket_space_id: "42"\n' +
                'docket_parent_id: "77"\ndocket_space_key: "RZTST"\n---\n',
        );
    });

    it("omits parent_id when unset", () => {
        const data = `{
           "name": "docs/my-page.md", "title": "My Page",
           "adf": { "type": "doc", "content": [] }
        }`;
        expect(render(data)).not.toContain("parent_id");
    });

    it("renders the domain when set", () => {
        const data = `{
           "name": "docs/my-page.md", "title": "My Page",
           "cf_domain": "ex.atlassian.net",
           "adf": { "type": "doc", "content": [] }
        }`;
        expect(render(data)).toBe(
            '---\ndocket_mode: pull\nid: ""\ntitle: "My Page"\ndocket_page_path: "docs/my-page.md"\n' +
                'docket_page_id: ""\ndocket_page_version: 0\ndocket_space_id: ""\n' +
                'docket_domain: "ex.atlassian.net"\n---\n',
        );
    });

    it("omits the domain when unset", () => {
        const data = `{
           "name": "docs/my-page.md", "title": "My Page",
           "adf": { "type": "doc", "content": [] }
        }`;
        expect(render(data)).not.toContain("cf_domain");
    });

    it("renders the page id as id right after the marker", () => {
        const data = `{
           "name": "docs/my-page.md", "id": "2228027393", "title": "My Page",
           "adf": { "type": "doc", "content": [] }
        }`;
        expect(render(data)).toContain(
            '---\ndocket_mode: pull\nid: "2228027393"\ntitle: "My Page"\n',
        );
    });

    it("stamps docket_mode: pull as the first field", () => {
        const data = `{
           "name": "docs/my-page.md", "title": "My Page",
           "adf": { "type": "doc", "content": [] }
        }`;
        expect(render(data).startsWith("---\ndocket_mode: pull\n")).toBe(true);
    });
});

describe("mentions", () => {
    it("distinct names populate the frontmatter map", () => {
        const data = `{
           "adf": { "type": "doc", "content": [
              { "type": "paragraph", "content": [
                 { "type": "mention", "attrs": { "id": "A", "text": "@Ann" } },
                 { "type": "text", "text": " " },
                 { "type": "mention", "attrs": { "id": "B", "text": "@Bob" } }
              ] }
           ] }
        }`;
        expect(render(data)).toBe(
            '---\ndocket_mode: pull\nid: ""\ntitle: ""\ndocket_page_path: ""\ndocket_page_id: ""\ndocket_page_version: 0\n' +
                'docket_space_id: ""\ndocket_mentions:\n  "Ann": "A"\n  "Bob": "B"\n---\n' +
                "\n`adf:@Ann` `adf:@Bob`\n",
        );
    });

    it("a colliding name is inline-only, off the map", () => {
        const data = `{
           "adf": { "type": "doc", "content": [
              { "type": "paragraph", "content": [
                 { "type": "mention", "attrs": { "id": "S1", "text": "@Sam" } },
                 { "type": "text", "text": " " },
                 { "type": "mention", "attrs": { "id": "S2", "text": "@Sam" } },
                 { "type": "text", "text": " " },
                 { "type": "mention", "attrs": { "id": "A",  "text": "@Ann" } }
              ] }
           ] }
        }`;
        expect(render(data)).toBe(
            '---\ndocket_mode: pull\nid: ""\ntitle: ""\ndocket_page_path: ""\ndocket_page_id: ""\ndocket_page_version: 0\n' +
                'docket_space_id: ""\ndocket_mentions:\n  "Ann": "A"\n---\n' +
                "\n`adf:@Sam|id=S1` `adf:@Sam|id=S2` `adf:@Ann`\n",
        );
    });
});

describe("MarshallMarkdown media", () => {
    it("renders images and page_images from assets", () => {
        const data = `{
           "title": "T", "id": "1", "version": 2, "space_id": "9",
           "adf": { "type": "doc", "content": [
              { "type": "mediaSingle", "attrs": { "layout": "center" }, "content": [
                 { "type": "media", "attrs": {
                    "type": "file", "id": "F1", "localId": "L1", "alt": "pic.jpg" } }
              ] }
           ] }
        }`;
        expect(render(data, { L1: "../_docket-media/F1-L1.jpg" })).toBe(
            '---\ndocket_mode: pull\nid: "1"\ntitle: "T"\ndocket_page_path: ""\ndocket_page_id: "1"\ndocket_page_version: 2\n' +
                'docket_space_id: "9"\nurl: "/wiki/pages/viewpage.action?pageId=1"\n' +
                'docket_page_images:\n  - local_id: "L1"\n' +
                '    file: "../_docket-media/F1-L1.jpg"\n    alt: "pic.jpg"\n---\n' +
                "\n![[F1-L1.jpg]]\n",
        );
    });

    it("renders a mediaGroup as one embed per line", () => {
        const data = `{
           "title": "T", "id": "1", "version": 2, "space_id": "9",
           "adf": { "type": "doc", "content": [
              { "type": "mediaGroup", "content": [
                 { "type": "media", "attrs": {
                    "type": "file", "id": "F1", "localId": "L1", "alt": "a.png" } },
                 { "type": "media", "attrs": {
                    "type": "file", "id": "F2", "localId": "L2", "alt": "b.png" } }
              ] }
           ] }
        }`;
        expect(
            render(data, {
                L1: "../_docket-media/F1-L1.png",
                L2: "../_docket-media/F2-L2.png",
            }),
        ).toBe(
            '---\ndocket_mode: pull\nid: "1"\ntitle: "T"\ndocket_page_path: ""\ndocket_page_id: "1"\ndocket_page_version: 2\n' +
                'docket_space_id: "9"\nurl: "/wiki/pages/viewpage.action?pageId=1"\n' +
                "docket_page_images:\n" +
                '  - local_id: "L1"\n    file: "../_docket-media/F1-L1.png"\n    alt: "a.png"\n' +
                '  - local_id: "L2"\n    file: "../_docket-media/F2-L2.png"\n    alt: "b.png"\n' +
                "---\n\n![[F1-L1.png]]\n![[F2-L2.png]]\n",
        );
    });
});

describe("MarshallMarkdown example", () => {
    it("renders the doc example from the Go example test", () => {
        const data = `{
           "name": "demo.md", "title": "Demo", "id": "1", "version": 1, "space_id": "2",
           "adf": { "type": "doc", "content": [
              { "type": "heading", "attrs": { "level": 1 },
                "content": [ { "type": "text", "text": "Hello" } ] },
              { "type": "paragraph", "content": [
                 { "type": "text", "text": "Bold", "marks": [ { "type": "strong" } ] },
                 { "type": "text", "text": " and plain." }
              ] }
           ] }
        }`;
        expect(render(data)).toBe(
            '---\ndocket_mode: pull\nid: "1"\ntitle: "Demo"\ndocket_page_path: "demo.md"\ndocket_page_id: "1"\n' +
                'docket_page_version: 1\ndocket_space_id: "2"\n' +
                'url: "/wiki/pages/viewpage.action?pageId=1"\n---\n\n' +
                "# Hello\n\n**Bold** and plain.\n",
        );
    });

    it("renders the page url and no section anchors", () => {
        const data = `{
           "title": "T", "id": "7", "space_id": "2", "space_key": "ENG",
           "cf_domain": "ex.atlassian.net",
           "adf": { "type": "doc", "content": [
              { "type": "heading", "attrs": { "level": 2 },
                "content": [ { "type": "text", "text": "Set up" } ] },
              { "type": "codeBlock",
                "content": [ { "type": "text", "text": "# not a heading" } ] },
              { "type": "heading", "attrs": { "level": 3 },
                "content": [ { "type": "text", "text": "Set up" } ] }
           ] }
        }`;
        const have = render(data);

        expect(have).toContain(
            'url: "https://ex.atlassian.net/wiki/spaces/ENG/pages/7"\n---\n',
        );
        expect(have).not.toContain("heading_anchors");
    });

    it("writes only shared or docket_-prefixed keys", () => {
        const data = `{
           "name": "docs/p.md", "title": "T", "id": "7", "version": 2,
           "space_id": "2", "parent_id": "1", "space_key": "ENG",
           "cf_domain": "ex.atlassian.net",
           "adf": { "type": "doc", "content": [
              { "type": "heading", "attrs": { "level": 2 },
                "content": [ { "type": "text", "text": "Intro" } ] },
              { "type": "paragraph", "content": [
                 { "type": "mention", "attrs": { "id": "A", "text": "@Ann" } }
              ] },
              { "type": "mediaSingle", "content": [
                 { "type": "media", "attrs": { "type": "file", "id": "F1",
                   "localId": "L1", "alt": "pic.png" } }
              ] }
           ] }
        }`;
        const fm =
            /^---\n([\s\S]*?)\n---\n/.exec(
                render(data, { L1: "../_docket-media/F1-L1.png" }),
            )?.[1] ?? "";

        const have = [...fm.matchAll(/^([^\s:][^:]*):/gm)].map((m) => m[1]);

        expect(have).toEqual([
            "docket_mode",
            "id",
            "title",
            "docket_page_path",
            "docket_page_id",
            "docket_page_version",
            "docket_space_id",
            "docket_parent_id",
            "docket_space_key",
            "docket_domain",
            "url",
            "docket_page_images",
            "docket_mentions",
        ]);
    });

    it("errors when the root node is not a doc", () => {
        expect(() => render(`{ "adf": { "type": "paragraph" } }`)).toThrow(
            'root node is "paragraph", want doc',
        );
    });
});

describe("MarshallMarkdown golden", () => {
    it("renders root_page_1.v5 to the re-baselined golden", async () => {
        const input = readFileSync(
            `${here}testdata/root_page_1.v5.json`,
            "utf8",
        );
        const md = marshallMarkdownAssets(newADF(input), {});
        await expect(md).toMatchFileSnapshot(
            `${here}testdata/root_page_1.v5.md`,
        );
    });
});

describe("noteURL", () => {
    it.each([
        [
            "ex.atlassian.net",
            "ENG",
            "1",
            "https://ex.atlassian.net/wiki/spaces/ENG/pages/1",
        ],
        [
            "ex.atlassian.net",
            "",
            "1",
            "https://ex.atlassian.net/wiki/pages/viewpage.action?pageId=1",
        ],
        ["", "ENG", "1", "/wiki/spaces/ENG/pages/1"],
        ["", "", "1", "/wiki/pages/viewpage.action?pageId=1"],
        [
            "https://ex.atlassian.net//",
            "ENG",
            "1",
            "https://ex.atlassian.net/wiki/spaces/ENG/pages/1",
        ],
        ["ex.atlassian.net", "ENG", "", ""],
    ])("url(%j, %j, %j)", (domain, space, id, want) => {
        // --- When ---
        const have = noteURL(domain, space, id);

        // --- Then ---
        expect(have).toBe(want);
    });
});

describe("goQuote", () => {
    const cases: Array<{ name: string; value: string; want: string }> = [
        { name: "quote and backslash", value: 'a"b\\c', want: '"a\\"b\\\\c"' },
        { name: "short escapes", value: "\t\n", want: '"\\t\\n"' },
        {
            name: "other C0 and DEL",
            value: "\u0001\u007f",
            want: '"\\x01\\x7f"',
        },
        { name: "printable non-ASCII", value: "é😀", want: '"é😀"' },
        { name: "a C1 control", value: "\u0085", want: '"\\u0085"' },
        { name: "a line separator", value: "\u2028", want: '"\\u2028"' },
        { name: "a zero-width space", value: "\u200b", want: '"\\u200b"' },
        { name: "a bidi embedding", value: "\u202a", want: '"\\u202a"' },
        { name: "an invisible operator", value: "\u2060", want: '"\\u2060"' },
        { name: "a noncharacter", value: "\ufdd0", want: '"\\ufdd0"' },
        { name: "a BOM", value: "\ufeff", want: '"\\ufeff"' },
        { name: "a BMP U+FFFF", value: "\uffff", want: '"\\uffff"' },
        {
            name: "an astral noncharacter",
            value: "\u{1fffe}",
            want: '"\\U0001fffe"',
        },
    ];

    for (const tc of cases) {
        it(`quotes ${tc.name}`, () => {
            const have = goQuote(tc.value);

            expect(have).toBe(tc.want);
        });
    }
});
