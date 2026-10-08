// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { type Config, emptyConfig } from "../../src/config/config.ts";
import {
    checkMCPJSON,
    docPath,
    frontMatter,
    loadConfig,
    relPath,
    urlPort,
} from "../../src/config/project.ts";
import { MILLISECOND, SECOND } from "../../src/gocompat/duration.ts";
import { readGolden } from "../support/golden.ts";
import { MemDocFs } from "../support/mem-doc-fs.ts";

/** ROOT is the project root the tests write into. */
const ROOT = "/p";

/** project writes a project-config.md with front matter and folders. */
function project(front: string, ...dirs: string[]): MemDocFs {
    const fs = new MemDocFs().mkdirp(ROOT);
    for (const d of dirs) fs.mkdirp(`${ROOT}/${d}`);
    return fs.writeFile(
        `${ROOT}/project-config.md`,
        `---\n${front}---\n\n# Project configuration\n`,
    );
}

/** load loads the project config written on fs. */
function load(fs: MemDocFs): Promise<Config> {
    return loadConfig(fs, `${ROOT}/project-config.md`);
}

/** loadError returns what loading the project on fs throws. */
async function loadError(fs: MemDocFs): Promise<Error> {
    try {
        await load(fs);
    } catch (err) {
        return err as Error;
    }
    throw new Error("load did not throw");
}

const HEAD = "mcp-server: srd\nmcp-port: 7777\n";

