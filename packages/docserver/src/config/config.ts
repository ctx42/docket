// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The server configuration ported from Go `pkg/config/config.go`: a plain
// YAML file decoded strictly (unknown keys and a second document refused),
// validated with the Go server's messages, and resolved against the config
// file's directory. Paths are POSIX; the caller passes an absolute config
// path (the Go server resolves a relative one against its working
// directory).

import {
    isAbsPosix,
    posixClean,
    posixDir,
    posixJoin,
    posixRel,
} from "@docket/core";

import {
    type Duration,
    formatDuration,
    MILLISECOND,
    MINUTE,
} from "../gocompat/duration.ts";
import { goQuote } from "../gocompat/strconv.ts";
import type { DocFs } from "../ports.ts";
import { compareBytes } from "../search/bm25.ts";
import { type Decoded, decodeInto, type Schema } from "../yamlv3/decode.ts";
import { parseYamlStream } from "../yamlv3/node.ts";

/** NAME matches a valid source name (Go `nameRe`). */
export const SOURCE_NAME_RE = /^[A-Za-z0-9._-]*[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** DEFAULT_DEBOUNCE is the watch debounce when the config sets none. */
export const DEFAULT_DEBOUNCE: Duration = 500n * MILLISECOND;

/** MAX_DEBOUNCE caps the watch debounce. */
export const MAX_DEBOUNCE: Duration = MINUTE;

/**
 * SourceConfig is one named document source (Go `config.Source`): exactly
 * one of dir or file.
 */
export interface SourceConfig {
    dir: string;
    file: string;
}

/**
 * WatchConfig (Go `config.Watch`) configures rebuilding the index when
 * sources change.
 */
export interface WatchConfig {
    enabled: boolean;
    /** debounce is the quiet period before a rebuild. */
    debounce: Duration;
}

/** Project describes the project-config.md a config came from. */
export interface Project {
    /** root is the absolute project root, the note's directory. */
    root: string;
    /** server is the name registered in .mcp.json. */
    server: string;
    port: number;
}

/** Config is a deployed server's configuration. */
export interface Config {
    /** listen is the HTTP address, e.g. ":7777"; "" for stdio. */
    listen: string;
    /** sources are keyed by the name prefixing their document paths. */
    sources: Map<string, SourceConfig>;
    /** gaps is the gap folder; "" disables the gap channel. */
    gaps: string;
    watch: WatchConfig;
    /** glossary is the glossary's document path or prefix (projects only). */
    glossary: string;
    /** precedence lists trust-ranked path prefixes (projects only). */
    precedence: string[];
    /** initiatives is the unranked path prefix (projects only). */
    initiatives: string;
    /** kb is the resolved knowledge-base folder (projects only). */
    kb: string;
    /** project is set for a project-config.md. */
    project: Project | null;
}

/** ConfigError is a load failure; its message is the Go server's. */
export class ConfigError extends Error {
    constructor(message: string, options?: { cause: unknown }) {
        super(message, options);
        this.name = "ConfigError";
    }
}

/** emptyConfig returns a config with Go's zero values and default debounce. */
export function emptyConfig(): Config {
    return {
        listen: "",
        sources: new Map(),
        gaps: "",
        watch: { enabled: false, debounce: DEFAULT_DEBOUNCE },
        glossary: "",
        precedence: [],
        initiatives: "",
        kb: "",
        project: null,
    };
}

const SOURCE_SCHEMA: Schema = {
    kind: "struct",
    type: "config.Source",
    fields: { dir: { kind: "string" }, file: { kind: "string" } },
};

const CONFIG_SCHEMA = {
    kind: "struct",
    type: "config.Config",
    fields: {
        listen: { kind: "string" },
        sources: {
            kind: "map",
            of: SOURCE_SCHEMA,
            type: "map[string]config.Source",
            zero: () => ({ dir: "", file: "" }),
        },
        gaps: { kind: "string" },
        watch: {
            kind: "struct",
            type: "config.Watch",
            fields: {
                enabled: { kind: "bool" },
                debounce: { kind: "duration" },
            },
        },
    },
} as const satisfies Schema;

/**
 * loadYaml reads, parses, validates and resolves the plain YAML config at
 * the absolute path. Relative source and gap paths anchor to the config
 * file's directory.
 */
export async function loadYaml(fs: DocFs, path: string): Promise<Config> {
    let raw: string;
    try {
        raw = await fs.readText(path);
    } catch (err) {
        throw new ConfigError(`read config: ${(err as Error).message}`, {
            cause: err,
        });
    }
    const cfg = emptyConfig();
    let stream: ReturnType<typeof parseYamlStream>;
    try {
        stream = parseYamlStream(raw);
        if (stream.root !== undefined) {
            const target: Decoded = {
                listen: cfg.listen,
                sources: null,
                gaps: cfg.gaps,
                watch: { enabled: false, debounce: DEFAULT_DEBOUNCE },
            };
            decodeInto(stream.root, CONFIG_SCHEMA, target, {
                knownFields: true,
            });
            cfg.listen = target["listen"] as string;
            cfg.sources =
                (target["sources"] as Map<string, SourceConfig> | null) ??
                new Map();
            cfg.gaps = target["gaps"] as string;
            cfg.watch = target["watch"] as WatchConfig;
        }
    } catch (err) {
        throw new ConfigError(
            `parse config: yaml: ${(err as Error).message.replace(/^yaml: /, "")}`,
            {
                cause: err,
            },
        );
    }
    if (stream.documents > 1) {
        throw new ConfigError("parse config: more than one YAML document");
    }
    const invalid = validate(cfg);
    if (invalid !== undefined)
        throw new ConfigError(`validate config: ${invalid}`);
    const base = posixClean(posixDir(path));
    for (const [name, src] of cfg.sources) {
        cfg.sources.set(name, {
            dir: resolvePath(base, src.dir),
            file: resolvePath(base, src.file),
        });
    }
    cfg.gaps = resolvePath(base, cfg.gaps);
    const gapsInvalid = validateGaps(cfg);
    if (gapsInvalid !== undefined)
        throw new ConfigError(`validate config: ${gapsInvalid}`);
    return cfg;
}

/**
 * resolvePath returns p unchanged when empty or absolute, else p joined onto
 * base (and cleaned).
 */
export function resolvePath(base: string, p: string): string {
    if (p === "" || isAbsPosix(p)) return p;
    return posixJoin(base, p);
}

/**
 * relIn returns path relative to dir ("." when equal) and whether the
 * cleaned path lies within dir or equals it.
 */
export function relIn(path: string, dir: string): [string, boolean] {
    if (isAbsPosix(path) !== isAbsPosix(dir)) return ["", false];
    const rel = posixRel(posixClean(dir), posixClean(path));
    if (rel === ".." || rel.startsWith("../")) return ["", false];
    return [rel, true];
}

/** underDir reports whether path lies within dir or equals it. */
export function underDir(path: string, dir: string): boolean {
    return relIn(path, dir)[1];
}

/** sortedSources returns the sources by name (Go iterates its map). */
function sortedSources(cfg: Config): [string, SourceConfig][] {
    return [...cfg.sources].sort((a, b) => compareBytes(a[0], b[0]));
}

/**
 * validate checks the sources (all source failures collected, as verax
 * reports them) and then the watch settings; it returns the message, or
 * undefined when valid.
 */
export function validate(cfg: Config): string | undefined {
    if (cfg.sources.size === 0) return "sources: cannot be blank";
    for (const [name] of sortedSources(cfg)) {
        if (!SOURCE_NAME_RE.test(name)) {
            return `sources: source name ${goQuote(name)} must match ${SOURCE_NAME_RE.source}`;
        }
    }
    const errs: string[] = [];
    for (const [name, src] of sortedSources(cfg)) {
        const msg = validSource(src);
        if (msg !== undefined) errs.push(`sources.${name}: ${msg}`);
    }
    if (errs.length > 0) return errs.join("; ");
    const debounce = cfg.watch.debounce;
    if (debounce <= 0n) return "watch: debounce must be positive";
    if (debounce > MAX_DEBOUNCE) {
        return `watch: debounce must not exceed ${formatDuration(MAX_DEBOUNCE)}`;
    }
    return undefined;
}

/** validSource reports what is wrong with one source, if anything. */
function validSource(src: SourceConfig): string | undefined {
    if (src.dir === "" && src.file === "") return "cannot be blank";
    if (src.dir !== "" && src.file !== "")
        return "must set exactly one of dir or file";
    if (src.file !== "" && !src.file.endsWith(".md")) {
        return "file must be a Markdown (.md) document";
    }
    return undefined;
}

/**
 * validateGaps reports a resolved gap folder mixing with the corpus: inside
 * a dir source, equal to a file source, or holding a source.
 */
export function validateGaps(cfg: Config): string | undefined {
    if (cfg.gaps === "") return undefined;
    const gaps = posixClean(cfg.gaps);
    for (const [name, src] of sortedSources(cfg)) {
        const path = posixClean(src.dir !== "" ? src.dir : src.file);
        if (src.dir !== "" && underDir(gaps, src.dir)) {
            return `gaps folder ${goQuote(gaps)} is inside source ${goQuote(name)}`;
        }
        if (src.file !== "" && path === gaps) {
            return `gaps folder ${goQuote(gaps)} is source file ${goQuote(name)}`;
        }
        if (underDir(path, gaps)) {
            return `source ${goQuote(name)} lies inside gaps folder ${goQuote(gaps)}`;
        }
    }
    return undefined;
}
