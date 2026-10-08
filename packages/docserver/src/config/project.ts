// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The project-config.md loader ported from Go `pkg/config/project.go`: the
// flat front matter of a note shared with other tools (decoded leniently)
// mapped onto a {@link Config}, with every path relative to the note's
// directory, plus the check that the project's .mcp.json registers the
// server on the configured port.

import { isAbsPosix, posixClean, posixDir, posixJoin } from "@docket/core";

import type { Duration } from "../gocompat/duration.ts";
import { goJSONSyntaxError } from "../gocompat/jsonscan.ts";
import { goQuote } from "../gocompat/strconv.ts";
import { goURLPort, parseGoURL } from "../gocompat/url.ts";
import { type DocFs, isNotExist } from "../ports.ts";
import { compareBytes } from "../search/bm25.ts";
import {
    type Decoded,
    decodeInto,
    type Schema,
    YamlDecodeError,
} from "../yamlv3/decode.ts";
import { parseYaml, YamlValueError } from "../yamlv3/node.ts";
import {
    type Config,
    ConfigError,
    DEFAULT_DEBOUNCE,
    emptyConfig,
    loadYaml,
    type Project,
    relIn,
    resolvePath,
    SOURCE_NAME_RE,
    underDir,
    validate,
    validateGaps,
} from "./config.ts";

/** MCP_JSON is the Claude Code project MCP registry beside the note. */
export const MCP_JSON = ".mcp.json";

const LIST: Schema = { kind: "list", of: { kind: "string" }, type: "[]string" };

const PROJECT_SCHEMA = {
    kind: "struct",
    type: "config.projectFile",
    fields: {
        "mcp-server": { kind: "string" },
        "mcp-port": { kind: "int" },
        sources: LIST,
        gaps: { kind: "string" },
        watch: { kind: "bool" },
        "watch-debounce": { kind: "ptr", of: { kind: "duration" } },
        glossary: { kind: "string" },
        precedence: LIST,
        kb: { kind: "string" },
        initiatives: { kind: "string" },
        "srd-standard": { kind: "string" },
    },
} as const satisfies Schema;

/** ProjectFile is the decoded front matter of a project-config.md. */
interface ProjectFile {
    mcpServer: string;
    mcpPort: number;
    sources: string[];
    gaps: string;
    watch: boolean;
    watchDebounce: Duration | null;
    glossary: string;
    precedence: string[];
    kb: string;
    initiatives: string;
    srdStandard: string;
}

/**
 * loadConfig loads the config at the absolute path: a project-config.md note
 * when it ends in ".md", else a plain YAML file.
 */
export function loadConfig(fs: DocFs, path: string): Promise<Config> {
    return path.endsWith(".md") ? loadProject(fs, path) : loadYaml(fs, path);
}

/**
 * loadProject loads the project-config.md note at the absolute path: one dir
 * source per sources entry, named after it and rooted at that folder of the
 * project root (the note's directory).
 */
export async function loadProject(fs: DocFs, path: string): Promise<Config> {
    let raw: string;
    try {
        raw = await fs.readText(path);
    } catch (err) {
        throw new ConfigError(`read config: ${(err as Error).message}`, {
            cause: err,
        });
    }
    const pf: Decoded = {
        "mcp-server": "",
        "mcp-port": 0,
        sources: null,
        gaps: "",
        watch: false,
        "watch-debounce": null,
        glossary: "",
        precedence: null,
        kb: "",
        initiatives: "",
        "srd-standard": "",
    };
    let front: string;
    try {
        front = frontMatter(raw);
    } catch (err) {
        throw new ConfigError(`parse config: ${(err as Error).message}`, {
            cause: err,
        });
    }
    try {
        const root = parseYaml(front);
        if (root !== undefined) decodeInto(root, PROJECT_SCHEMA, pf);
    } catch (err) {
        const msg = (err as Error).message;
        const text =
            err instanceof YamlDecodeError || err instanceof YamlValueError
                ? msg
                : `yaml: ${msg}`;
        throw new ConfigError(`parse config: ${text}`, { cause: err });
    }
    const file: ProjectFile = {
        mcpServer: pf["mcp-server"] as string,
        mcpPort: pf["mcp-port"] as number,
        sources: (pf["sources"] as string[] | null) ?? [],
        gaps: pf["gaps"] as string,
        watch: pf["watch"] as boolean,
        watchDebounce: pf["watch-debounce"] as Duration | null,
        glossary: pf["glossary"] as string,
        precedence: (pf["precedence"] as string[] | null) ?? [],
        kb: pf["kb"] as string,
        initiatives: pf["initiatives"] as string,
        srdStandard: pf["srd-standard"] as string,
    };
    try {
        return await projectConfig(fs, file, posixClean(posixDir(path)));
    } catch (err) {
        throw new ConfigError(`validate config: ${(err as Error).message}`, {
            cause: err,
        });
    }
}