describe("loadConfig (project-config.md)", () => {
    // go: Test_Load_project
    it("maps the front matter onto a config", async () => {
        const fs = project(
            "mcp-server: srd\nmcp-port: 7777\nsources:\n  - upstream\n  - initiatives\n  - kb\n" +
                "gaps: gaps\nwatch: true\nwatch-debounce: 2s\nglossary: upstream/bookshop/glossary\n" +
                "kb: kb\ninitiatives: initiatives\nprecedence:\n  - kb\n  - upstream/bookshop\n",
            "upstream/bookshop/glossary",
            "initiatives",
            "kb",
            "gaps",
        );

        const have = await load(fs);

        expect(have).toEqual({
            listen: ":7777",
            sources: new Map([
                ["upstream", { dir: `${ROOT}/upstream`, file: "" }],
                ["initiatives", { dir: `${ROOT}/initiatives`, file: "" }],
                ["kb", { dir: `${ROOT}/kb`, file: "" }],
            ]),
            gaps: `${ROOT}/gaps`,
            watch: { enabled: true, debounce: 2n * SECOND },
            glossary: "upstream/bookshop/glossary",
            precedence: ["kb", "upstream/bookshop"],
            initiatives: "initiatives",
            kb: `${ROOT}/kb`,
            project: { root: ROOT, server: "srd", port: 7777 },
        } satisfies Config);
    });

    // go: Test_Load_project_defaults
    it("applies defaults", async () => {
        const have = await load(project(`${HEAD}sources: [kb]\n`, "kb"));

        expect(have.watch).toEqual({
            enabled: false,
            debounce: 500n * MILLISECOND,
        });
        expect([have.gaps, have.glossary, have.initiatives, have.kb]).toEqual([
            "",
            "",
            "",
            "",
        ]);
        expect(have.precedence).toEqual([]);
    });

    // go: Test_Load_project_cleans_source_entry
    it("cleans a source entry", async () => {
        const have = await load(project(`${HEAD}sources: [kb/]\n`, "kb"));

        expect(have.sources).toEqual(
            new Map([["kb", { dir: `${ROOT}/kb`, file: "" }]]),
        );
    });

    // go: Test_Load_project_glossary_tabular
    it.each([
        ["folder", "kb/glossary", "kb/glossary"],
        ["file", "kb/glossary/main.md", "kb/glossary/main.md"],
        ["whole source", "kb", "kb"],
        ["trailing slash", "kb/glossary/", "kb/glossary"],
    ])("resolves the glossary: %s", async (_, glossary, want) => {
        const fs = project(
            `${HEAD}sources: [kb]\nglossary: ${glossary}\n`,
            "kb/glossary",
        );
        fs.writeFile(`${ROOT}/kb/glossary/main.md`, "## A\n");

        expect((await load(fs)).glossary).toBe(want);
    });

    // go: Test_Load_project_precedence_tabular
    it.each([
        ["whole source", "[kb]", ["kb"]],
        ["subfolder", "[doc/catalog]", ["doc/catalog"]],
        ["trailing slash", "[doc/catalog/]", ["doc/catalog"]],
        [
            "order kept",
            "[doc/reference, kb, doc]",
            ["doc/reference", "kb", "doc"],
        ],
        ["nested", "[doc, doc/catalog]", ["doc", "doc/catalog"]],
    ])("resolves precedence: %s", async (_, prec, want) => {
        const fs = project(
            `${HEAD}sources: [kb, doc]\nprecedence: ${prec}\n`,
            "kb",
            "doc/catalog",
            "doc/reference",
        );

        expect((await load(fs)).precedence).toEqual(want);
    });

    // go: Test_Load_project_initiatives_tabular
    it.each([
        ["whole source", "initiatives", "initiatives"],
        ["subfolder", "doc/initiatives", "doc/initiatives"],
        ["trailing slash", "doc/initiatives/", "doc/initiatives"],
        ["outside sources", "drafts", ""],
        ["missing inside source", "doc/none", "doc/none"],
    ])("resolves initiatives: %s", async (_, inits, want) => {
        const fs = project(
            `${HEAD}sources: [initiatives, doc]\ninitiatives: ${inits}\n`,
            "initiatives",
            "doc/initiatives",
            "drafts",
        );

        expect((await load(fs)).initiatives).toBe(want);
    });

    // go: Test_Load_project_error_tabular
    it.each([
        [
            "missing mcp-server",
            "mcp-port: 7777\nsources: [kb]\n",
            /^validate config: mcp-server is required/,
        ],
        [
            "missing mcp-port",
            "mcp-server: srd\nsources: [kb]\n",
            /mcp-port must be between 1 and 65535, have 0/,
        ],
        [
            "mcp-port too large",
            "mcp-server: srd\nmcp-port: 70000\nsources: [kb]\n",
            /have 70000/,
        ],
        [
            "mcp-port not a number",
            "mcp-server: srd\nmcp-port: abc\nsources: [kb]\n",
            /parse config: yaml: .*cannot unmarshal/s,
        ],
        ["no sources", HEAD, /sources: cannot be blank/],
        ["empty sources", `${HEAD}sources: []\n`, /sources: cannot be blank/],
        [
            "absolute source",
            `${HEAD}sources: [/srv/kb]\n`,
            /sources path "\/srv\/kb" must be relative to the project root/,
        ],
        [
            "escaping source",
            `${HEAD}sources: [../kb]\n`,
            /sources path "\.\.\/kb" escapes the project root/,
        ],
        [
            "nested source",
            `${HEAD}sources: [kb/sub]\n`,
            /sources entry "kb\/sub" must be a top-level folder name/,
        ],
        [
            "dot source",
            `${HEAD}sources: [.]\n`,
            /sources entry "\." must be a top-level folder name/,
        ],
        [
            "duplicate source",
            `${HEAD}sources: [kb, kb/]\n`,
            /sources entry "kb\/" is listed twice/,
        ],
        [
            "missing source dir",
            `${HEAD}sources: [gone]\n`,
            /sources entry "gone": stat .*no such file/,
        ],
        [
            "source is a file",
            `${HEAD}sources: [file.md]\n`,
            /sources entry "file\.md" is not a directory/,
        ],
        [
            "absolute gaps",
            `${HEAD}sources: [kb]\ngaps: /var/gaps\n`,
            /gaps path "\/var\/gaps" must be relative/,
        ],
        [
            "escaping gaps",
            `${HEAD}sources: [kb]\ngaps: ../gaps\n`,
            /gaps path "\.\.\/gaps" escapes the project root/,
        ],
        [
            "gaps inside source",
            `${HEAD}sources: [kb]\ngaps: kb/gaps\n`,
            /gaps folder ".*\/kb\/gaps" is inside source "kb"/,
        ],
        [
            "absolute glossary",
            `${HEAD}sources: [kb]\nglossary: /kb/g\n`,
            /glossary path "\/kb\/g" must be relative/,
        ],
        [
            "absolute kb",
            `${HEAD}sources: [kb]\nkb: /kb\n`,
            /kb path "\/kb" must be relative/,
        ],
        [
            "absolute initiatives",
            `${HEAD}sources: [kb]\ninitiatives: /i\n`,
            /initiatives path "\/i" must be relative/,
        ],
        [
            "escaping srd-standard",
            `${HEAD}sources: [kb]\nsrd-standard: ../../s.md\n`,
            /srd-standard path "\.\.\/\.\.\/s\.md" escapes the project root/,
        ],
        [
            "glossary missing",
            `${HEAD}sources: [kb]\nglossary: kb/none\n`,
            /glossary: stat .*no such file/,
        ],
        [
            "glossary outside sources",
            `${HEAD}sources: [kb]\nglossary: file.md\n`,
            /glossary ".*\/file\.md" is not inside any source/,
        ],
        [
            "glossary not markdown",
            `${HEAD}sources: [kb]\nglossary: kb/notes.txt\n`,
            /glossary must be a Markdown file or a folder/,
        ],
        [
            "absolute precedence",
            `${HEAD}sources: [kb]\nprecedence: [/kb]\n`,
            /precedence path "\/kb" must be relative/,
        ],
        [
            "escaping precedence",
            `${HEAD}sources: [kb]\nprecedence: [kb, ../kb]\n`,
            /precedence path "\.\.\/kb" escapes the project root/,
        ],
        [
            "misspelled precedence",
            `${HEAD}sources: [kb]\nprecedence: [kb, kbb]\n`,
            /precedence entry "kbb": stat .*no such file/,
        ],
        [
            "duplicate precedence",
            `${HEAD}sources: [kb]\nprecedence: [kb, kb/]\n`,
            /precedence entry "kb\/" is listed twice/,
        ],
        [
            "precedence is a file",
            `${HEAD}sources: [kb]\nprecedence: [kb/notes.txt]\n`,
            /precedence entry "kb\/notes\.txt" is not a directory/,
        ],
        [
            "precedence outside sources",
            `${HEAD}sources: [kb]\nprecedence: [other]\n`,
            /precedence entry "other" is not inside any source/,
        ],
        [
            "precedence inside initiatives",
            `${HEAD}sources: [kb]\ninitiatives: kb\nprecedence: [kb]\n`,
            /precedence entry "kb" is inside initiatives/,
        ],
        [
            "debounce over limit",
            `${HEAD}sources: [kb]\nwatch-debounce: 2m\n`,
            /watch: debounce must not exceed 1m0s/,
        ],
        [
            "zero debounce",
            `${HEAD}sources: [kb]\nwatch-debounce: 0s\n`,
            /watch: debounce must be positive/,
        ],
    ])("refuses %s", async (_, front, want) => {
        const fs = project(front, "kb", "other")
            .writeFile(`${ROOT}/file.md`, "x")
            .writeFile(`${ROOT}/kb/notes.txt`, "x");

        expect((await loadError(fs)).message).toMatch(want);
    });

    // go: Test_Load_project_error_missing_file
    it("fails on a missing file", async () => {
        const have = loadConfig(new MemDocFs(), `${ROOT}/project-config.md`);

        await expect(have).rejects.toThrow(/^read config: open .*no such file/);
    });

    // go: Test_Load_project_error_no_front_matter
    it("fails without front matter", async () => {
        const fs = new MemDocFs().writeFile(
            `${ROOT}/project-config.md`,
            "# Project configuration\n",
        );

        expect((await loadError(fs)).message).toBe(
            "parse config: no front matter",
        );
    });

    // go: Test_Load_project_error_bad_yaml
    it("fails on malformed YAML", async () => {
        expect((await loadError(project("sources: [\n"))).message).toMatch(
            /^parse config: yaml: .*did not find expected/,
        );
    });
});

