// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The Confluence card's mapping tree: the synced locations grouped by their
// first vault folder, each row labelled with the page's title (read from the
// pulled note, else from the link) and its space key, filtered by a query, and
// folded when a group is long. Pure — no Obsidian runtime — so it unit-tests;
// section-locations.ts draws it.

import { folderID, siteHost, spaceKeyOf, tryPageID } from "@docket/core";
import { type Location, slugTitle } from "./locations.ts";
import { normalizeConfluenceSource } from "./source.ts";

/** COLLAPSE_AT is the most rows a group shows open by default. */
export const COLLAPSE_AT = 6;

/** FILTER_AT is how many locations make the filter box worth showing. */
export const FILTER_AT = 10;

/** LABEL_MAX is the longest vault path label a row shows, in characters. */
export const LABEL_MAX = 32;

/** TitleSource says where a row's title came from. */
export type TitleSource = "note" | "link";

/** TreeRow is one location as the tree shows it. */
export interface TreeRow {
    loc: Location;
    /** The vault path under its group, shortened to {@link LABEL_MAX}. */
    label: string;
    title: string;
    titleSource: TitleSource;
    /** The Confluence space key, or `""` when the link names none. */
    space: string;
}

/** TreeGroup is the rows under one first-level vault folder. */
export interface TreeGroup {
    /** The folder name; `""` for locations at the top of the sync folder. */
    name: string;
    rows: TreeRow[];
    /** The space key every row shares, or `""` when they differ. */
    space: string;
    open: boolean;
}

/**
 * buildTree groups `list` by first vault folder — top-level locations first,
 * then folders by name, rows by vault path. `noteTitle` returns the title of a
 * location's pulled note, or `""` to fall back to {@link linkTitle}. A
 * non-empty `query` keeps the rows whose title, vault path, or space key
 * contains it (case-insensitive) and opens their groups; otherwise a group is
 * open when it holds `invalid` (the location the validation banner names),
 * else when `open` says so, else when it has at most {@link COLLAPSE_AT} rows.
 */
export function buildTree(
    list: Location[],
    noteTitle: (l: Location) => string,
    query: string,
    open: ReadonlyMap<string, boolean>,
    invalid = "",
): TreeGroup[] {
    const q = query.trim().toLowerCase();
    const byName = new Map<string, TreeRow[]>();
    for (const loc of [...list].sort((a, b) => a.dest.localeCompare(b.dest))) {
        const cut = loc.dest.indexOf("/");
        const name = cut < 0 ? "" : loc.dest.slice(0, cut);
        const row = treeRow(loc, loc.dest.slice(cut + 1), noteTitle(loc));
        if (q !== "" && !matches(row, q)) continue;
        const rows = byName.get(name) ?? [];
        rows.push(row);
        byName.set(name, rows);
    }
    return [...byName.keys()].sort().map((name) => {
        const rows = byName.get(name) ?? [];
        const spaces = new Set(rows.map((r) => r.space));
        const fallback = rows.length <= COLLAPSE_AT;
        const flagged = rows.some((r) => r.loc.dest === invalid);
        return {
            name,
            rows,
            space: spaces.size === 1 ? (rows[0]?.space ?? "") : "",
            open:
                q !== "" ||
                name === "" ||
                flagged ||
                (open.get(name) ?? fallback),
        };
    });
}

/** treeRow builds the row for `loc`, labelled by `rel`, its path in the group. */
function treeRow(loc: Location, rel: string, noted: string): TreeRow {
    const path = normalizeConfluenceSource(loc.src);
    return {
        loc,
        label: shortenPath(rel, LABEL_MAX),
        title: noted === "" ? linkTitle(loc) : noted,
        titleSource: noted === "" ? "link" : "note",
        space: spaceKeyOf(path),
    };
}

/** matches reports whether `row` contains the lower-cased query `q`. */
function matches(row: TreeRow, q: string): boolean {
    return [row.title, row.loc.dest, row.space].some((v) =>
        v.toLowerCase().includes(q),
    );
}

/**
 * linkTitle is the best title the link itself carries: a page's decoded slug
 * (else `Page <id>`), `Folder <id>`, or a space's key; the raw source when it
 * parses as none of them.
 */
export function linkTitle(l: Location): string {
    const path = normalizeConfluenceSource(l.src);
    if (l.kind === "page") {
        const id = tryPageID(path);
        if (id === undefined) return l.src;
        const slug = slugTitle(path, id);
        return slug === "" ? `Page ${id}` : slug;
    }
    if (l.kind === "folder") {
        try {
            return `Folder ${folderID(path)}`;
        } catch {
            return l.src;
        }
    }
    return spaceKeyOf(path) || l.src;
}

/**
 * notePath is the vault path, under the sync folder, of the note that holds a
 * location's title: the page itself, or a folder's or space's `_index.md`.
 */
export function notePath(l: Location): string {
    return l.kind === "page" ? l.dest : `${l.dest}/_index.md`;
}

/** pageUrl is the browser URL of `src` on `site`; `""` without a Site. */
export function pageUrl(site: string, src: string): string {
    if (site === "") return "";
    const path = normalizeConfluenceSource(src).replace(/[?#].*$/, "");
    return `${siteHost(site)}${path}`;
}

/**
 * shortenPath fits `p` into `max` characters, cutting in the middle so both
 * ends stay readable: `first/…/last`, then `first/…<end of last>`, then
 * `…<end of p>`. A single segment is cut at its end instead.
 */
export function shortenPath(p: string, max: number): string {
    if (p.length <= max) return p;
    const segs = p.split("/");
    if (segs.length === 1) return `${p.slice(0, max - 1)}…`;
    const first = segs[0] ?? "";
    const last = segs[segs.length - 1] ?? "";
    const outer = `${first}/…/${last}`;
    if (outer.length <= max) return outer;
    const room = max - first.length - 2;
    if (room >= MIN_TAIL) return `${first}/…${last.slice(-room)}`;
    return `…${p.slice(-(max - 1))}`;
}

/** MIN_TAIL is the shortest end of the last segment worth keeping after `first/…`. */
const MIN_TAIL = 4;
