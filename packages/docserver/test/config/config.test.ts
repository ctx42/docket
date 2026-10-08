// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    type Config,
    emptyConfig,
    loadYaml,
    relIn,
    type SourceConfig,
    validate,
    type WatchConfig,
} from "../../src/config/config.ts";
import { MILLISECOND, SECOND } from "../../src/gocompat/duration.ts";
import { readGolden } from "../support/golden.ts";
import { MemDocFs } from "../support/mem-doc-fs.ts";

/** ROOT is the directory holding the test configs. */
const ROOT = "/tmp/cfg";

/** load writes content to ROOT/config.yaml and loads it. */
function load(content: string): Promise<Config> {
    const fs = new MemDocFs().writeFile(`${ROOT}/config.yaml`, content);
    return loadYaml(fs, `${ROOT}/config.yaml`);
}

/** loadError returns what loading content throws. */
async function loadError(content: string): Promise<Error> {
    try {
        await load(content);
    } catch (err) {
        return err as Error;
    }
    throw new Error("load did not throw");
}

const SRC = "sources:\n  docs:\n    dir: /srv/doc\n";

describe("loadYaml", () => {
    // go: Test_Load
    it("loads listen and sources", async () => {
        const have = await load(
            'listen: ":7777"\nsources:\n  shop-docs:\n    dir: /srv/doc\n  notes:\n    file: /srv/notes/arch.md\n',
        );

        expect(have.listen).toBe(":7777");
        expect(have.sources.size).toBe(2);
        expect(have.sources.get("shop-docs")?.dir).toBe("/srv/doc");
        expect(have.sources.get("notes")?.file).toBe("/srv/notes/arch.md");
    });

    // go: Test_Load_resolves_relative_paths_against_config_dir
    it("resolves relative paths against the config dir", async () => {
        const have = await load(
            "sources:\n  docs:\n    dir: corpus/docs\n  notes:\n    file: ../notes/arch.md\n",
        );

        expect(have.sources.get("docs")?.dir).toBe(`${ROOT}/corpus/docs`);
        expect(have.sources.get("notes")?.file).toBe("/tmp/notes/arch.md");
    });

    // go: Test_Load_keeps_absolute_paths
    it("keeps absolute paths", async () => {
        const have = await load(
            "sources:\n  docs:\n    dir: /srv/doc\n  notes:\n    file: /srv/notes/arch.md\n",
        );

        expect(have.sources.get("docs")?.dir).toBe("/srv/doc");
        expect(have.sources.get("notes")?.file).toBe("/srv/notes/arch.md");
    });

    // go: Test_Load_gaps
    it("loads the gaps folder", async () => {
        expect((await load(`${SRC}gaps: /var/lib/docket/gaps\n`)).gaps).toBe(
            "/var/lib/docket/gaps",
        );
    });

    // go: Test_Load_gaps_resolves_relative_against_config_dir
    it("resolves a relative gaps folder", async () => {
        expect((await load(`${SRC}gaps: state/gaps\n`)).gaps).toBe(
            `${ROOT}/state/gaps`,
        );
    });

    // go: Test_Load_gaps_optional
    it("leaves gaps empty when unset", async () => {
        expect((await load(SRC)).gaps).toBe("");
    });

    // go: Test_Load_error_gaps_inside_source_dir
    it("refuses gaps inside a source dir", async () => {
        const have = await loadError(`${SRC}gaps: /srv/doc/gaps\n`);

        expect(have.message).toContain(
            'gaps folder "/srv/doc/gaps" is inside source "docs"',
        );
    });

    // go: Test_Load_error_gaps_equals_source_file
    it("refuses gaps equal to a source file", async () => {
        const have = await loadError(
            "sources:\n  notes:\n    file: /srv/notes.md\ngaps: /srv/notes.md\n",
        );

        expect(have.message).toContain(
            'gaps folder "/srv/notes.md" is source file "notes"',
        );
    });

    // go: Test_Load_error_source_inside_gaps_folder_tabular
    it.each([
        ["dir", "dir: /srv/gaps/docs", 'source "docs" lies inside'],
        ["file", "file: /srv/gaps/a.md", 'source "docs" lies inside'],
        ["same dir", "dir: /srv/gaps", 'gaps folder "/srv/gaps" is inside'],
    ])("refuses a source inside gaps: %s", async (_, source, want) => {
        const have = await loadError(
            `sources:\n  docs:\n    ${source}\ngaps: /srv/gaps\n`,
        );

        expect(have.message).toContain(want);
    });

    // go: Test_Load_gaps_beside_source_dir
    it("accepts gaps beside a source dir", async () => {
        expect((await load(`${SRC}gaps: /srv/docs\n`)).gaps).toBe("/srv/docs");
    });

    // go: Test_Load_listen_optional
    it("leaves listen empty when unset", async () => {
        expect((await load(SRC)).listen).toBe("");
    });

    // go: Test_Load_watch_tabular
    it.each([
        ["absent", "", { enabled: false, debounce: 500n * MILLISECOND }],
        [
            "enabled only",
            "watch:\n  enabled: true\n",
            { enabled: true, debounce: 500n * MILLISECOND },
        ],
        [
            "explicit debounce",
            "watch:\n  enabled: true\n  debounce: 2s\n",
            { enabled: true, debounce: 2n * SECOND },
        ],
        [
            "debounce while disabled",
            "watch:\n  enabled: false\n  debounce: 1500ms\n",
            { enabled: false, debounce: 1500n * MILLISECOND },
        ],
    ])("reads watch settings: %s", async (_, yaml, want: WatchConfig) => {
        expect((await load(SRC + yaml)).watch).toEqual(want);
    });

    // go: Test_Load_error_missing_file
    it("fails on a missing file", async () => {
        const have = loadYaml(new MemDocFs(), `${ROOT}/no.yaml`);

        await expect(have).rejects.toThrow("read config");
    });

    // go: Test_Load_error_bad_yaml
    it("fails on malformed YAML", async () => {
        expect((await loadError("listen: [")).message).toMatch(
            /^parse config: yaml: .*did not find expected/,
        );
    });

    // go: Test_Load_error_unknown_field
    it("refuses an unknown field", async () => {
        expect((await loadError(`listne: ":7777"\n${SRC}`)).message).toContain(
            "field listne not found",
        );
    });

    // go: Test_Load_error_multiple_documents
    it("refuses a second document", async () => {
        const have = await loadError(`${SRC}---\nwatch:\n  enabled: true\n`);

        expect(have.message).toContain(
            "parse config: more than one YAML document",
        );
    });

    // go: Test_Load_error_duplicate_source_name
    it("refuses a duplicate source name", async () => {
        const have = await loadError(
            "sources:\n  docs:\n    dir: /srv/a\n  docs:\n    dir: /srv/b\n",
        );

        expect(have.message).toContain('"docs" already defined');
    });

    // go: Test_Load_error_validation_tabular
    it.each([
        ["missing sources", 'listen: ":7777"\n', /sources.*cannot be blank/],
        ["empty sources", "sources: {}\n", /sources.*cannot be blank/],
        ["empty file", "", /sources.*cannot be blank/],
        [
            "both dir and file",
            "sources:\n  a:\n    dir: /x\n    file: /y.md\n",
            /exactly one of dir or file/,
        ],
        [
            "neither dir nor file",
            "sources:\n  a: {}\n",
            /sources\.a: cannot be blank/,
        ],
        [
            "source name with slash",
            "sources:\n  a/b:\n    dir: /x\n",
            /source name "a\/b" must match/,
        ],
        [
            "source name with space",
            'sources:\n  "a b":\n    dir: /x\n',
            /source name "a b" must match/,
        ],
        [
            "source name dot",
            'sources:\n  ".":\n    dir: /x\n',
            /source name "\." must match/,
        ],
        [
            "source name dot dot",
            'sources:\n  "..":\n    dir: /x\n',
            /source name "\.\." must match/,
        ],
        [
            "file without md suffix",
            "sources:\n  a:\n    file: /x.txt\n",
            /file must be a Markdown/,
        ],
        [
            "zero debounce",
            "sources:\n  a:\n    dir: /x\nwatch:\n  debounce: 0s\n",
            /watch: debounce must be positive/,
        ],
        [
            "negative debounce",
            "sources:\n  a:\n    dir: /x\nwatch:\n  debounce: -1s\n",
            /watch: debounce must be positive/,
        ],
        [
            "debounce over limit",
            "sources:\n  a:\n    dir: /x\nwatch:\n  debounce: 2m\n",
            /watch: debounce must not exceed 1m0s/,
        ],
    ])("refuses an invalid config: %s", async (_, yaml, want) => {
        expect((await loadError(yaml)).message).toMatch(want);
    });
});