/** projectConfig validates the front matter and maps it to a config. */
async function projectConfig(
    fs: DocFs,
    pf: ProjectFile,
    root: string,
): Promise<Config> {
    if (pf.mcpServer.trim() === "") throw new Error("mcp-server is required");
    if (pf.mcpPort < 1 || pf.mcpPort > 65535) {
        throw new Error(
            `mcp-port must be between 1 and 65535, have ${pf.mcpPort}`,
        );
    }
    for (const [key, val] of [
        ["gaps", pf.gaps],
        ["glossary", pf.glossary],
        ["kb", pf.kb],
        ["initiatives", pf.initiatives],
        ["srd-standard", pf.srdStandard],
    ] as const) {
        relPath(key, val);
    }
    for (const entry of pf.precedence) relPath("precedence", entry);

    const cfg = emptyConfig();
    cfg.listen = `:${pf.mcpPort}`;
    cfg.gaps = resolvePath(root, pf.gaps);
    cfg.kb = resolvePath(root, pf.kb);
    cfg.watch = {
        enabled: pf.watch,
        debounce: pf.watchDebounce ?? DEFAULT_DEBOUNCE,
    };
    cfg.project = { root, server: pf.mcpServer, port: pf.mcpPort };
    await addSources(fs, pf.sources, cfg, root);
    const invalid = validate(cfg) ?? validateGaps(cfg);
    if (invalid !== undefined) throw new Error(invalid);
    cfg.glossary = await glossaryPath(fs, cfg, resolvePath(root, pf.glossary));
    const inits = resolvePath(root, pf.initiatives);
    cfg.initiatives = docPath(cfg, inits)[0];
    cfg.precedence = await precedence(fs, pf.precedence, cfg, root, inits);
    return cfg;
}

/**
 * addSources adds a dir source per sources entry, each an existing
 * top-level folder of root named after the entry.
 */
async function addSources(
    fs: DocFs,
    entries: readonly string[],
    cfg: Config,
    root: string,
): Promise<void> {
    for (const entry of entries) {
        relPath("sources", entry);
        const name = posixClean(entry);
        if (!SOURCE_NAME_RE.test(name)) {
            throw new Error(
                `sources entry ${goQuote(entry)} must be a top-level folder name matching ${SOURCE_NAME_RE.source}`,
            );
        }
        if (cfg.sources.has(name))
            throw new Error(`sources entry ${goQuote(entry)} is listed twice`);
        const dir = posixJoin(root, name);
        await requireDir(fs, dir, `sources entry ${goQuote(entry)}`);
        cfg.sources.set(name, { dir, file: "" });
    }
}

/** requireDir checks dir exists and is a directory; what names it in errors. */
async function requireDir(fs: DocFs, dir: string, what: string): Promise<void> {
    let isDir: boolean;
    try {
        isDir = (await fs.stat(dir)).isDir;
    } catch (err) {
        throw new Error(`${what}: ${(err as Error).message}`, { cause: err });
    }
    if (!isDir) throw new Error(`${what} is not a directory`);
}

/**
 * precedence returns the document-path prefixes of the precedence entries,
 * in order: each an existing folder inside a dir source, listed once and
 * not inside the initiatives folder.
 */
