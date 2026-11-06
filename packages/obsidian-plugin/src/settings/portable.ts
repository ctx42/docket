// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The portable-config transforms for import and export of a docket config. This
// module is pure — no `obsidian` runtime, no I/O — so it unit-tests under vitest.
// The glue layer (dialogs + settings tab) does the YAML string step and vault I/O
// and calls these to shape the object out and merge the maps back in. Secrets are
// never part of the portable object, matching the keys the CLI/core forbid in the
// shared config.

import {
    type KnowledgeBase,
    posixJoin,
    readKnowledgeBases,
} from "@docket/core";
import type { docketSettings } from "./model.ts";

/**
 * The name an export writes. It is visible in a file manager, unlike the CLI's
 * default `.docket.yaml`, so a CLI user passes `--config` or renames the file.
 */
export const PORTABLE_FILE = "docket.yaml";

/**
 * PortableConfig is the object an export serializes. It carries only the
 * shareable config — the timeout, the Markdown settings, and the three maps —
 * never the Site credentials or the sync root (the CLI/core reject those keys).
 */
export interface PortableConfig {
    /** Per-request HTTP timeout, formatted as a Go-style duration, e.g. `"30s"`. */
    timeout: string;
    markdown: { flavor: string; margin: number };
    /** Whether to pull/push Confluence comments; matches the core's top-level key. */
    comments: boolean;
    pages: Record<string, string>;
    folders: Record<string, string>;
    spaces: Record<string, string>;
    /** The knowledge bases; left out when there are none. */
    knowledge_bases?: PortableKnowledgeBase[];
}

/**
 * PortableKnowledgeBase is a knowledge base as the config lists it: a git
 * entry by name, URL, and branch (no `kind`); a local folder by name and
 * `kind: folder`.
 */
export interface PortableKnowledgeBase {
    name: string;
    /** Set only for a local folder; an entry without it is a git entry. */
    kind?: "folder";
    url?: string;
    /** Left out for the remote's default branch. */
    branch?: string;
}

/**
 * toPortableConfig builds the exportable object from the current settings. The
 * maps are copied (not aliased), and no secret field is ever included.
 */
export function toPortableConfig(settings: docketSettings): PortableConfig {
    return {
        timeout: `${settings.timeoutSeconds}s`,
        markdown: { flavor: settings.flavor, margin: settings.margin },
        comments: settings.comments,
        pages: { ...settings.pages },
        folders: { ...settings.folders },
        spaces: { ...settings.spaces },
        ...(settings.knowledgeBases.length === 0
            ? {}
            : { knowledge_bases: settings.knowledgeBases.map(portableKb) }),
    };
}

/** portableKb shapes a knowledge base for the file, without an empty branch. */
function portableKb(kb: KnowledgeBase): PortableKnowledgeBase {
    if (kb.kind === "folder") return { name: kb.name, kind: "folder" };
    const out: PortableKnowledgeBase = { name: kb.name, url: kb.url };
    if (kb.branch !== "") out.branch = kb.branch;
    return out;
}

/**
 * expandTilde replaces a leading `~` that stands for the current user's home
 * directory — a bare `~`, or `~/…` (and `~\…` on Windows) — with `home`, so a
 * home-relative path the user types resolves to an absolute OS path. Any other
 * leading `~` (e.g. `~other/…`, naming another user's home the plugin cannot
 * resolve) is left as typed. The result is trimmed of surrounding whitespace.
 */
export function expandTilde(input: string, home: string): string {
    const trimmed = input.trim();
    if (trimmed === "~") {
        return home;
    }
    if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
        return home + trimmed.slice(1);
    }
    return trimmed;
}

/**
 * resolvePortablePath resolves the user-entered path to the file to read/write.
 * When `isFolder` (the caller stat'd it) or `input` ends with `/`, the file name
 * is joined onto it; otherwise the trimmed input is used as the file path.
 */