// go: Test_relIn_tabular
describe("relIn", () => {
    it.each([
        ["equal", "/a/b", ".", true],
        ["child", "/a/b/c/d", "c/d", true],
        ["unclean child", "/a/b/c/../d", "d", true],
        ["sibling prefix", "/a/bc", "", false],
        ["parent", "/a", "", false],
        ["outside", "/x/y", "", false],
        ["relative against absolute", "a/b", "", false],
    ])("%s", (_, path, wRel, wOK) => {
        expect(relIn(path, "/a/b")).toEqual([wRel, wOK]);
    });
});

describe("validate", () => {
    // go: Test_Config_validate_collects_failure_per_source
    it("collects a failure per source", () => {
        const cfg = emptyConfig();
        cfg.sources = new Map<string, SourceConfig>([
            ["a", { dir: "/x", file: "/y.md" }],
            ["b", { dir: "", file: "" }],
        ]);

        const have = validate(cfg);

        expect(have).toContain("exactly one of dir or file");
        expect(have).toContain("b: cannot be blank");
    });
});

interface GoldenCase {
    name: string;
    file: string;
    content: string;
    want: {
        err?: string;
        config?: {
            listen: string;
            sources: Record<string, SourceConfig> | null;
            gaps: string;
            watch: { enabled: boolean; debounce: number };
        };
    };
}