async function precedence(
    fs: DocFs,
    entries: readonly string[],
    cfg: Config,
    root: string,
    inits: string,
): Promise<string[]> {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
        const abs = posixJoin(root, entry);
        if (seen.has(abs))
            throw new Error(
                `precedence entry ${goQuote(entry)} is listed twice`,
            );
        seen.add(abs);
        await requireDir(fs, abs, `precedence entry ${goQuote(entry)}`);
        if (inits !== "" && underDir(abs, inits)) {
            throw new Error(
                `precedence entry ${goQuote(entry)} is inside initiatives`,
            );
        }
        const [pfx, ok] = docPath(cfg, abs);
        if (!ok)
            throw new Error(
                `precedence entry ${goQuote(entry)} is not inside any source`,
            );
        out.push(pfx);
    }
    return out;
}

/**
 * glossaryPath returns the document path of the glossary at abs ("" when
 * unset): an existing Markdown file or folder inside a dir source.
 */
async function glossaryPath(
    fs: DocFs,
    cfg: Config,
    abs: string,
): Promise<string> {
    if (abs === "") return "";
    let isDir: boolean;
    try {
        isDir = (await fs.stat(abs)).isDir;
    } catch (err) {
        throw new Error(`glossary: ${(err as Error).message}`, { cause: err });
    }
    if (!isDir && !abs.endsWith(".md"))
        throw new Error("glossary must be a Markdown file or a folder");
    const [pth, ok] = docPath(cfg, abs);
    if (!ok)
        throw new Error(`glossary ${goQuote(abs)} is not inside any source`);
    return pth;
}

/**
 * docPath returns the document path of abs when it lies inside a dir source:
 * the source name, then abs relative to the source folder.
 */
export function docPath(cfg: Config, abs: string): [string, boolean] {
    if (abs === "") return ["", false];
    for (const [name, src] of [...cfg.sources].sort((a, b) =>
        compareBytes(a[0], b[0]),
    )) {
        if (src.dir === "") continue;
        const [rel, ok] = relIn(abs, src.dir);
        if (!ok) continue;
        return [rel === "." ? name : `${name}/${rel}`, true];
    }
    return ["", false];
}

/** relPath reports a project path value that is absolute or escapes the root. */
export function relPath(key: string, val: string): void {
    if (val === "") return;
    if (isAbsPosix(val))
        throw new Error(
            `${key} path ${goQuote(val)} must be relative to the project root`,
        );
    const cln = posixClean(val);
    if (cln === ".." || cln.startsWith("../")) {
        throw new Error(`${key} path ${goQuote(val)} escapes the project root`);
    }
}

/**
 * frontMatter returns the YAML between the opening "---" line of text and
 * the next "---" line; it throws when there is none or it is not closed.
 */
export function frontMatter(input: string): string {
    const text = (input.startsWith("﻿") ? input.slice(1) : input).replaceAll(
        "\r\n",
        "\n",
    );
    if (!text.startsWith("---\n")) throw new Error("no front matter");
    const rest = text.slice(4);
    if (rest.startsWith("---\n") || rest === "---") return "";
    let end = rest.indexOf("\n---\n");
    if (end < 0) {
        if (!rest.endsWith("\n---"))
            throw new Error("front matter is not closed");
        end = rest.length - 4;
    }
    return rest.slice(0, end + 1);
}

/**
 * checkMCPJSON confirms the project's .mcp.json registers the server under
 * project.server at a URL on project.port. It returns false when there is no
 * .mcp.json; a file that does not parse, lacks the entry, or names another
 * port is an error naming both sides.
 */
export async function checkMCPJSON(fs: DocFs, prj: Project): Promise<boolean> {
    const path = posixJoin(prj.root, MCP_JSON);
    let raw: string;
    try {
        raw = await fs.readText(path);
    } catch (err) {
        if (isNotExist(err)) return false;
        throw new Error(`read ${MCP_JSON}: ${(err as Error).message}`, {
            cause: err,
        });
    }
    const servers = parseRegistry(raw);
    const url = servers.get(prj.server);
    if (url === undefined) {
        throw new Error(
            `${path} has no server ${goQuote(prj.server)} named by mcp-server`,
        );
    }
    let port: number;
    try {
        port = urlPort(url);
    } catch (err) {
        throw new Error(
            `${path} server ${goQuote(prj.server)}: ${(err as Error).message}`,
            { cause: err },
        );
    }
    if (port !== prj.port) {
        throw new Error(
            `${path} server ${goQuote(prj.server)} URL ${url} uses port ${port}, but mcp-port is ${prj.port}`,
        );
    }
    return true;
}