// go: Test_Config_DocPath_tabular
describe("docPath", () => {
    it.each([
        ["file in source", "/p/kb/a/b.md", "kb/a/b.md", true],
        ["source folder", "/p/kb", "kb", true],
        ["outside sources", "/p/gaps/a.md", "", false],
        ["file source", "/p/one.md", "", false],
        ["empty", "", "", false],
    ])("%s", (_, abs, want, wantOK) => {
        const cfg = emptyConfig();
        cfg.sources = new Map([
            ["kb", { dir: "/p/kb", file: "" }],
            ["one", { dir: "", file: "/p/one.md" }],
        ]);

        expect(docPath(cfg, abs)).toEqual([want, wantOK]);
    });
});

// go: Test_relPath_tabular
describe("relPath errors", () => {
    it.each([
        ["absolute", "/a", 'k path "/a" must be relative to the project root'],
        ["parent", "..", 'k path ".." escapes the project root'],
        [
            "escaping",
            "a/../../b",
            'k path "a/../../b" escapes the project root',
        ],
    ])("%s", (_, val, want) => {
        expect(() => relPath("k", val)).toThrow(want);
    });
});

// go: Test_relPath_valid_tabular
describe("relPath valid", () => {
    it.each([
        ["empty", ""],
        ["plain", "kb"],
        ["nested", "a/b.md"],
        ["inner parent", "a/../b"],
        ["dot dot prefix name", "..kb"],
    ])("%s", (_, val) => {
        expect(() => relPath("k", val)).not.toThrow();
    });
});