export function resolvePortablePath(input: string, isFolder: boolean): string {
    const trimmed = input.trim();
    if (isFolder || trimmed.endsWith("/")) {
        return posixJoin(trimmed, PORTABLE_FILE);
    }
    return trimmed;
}

/** ImportResult is the merged settings plus what the import applied. */
export interface ImportResult {
    settings: docketSettings;
    /** The count of map entries applied. */
    imported: number;
    /** The count of knowledge bases added. */
    addedKnowledgeBases: number;
    /** The names of knowledge bases kept because the file names a different source. */
    skippedKnowledgeBases: string[];
}

/**
 * applyImportedMaps merges the `pages`/`folders`/`spaces` maps from an arbitrary
 * parsed YAML value into `settings`, returning a new settings object and the count
 * of entries applied. Incoming entries win on a duplicate destination; only
 * string→string entries are kept. A non-object `parsed`, a non-object map, or a
 * non-string value is ignored. Knowledge bases under new names are added; one
 * whose name is taken keeps the existing entry, and is reported as skipped when
 * the file names another kind or URL. flavor, margin, timeout, and the secret fields
 * are left untouched. Never throws.
 */
export function applyImportedMaps(
    settings: docketSettings,
    parsed: unknown,
): ImportResult {
    const obj = isRecord(parsed) ? parsed : {};
    let imported = 0;
    const merge = (
        current: Record<string, string>,
        incoming: unknown,
    ): Record<string, string> => {
        const next = { ...current };
        if (isRecord(incoming)) {
            for (const [dest, src] of Object.entries(incoming)) {
                if (typeof src === "string") {
                    next[dest] = src;
                    imported++;
                }
            }
        }
        return next;
    };
    const kbs = [...settings.knowledgeBases];
    const skipped = new Set<string>();
    let added = 0;
    for (const kb of readKnowledgeBases(obj["knowledge_bases"])) {
        const have = kbs.find((k) => k.name === kb.name);
        if (have === undefined) {
            kbs.push(kb);
            added++;
        } else if (have.kind !== kb.kind || have.url !== kb.url) {
            skipped.add(kb.name);
        }
    }
    return {
        settings: {
            ...settings,
            pages: merge(settings.pages, obj["pages"]),
            folders: merge(settings.folders, obj["folders"]),
            spaces: merge(settings.spaces, obj["spaces"]),
            knowledgeBases: kbs,
        },
        imported,
        addedKnowledgeBases: added,
        skippedKnowledgeBases: [...skipped],
    };
}

/**
 * isPortableConfig reports whether a parsed value looks like a portable config:
 * an object with at least one of the sections an import reads. It tells a config
 * from anything else, such as unrelated text pasted from the clipboard.
 */
export function isPortableConfig(parsed: unknown): boolean {
    return (
        isRecord(parsed) &&
        ["pages", "folders", "spaces", "knowledge_bases"].some(
            (key) => key in parsed,
        )
    );
}

/**
 * importSummary is the notice an import shows: how many mappings and
 * knowledge bases it added from `source`, that added knowledge bases still need
 * cloning, and which existing ones it kept.
 */
export function importSummary(r: ImportResult, source: string): string {
    const plural = (n: number, word: string): string =>
        `${n} ${word}${n === 1 ? "" : "s"}`;
    const n = r.addedKnowledgeBases;
    let out = `docket: imported ${plural(r.imported, "mapping")}`;
    if (n > 0) out += ` and ${plural(n, "knowledge base")}`;
    out += ` from ${source}.`;
    if (n > 0)
        out += ` Clone ${n === 1 ? "it from its card" : "them from their cards"}.`;
    const kept = r.skippedKnowledgeBases;
    if (kept.length > 0) {
        out += ` Kept your ${kept.join(", ")}: the import names a different source for ${kept.length === 1 ? "it" : "them"}.`;
    }
    return out;
}

/** isRecord narrows a value to a plain object (not an array, not null). */
function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