/** ENTRY_TYPE is how Go prints the server entry struct type. */
const ENTRY_TYPE = 'struct { URL string "json:\\"url\\"" }';

/**
 * parseRegistry decodes .mcp.json as Go's `json.Unmarshal` into the registry
 * struct does: keys matched case-insensitively, unknown keys ignored, later
 * duplicates winning, the first type error reported after decoding.
 */
function parseRegistry(raw: string): Map<string, string> {
    const syntax = goJSONSyntaxError(raw);
    if (syntax !== undefined) throw new Error(`parse ${MCP_JSON}: ${syntax}`);
    const top: unknown = JSON.parse(raw);
    const servers = new Map<string, string>();
    let first: string | undefined;
    const typeErr = (msg: string) => {
        first ??= `parse ${MCP_JSON}: json: ${msg}`;
    };
    if (top !== null && (typeof top !== "object" || Array.isArray(top))) {
        typeErr(
            `cannot unmarshal ${jsonKind(top)} into Go value of type config.mcpRegistry`,
        );
    } else if (top !== null) {
        for (const [key, val] of Object.entries(
            top as Record<string, unknown>,
        )) {
            if (!foldEqual(key, "mcpServers")) continue;
            if (val === null) {
                servers.clear();
                continue;
            }
            if (typeof val !== "object" || Array.isArray(val)) {
                typeErr(
                    `cannot unmarshal ${jsonKind(val)} into Go struct field mcpRegistry.mcpServers of type map[string]${ENTRY_TYPE}`,
                );
                continue;
            }
            for (const [name, entry] of Object.entries(
                val as Record<string, unknown>,
            )) {
                if (entry === null) {
                    servers.set(name, "");
                    continue;
                }
                if (typeof entry !== "object" || Array.isArray(entry)) {
                    typeErr(
                        `cannot unmarshal ${jsonKind(entry)} into Go struct field mcpRegistry.mcpServers of type ${ENTRY_TYPE}`,
                    );
                    continue;
                }
                let url = "";
                for (const [k, v] of Object.entries(
                    entry as Record<string, unknown>,
                )) {
                    if (!foldEqual(k, "url") || v === null) continue;
                    if (typeof v === "string") url = v;
                    else
                        typeErr(
                            `cannot unmarshal ${jsonKind(v)} into Go struct field .mcpServers.url of type string`,
                        );
                }
                servers.set(name, url);
            }
        }
    }
    if (first !== undefined) throw new Error(first);
    return servers;
}

/** jsonKind names a JSON value as Go's UnmarshalTypeError does. */
function jsonKind(v: unknown): string {
    if (Array.isArray(v)) return "array";
    if (typeof v === "boolean") return "bool";
    return typeof v === "object" ? "object" : typeof v;
}

/** foldEqual compares keys as Go's encoding/json field matching does. */
function foldEqual(a: string, b: string): boolean {
    const fold = (s: string) =>
        s.replaceAll("ſ", "s").replaceAll("K", "k").toLowerCase();
    return fold(a) === fold(b);
}

/**
 * urlPort returns the TCP port of the HTTP(S) URL raw, defaulting to the
 * scheme's port.
 */
export function urlPort(raw: string): number {
    if (raw === "") throw new Error("has no url");
    let u: ReturnType<typeof parseGoURL>;
    try {
        u = parseGoURL(raw);
    } catch (err) {
        throw new Error(`url: ${(err as Error).message}`, { cause: err });
    }
    const p = goURLPort(u);
    if (p !== "") {
        const n = BigInt(p);
        if (n > 9223372036854775807n) {
            throw new Error(
                `strconv.Atoi: parsing ${goQuote(p)}: value out of range`,
            );
        }
        return Number(n);
    }
    if (u.scheme === "http") return 80;
    if (u.scheme === "https") return 443;
    throw new Error(`url ${goQuote(raw)} names no port`);
}