/** Plain YAML configs and what Go's config.Load made of them. */
const golden = readGolden<GoldenCase[]>(
    new URL("testdata/config.golden.json", import.meta.url),
);

/**
 * SYNTAX_WORDING lists cases whose YAML syntax error the `yaml` parser words
 * differently from yaml.v3 (an accepted difference): only the prefix must
 * match.
 */
const SYNTAX_WORDING = new Set(["bad-yaml", "tab"]);

describe("loadYaml against Go config.Load", () => {
    it.each(golden.map((c) => [c.name, c] as const))(
        "matches Go for %s",
        async (_, c) => {
            const fs = new MemDocFs().mkdirp("/tmp/oracle-config-x");
            if (c.content !== "\u0000absent")
                fs.writeFile(`/tmp/oracle-config-x/${c.file}`, c.content);
            const sub = (s: string) =>
                s.replaceAll("/tmp/oracle-config-x", "$ROOT");

            const have = loadYaml(fs, `/tmp/oracle-config-x/${c.file}`);

            if (c.want.err !== undefined) {
                const err = await have.then(
                    () => new Error("no error"),
                    (e: Error) => e,
                );
                if (SYNTAX_WORDING.has(c.name)) {
                    expect(sub(err.message)).toMatch(/^parse config: yaml: /);
                } else {
                    expect(sub(err.message)).toBe(c.want.err);
                }
                return;
            }
            const cfg = await have;
            const want = c.want.config as NonNullable<
                GoldenCase["want"]["config"]
            >;
            expect(cfg.listen).toBe(want.listen);
            expect(
                Object.fromEntries(
                    [...cfg.sources].map(([k, v]) => [
                        k,
                        { dir: sub(v.dir), file: sub(v.file) },
                    ]),
                ),
            ).toEqual(want.sources ?? {});
            expect(sub(cfg.gaps)).toBe(want.gaps);
            expect(cfg.watch).toEqual({
                enabled: want.watch.enabled,
                debounce: BigInt(want.watch.debounce),
            });
        },
    );
});