// go: Test_frontMatter_tabular
describe("frontMatter", () => {
    it.each([
        ["block", "---\na: 1\n---\nbody\n", "a: 1\n"],
        ["closed at end of file", "---\na: 1\n---", "a: 1\n"],
        ["empty block", "---\n---\nbody\n", ""],
        ["crlf", "---\r\na: 1\r\n---\r\nbody\r\n", "a: 1\n"],
        ["bom", "﻿---\na: 1\n---\n", "a: 1\n"],
    ])("%s", (_, text, want) => {
        expect(frontMatter(text)).toBe(want);
    });
});

// go: Test_frontMatter_error_tabular
describe("frontMatter errors", () => {
    it.each([
        ["no front matter", "# Title\n", "no front matter"],
        ["unclosed", "---\na: 1\n", "front matter is not closed"],
    ])("%s", (_, text, want) => {
        expect(() => frontMatter(text)).toThrow(want);
    });
});

const PRJ = { root: ROOT, server: "srd", port: 7777 };

describe("checkMCPJSON", () => {
    // go: Test_Project_CheckMCPJSON
    it("accepts a matching registration", async () => {
        const fs = new MemDocFs().writeFile(
            `${ROOT}/.mcp.json`,
            '{\n  "mcpServers": {\n    "other": {"type": "stdio", "command": "x"},\n' +
                '    "srd": {"type": "http", "url": "http://localhost:7777/mcp"}\n  }\n}',
        );

        expect(await checkMCPJSON(fs, PRJ)).toBe(true);
    });

    // go: Test_Project_CheckMCPJSON_absent
    it("reports an absent .mcp.json", async () => {
        expect(await checkMCPJSON(new MemDocFs(), PRJ)).toBe(false);
    });

    // go: Test_Project_CheckMCPJSON_error_tabular
    it.each([
        ["malformed", "{", /parse \.mcp\.json: unexpected end/],
        [
            "no entry",
            '{"mcpServers": {"other": {"url": "http://localhost:7777/mcp"}}}',
            /\.mcp\.json has no server "srd" named by mcp-server/,
        ],
        [
            "port differs",
            '{"mcpServers": {"srd": {"url": "http://localhost:7778/mcp"}}}',
            /server "srd" URL http:\/\/localhost:7778\/mcp uses port 7778, but mcp-port is 7777/,
        ],
        [
            "default port differs",
            '{"mcpServers": {"srd": {"url": "http://localhost/mcp"}}}',
            /uses port 80, but mcp-port is 7777/,
        ],
        [
            "no url",
            '{"mcpServers": {"srd": {"type": "stdio"}}}',
            /server "srd": has no url/,
        ],
    ])("refuses %s", async (_, json, want) => {
        const fs = new MemDocFs().writeFile(`${ROOT}/.mcp.json`, json);

        await expect(checkMCPJSON(fs, PRJ)).rejects.toThrow(want);
    });

    it("reports a read failure", async () => {
        const fs = new MemDocFs()
            .writeFile(`${ROOT}/.mcp.json`, "{}")
            .failOn("readText", `${ROOT}/.mcp.json`);

        await expect(checkMCPJSON(fs, PRJ)).rejects.toThrow(
            /^read \.mcp\.json: open /,
        );
    });
});

