// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The settings tab's "synced locations": the pages, folders, and spaces maps
// shown as one list, plus what the add/edit dialog needs — the kind a pasted
// Confluence link names, a proposed vault path, and a check of the entry before
// it is saved, and the matching behind the vault path type-ahead. Pure — no Obsidian runtime — so it unit-tests directly.

import {
    type docketSettings,
    folderID,
    spaceLinkKey,
    tryPageID,
    validateDest,
    validateRoot,
} from "@docket/core";
import { normalizeConfluenceSource } from "./source.ts";

/** LocationKind is which sync map a location lives in. */
export type LocationKind = "page" | "folder" | "space";

/** Location is one synced location: a vault destination and its source. */
export interface Location {
    kind: LocationKind;
    /** The vault path, relative to the sync root. */
    dest: string;
    /** The Confluence source, a `/wiki/...` path. */
    src: string;
}

/** MAP names the settings map each kind is stored in. */
const MAP = { page: "pages", folder: "folders", space: "spaces" } as const;

/** KIND_LABEL is each kind's user-facing name. */
export const KIND_LABEL: Record<LocationKind, string> = {
    page: "Page",
    folder: "Folder",
    space: "Space",
};

/** locations lists every synced location: pages, then folders, then spaces. */
export function locations(s: docketSettings): Location[] {
    const out: Location[] = [];
    for (const kind of ["page", "folder", "space"] as const) {
        const map = s[MAP[kind]];
        for (const dest of Object.keys(map).sort()) {
            out.push({ kind, dest, src: map[dest] ?? "" });
        }
    }
    return out;
}

/**
 * detectKind tells which kind of location a Confluence link names — a page,
 * a folder, or a space root — or null when its shape is none of them.
 */
export function detectKind(src: string): LocationKind | null {
    const path = normalizeConfluenceSource(src);
    if (tryPageID(path) !== undefined) return "page";
    if (succeeds(() => folderID(path))) return "folder";
    if (succeeds(() => spaceLinkKey(path))) return "space";
    return null;
}

/** UNSAFE matches characters that cannot appear in a vault file name. */
const UNSAFE = /[\\/:*?"<>|#^[\]]/g;

/** safeName turns a title into a vault file or folder name. */
export function safeName(title: string): string {
    return title.replace(UNSAFE, "-").trim();
}

/**
 * titleDest is the vault path a fetched title proposes: `<title>.md` for a
 * page, `<title>` for a folder or space; empty for an empty title.
 */
export function titleDest(kind: LocationKind, title: string): string {
    const name = safeName(title);
    if (name === "") return "";
    return kind === "page" ? `${name}.md` : name;
}

/**
 * suggestDest proposes a vault path for a link, from what the link itself
 * carries: a page's title slug (`My-Page.md`, else `page-<id>.md`), a folder's
 * id (`folder-<id>`), or a space's key. It is empty when it cannot tell.
 */
export function suggestDest(kind: LocationKind, src: string): string {
    const path = normalizeConfluenceSource(src);
    if (kind === "page") {
        const id = tryPageID(path);
        if (id === undefined) return "";
        const segs = path.split("/");
        const slug = segs[segs.indexOf(id) + 1] ?? "";
        const title = safeName(safeDecode(slug.replace(/\+/g, " ")));
        return title === "" ? `page-${id}.md` : `${title}.md`;
    }
    if (kind === "folder") {
        try {
            return `folder-${folderID(path)}`;
        } catch {
            return "";
        }
    }
    try {
        return spaceLinkKey(path);
    } catch {
        return "";
    }
}

/**
 * checkLocation returns why `next` cannot be saved, or `""` when it can: an
 * empty field, an invalid destination for its kind, a link of another kind, or
 * a destination another location already uses. `prev` is the entry being edited
 * (null when adding), which may keep its own destination.
 */
export function checkLocation(
    s: docketSettings,
    next: Location,
    prev: Location | null,
): string {
    if (next.src === "") return "Paste a Confluence link.";
    if (next.dest === "") return "Choose where in the vault it goes.";
    const shape = detectKind(next.src);
    if (shape !== null && shape !== next.kind) {
        return `This link is a ${KIND_LABEL[shape].toLowerCase()}, not a ${KIND_LABEL[next.kind].toLowerCase()}.`;
    }
    try {
        if (next.kind === "page") validateDest(next.dest);
        else validateRoot(next.dest);
    } catch (err) {
        return (err instanceof Error ? err.message : String(err)).replace(
            /^config: /,
            "",
        );
    }
    const taken = locations(s).some(
        (l) =>
            l.dest === next.dest &&
            !(prev !== null && l.kind === prev.kind && l.dest === prev.dest),
    );
    return taken ? `${next.dest} is already a synced location.` : "";
}

/**
 * putLocation returns `s` with `prev` (when editing) removed and `next` stored
 * in its kind's map; the other maps are copied unchanged.
 */
export function putLocation(
    s: docketSettings,
    next: Location,
    prev: Location | null,
): docketSettings {
    const out = removeLocation(s, prev);
    const key = MAP[next.kind];
    return { ...out, [key]: { ...out[key], [next.dest]: next.src } };
}

/** removeLocation returns `s` without location `l` (unchanged for null). */
export function removeLocation(
    s: docketSettings,
    l: Location | null,
): docketSettings {
    if (l === null) return s;
    const key = MAP[l.kind];
    const map = { ...s[key] };
    delete map[l.dest];
    return { ...s, [key]: map };
}

/**
 * errorDest picks the destination a config error names (its first quoted
 * value), so the settings tab can mark that row; `""` when it names none.
 */
export function errorDest(msg: string): string {
    return msg.match(/"([^"]+)"/)?.[1] ?? "";
}

function succeeds(fn: () => unknown): boolean {
    try {
        fn();
        return true;
    } catch {
        return false;
    }
}

function safeDecode(s: string): string {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

/** SUGGEST_LIMIT caps how many suggestions show at once. */
const SUGGEST_LIMIT = 30;

/**
 * matchPaths filters `paths` (vault paths) to those under `base` that contain
 * `query` (case-insensitive), returned relative to `base`, shortest first.
 */
export function matchPaths(
    paths: string[],
    base: string,
    query: string,
): string[] {
    const root =
        base === "" || base === "." ? "" : `${base.replace(/\/+$/, "")}/`;
    const q = query.trim().toLowerCase();
    return paths
        .filter((p) => p.startsWith(root) && p.length > root.length)
        .map((p) => p.slice(root.length))
        .filter((p) => p.toLowerCase().includes(q))
        .sort((a, b) => a.length - b.length || a.localeCompare(b))
        .slice(0, SUGGEST_LIMIT);
}