// go: Test_urlPort_tabular
describe("urlPort", () => {
    it.each([
        ["explicit", "http://localhost:7777/mcp", 7777],
        ["http default", "http://localhost/mcp", 80],
        ["https default", "https://docs.example/mcp", 443],
    ])("%s", (_, url, want) => {
        expect(urlPort(url)).toBe(want);
    });
});

// go: Test_urlPort_error_tabular
describe("urlPort errors", () => {
    it.each([
        ["empty", "", "has no url"],
        ["unparsable", "http://[::1", "url: parse"],
        ["unknown scheme", "ws://localhost/mcp", "names no port"],
    ])("%s", (_, url, want) => {
        expect(() => urlPort(url)).toThrow(want);
    });
});

interface GoldenCase {
    name: string;
    file: string;
    content: string;
    dirs: string[];
    files: Record<string, string>;
    mcp_json?: string;
    want: {
        err?: string;
        mcp_found?: boolean;
        mcp_err?: string;
        config?: {
            listen: string;
            sources: Record<string, { dir: string; file: string }> | null;
            gaps: string;
            watch: { enabled: boolean; debounce: number };
            glossary: string;
            precedence: string[] | null;
            initiatives: string;
            kb: string;
            project: { root: string; server: string; port: number } | null;
        };
    };
}

/** Project configs and .mcp.json files with Go's results (oracle `config`). */
const golden = readGolden<GoldenCase[]>(
    new URL("testdata/project.golden.json", import.meta.url),
);

/** SYNTAX_WORDING lists cases whose YAML syntax error wording differs (accepted). */
const SYNTAX_WORDING = new Set(["bad-yaml"]);

describe("loadConfig and checkMCPJSON against Go", () => {
    const G = "/tmp/oracle-config-x";
    const sub = (s: string) => s.replaceAll(G, "$ROOT");

    it.each(golden.map((c) => [c.name, c] as const))(
        "matches Go for %s",
        async (_, c) => {
            const fs = new MemDocFs().mkdirp(G);
            for (const d of c.dirs) fs.mkdirp(`${G}/${d}`);
            for (const [n, t] of Object.entries(c.files))
                fs.writeFile(`${G}/${n}`, t);
            if (c.mcp_json !== undefined)
                fs.writeFile(`${G}/.mcp.json`, c.mcp_json);
            if (c.content !== "\u0000absent")
                fs.writeFile(`${G}/${c.file}`, c.content);

            const have = loadConfig(fs, `${G}/${c.file}`);

            if (c.want.err !== undefined) {
                const err = await have.then(
                    () => new Error("no error"),
                    (e: Error) => e,
                );
                if (SYNTAX_WORDING.has(c.name))
                    expect(err.message).toMatch(/^parse config: yaml: /);
                else expect(sub(err.message)).toBe(c.want.err);
                return;
            }
            const cfg = await have;
            const w = c.want.config as NonNullable<
                GoldenCase["want"]["config"]
            >;
            expect({
                listen: cfg.listen,
                sources: Object.fromEntries(
                    [...cfg.sources].map(([k, v]) => [
                        k,
                        { dir: sub(v.dir), file: v.file },
                    ]),
                ),
                gaps: sub(cfg.gaps),
                watch: {
                    enabled: cfg.watch.enabled,
                    debounce: Number(cfg.watch.debounce),
                },
                glossary: cfg.glossary,
                precedence: cfg.precedence,
                initiatives: cfg.initiatives,
                kb: sub(cfg.kb),
                project: cfg.project && {
                    ...cfg.project,
                    root: sub(cfg.project.root),
                },
            }).toEqual({
                ...w,
                sources: w.sources ?? {},
                precedence: w.precedence ?? [],
            });
            if (cfg.project === null) return;
            const mcp = await checkMCPJSON(fs, cfg.project).then(
                (found) => ({ found, err: undefined as string | undefined }),
                (e: Error) => ({ found: false, err: sub(e.message) }),
            );
            expect(mcp).toEqual({
                found: c.want.mcp_found,
                err: c.want.mcp_err,
            });
        },
    );
});
