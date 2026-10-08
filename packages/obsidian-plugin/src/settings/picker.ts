// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The state behind the "Browse Confluence" picker: the space list (filtered and
// grouped), the tree nodes it expands into, which nodes the current settings
// already sync or cover, the user's ticks and renames as a draft of additions,
// removals, and renames, and the review rows that check the draft before it is
// saved. Pure — no
// Obsidian runtime — so it unit-tests directly; picker-modal.ts is DOM glue.

import {
    buildPluginConfig,
    type ChildNode,
    type docketSettings,
    folderID,
    posixBase,
    posixDir,
    posixJoin,
    type Space,
    spaceLinkKey,
    tryPageID,
    validateName,
} from "@docket/core";
import {
    checkLocation,
    type Location,
    type LocationKind,
    locations,
    putLocation,
    removeLocation,
    titleDest,
} from "./locations.ts";

/**
 * Cover names the synced root a node falls under. A space's walk descends
 * into pages' children (`deep`); a folder's walk places its pages as single
 * notes and does not, so a folder covers its pages but not their children.
 */
export interface Cover {
    /** The covering location's vault path. */
    dest: string;
    deep: boolean;
}

/** TreeNode is one row of the picker tree. */
export interface TreeNode {
    /** Unique per tree, e.g. `page:123`. */
    key: string;
    kind: LocationKind;
    /** The page or folder id, or the space key. */
    id: string;
    title: string;
    spaceKey: string;
    /** The Confluence source a location for this node stores. */
    src: string;
    /** The synced root this node falls under, or null. */
    cover: Cover | null;
    /** The space, for a space node. */
    space?: Space;
}

/** SpaceGroups is the space list split into team and personal spaces. */
export interface SpaceGroups {
    team: Space[];
    personal: Space[];
}

/**
 * groupSpaces filters spaces by `query` (name or key, case-insensitive) and
 * splits them into team and personal spaces, keeping their order except that
 * the account's own personal space comes first.
 */
export function groupSpaces(
    spaces: Space[],
    query: string,
    accountId: string,
): SpaceGroups {
    const q = query.trim().toLowerCase();
    const hit = spaces.filter(
        (sp) =>
            q === "" ||
            sp.name.toLowerCase().includes(q) ||
            sp.key.toLowerCase().includes(q),
    );
    const own = `~${accountId}`;
    const personal = hit.filter((sp) => sp.type === "personal");
    return {
        team: hit.filter((sp) => sp.type !== "personal"),
        personal: [
            ...personal.filter((sp) => sp.key === own),
            ...personal.filter((sp) => sp.key !== own),
        ],
    };
}

/** sourceOf builds the Confluence source a location of `kind` stores. */
export function sourceOf(
    kind: LocationKind,
    spaceKey: string,
    id: string,
): string {
    if (kind === "space") return `/wiki/spaces/${spaceKey}/overview`;
    if (kind === "folder") return `/wiki/spaces/${spaceKey}/folder/${id}`;
    return `/wiki/spaces/${spaceKey}/pages/${id}`;
}

/** spaceNode builds the tree node for a space. */
export function spaceNode(space: Space): TreeNode {
    return {
        key: `space:${space.key}`,
        kind: "space",
        id: space.key,
        title: space.name || space.key,
        spaceKey: space.key,
        src: sourceOf("space", space.key, space.key),
        cover: null,
        space,
    };
}

/**
 * syncedAs returns the location in `s` that syncs exactly this node — by page
 * id, folder id, or space key — or null when none does.
 */
export function syncedAs(s: docketSettings, node: TreeNode): Location | null {
    for (const l of locations(s)) {
        if (l.kind === node.kind && idOf(l) === node.id) return l;
    }
    return null;
}

/** idOf returns the page id, folder id, or space key a location names. */
function idOf(l: Location): string {
    try {
        if (l.kind === "page") return tryPageID(l.src) ?? "";
        if (l.kind === "folder") return folderID(l.src);
        return spaceLinkKey(l.src);
    } catch {
        return "";
    }
}

/**
 * childNodes builds a node's children from a listing, deriving what covers
 * each: a synced space covers its homepage's subtree, a synced folder its
 * pages and sub-folders, and a page passes on only a space's (deep) cover.
 * `beside` lists a space's root pages outside its homepage, which nothing
 * covers.
 */
export function childNodes(
    s: docketSettings,
    parent: TreeNode,
    kids: ChildNode[],
    beside: ChildNode[] = [],
): TreeNode[] {
    const own = syncedAs(s, parent);
    let cover: Cover | null;
    if (parent.kind === "space") {
        cover = own === null ? null : { dest: own.dest, deep: true };
    } else if (parent.kind === "folder") {
        cover =
            parent.cover ??
            (own === null ? null : { dest: own.dest, deep: false });
    } else {
        cover = parent.cover?.deep === true ? parent.cover : null;
    }
    const make = (kid: ChildNode, c: Cover | null): TreeNode => {
        const kind: LocationKind = kid.type === "folder" ? "folder" : "page";
        return {
            key: `${kind}:${kid.id}`,
            kind,
            id: kid.id,
            title: kid.title,
            spaceKey: parent.spaceKey,
            src: sourceOf(kind, parent.spaceKey, kid.id),
            cover: c,
        };
    };
    return [
        ...kids.map((k) => make(k, cover)),
        ...beside.map((k) => make(k, null)),
    ];
}

/** Addition is a ticked node not synced yet, with the vault path it gets. */
export interface Addition {
    node: TreeNode;
    dest: string;
}

/** Rename is a node's pending local name; `""` clears a page's name override. */
export interface Rename {
    node: TreeNode;
    name: string;
}

/** Draft is the picker's pending change: additions, removals, and renames, by node key. */
export interface Draft {
    adds: Map<string, Addition>;
    removes: Map<string, Location>;
    renames: Map<string, Rename>;
}

/** emptyDraft returns a draft with no changes. */
export function emptyDraft(): Draft {
    return { adds: new Map(), removes: new Map(), renames: new Map() };
}

/**
 * RenameKind is what renaming a node edits: a synced root's own config key
 * (`root`), or a page's name override (`override`) — the name a folder or space
 * walk gives it.
 */
export type RenameKind = "root" | "override";

/**
 * renameKind returns what renaming `node` would edit under the draft, or null
 * when it cannot be renamed: a root about to stop syncing, a page about to be
 * added (its path is edited in the review step), or an unsynced folder or space.
 */
export function renameKind(
    s: docketSettings,
    d: Draft,
    node: TreeNode,
): RenameKind | null {
    if (syncedAs(s, node) !== null) {
        return d.removes.has(node.key) ? null : "root";
    }
    if (node.kind === "page" && !d.adds.has(node.key)) return "override";
    return null;
}

/**
 * currentName returns the local name `node` has in the settings: a synced
 * root's file or directory name (a page's without `.md`), else the page's name
 * override, else `""` (the name derived from its title).
 */
export function currentName(s: docketSettings, node: TreeNode): string {
    const own = syncedAs(s, node);
    if (own !== null) {
        const base = posixBase(own.dest);
        return own.kind === "page" ? base.replace(/\.md$/, "") : base;
    }
    return s.names[node.id] ?? "";
}

/** localName returns the node's name under the draft: its pending rename, else {@link currentName}. */
export function localName(s: docketSettings, d: Draft, node: TreeNode): string {
    return d.renames.get(node.key)?.name ?? currentName(s, node);
}

/**
 * setRename returns the draft with `node` renamed to `name` (trimmed). Renaming
 * back to the current name drops the pending rename, as does an empty name for a
 * root, which always needs one; an empty name for a page clears its override.
 */
export function setRename(
    s: docketSettings,
    d: Draft,
    node: TreeNode,
    name: string,
): Draft {
    const renames = new Map(d.renames);
    const n = name.trim();
    if (
        n === currentName(s, node) ||
        (n === "" && syncedAs(s, node) !== null)
    ) {
        renames.delete(node.key);
    } else {
        renames.set(node.key, { node, name: n });
    }
    return { ...d, renames };
}

/** isTicked reports whether a node shows ticked under the draft. */
export function isTicked(s: docketSettings, d: Draft, node: TreeNode): boolean {
    return syncedAs(s, node) === null
        ? d.adds.has(node.key)
        : !d.removes.has(node.key);
}

/**
 * toggle flips a node's tick: an already-synced node toggles its removal, any
 * other node its addition, proposed at the title's path (`titleDest`).
 */
export function toggle(s: docketSettings, d: Draft, node: TreeNode): Draft {
    const adds = new Map(d.adds);
    const removes = new Map(d.removes);
    // A tick either way makes a pending rename moot: a removed root has no key
    // to rename, and an added page takes its path from the review step.
    const renames = new Map(d.renames);
    renames.delete(node.key);
    const own = syncedAs(s, node);
    if (own !== null) {
        if (removes.has(node.key)) removes.delete(node.key);
        else removes.set(node.key, own);
    } else if (adds.has(node.key)) {
        adds.delete(node.key);
    } else {
        adds.set(node.key, { node, dest: titleDest(node.kind, node.title) });
    }
    return { adds, removes, renames };
}

/** setDest returns the draft with an addition's vault path changed. */
export function setDest(d: Draft, key: string, dest: string): Draft {
    const add = d.adds.get(key);
    if (add === undefined) return d;
    const adds = new Map(d.adds);
    adds.set(key, { ...add, dest: dest.trim() });
    return { ...d, adds };
}

/** changeCount is how many additions, removals, and renames the draft holds. */
export function changeCount(d: Draft): number {
    return d.adds.size + d.removes.size + d.renames.size;
}

/** ReviewRow is one line of the review step. */
export interface ReviewRow {
    op: "add" | "remove" | "rename";
    /** The draft key, to edit an addition's path. */
    key: string;
    title: string;
    /**
     * The location the row adds, removes, or renames a root to; for a name
     * override, a page whose `dest` is the note name (`""` when cleared).
     */
    location: Location;
    /** The page id a name override applies to, or `""`. */
    pageId: string;
    /** Why the row cannot be saved, or `""`. */
    error: string;
}

/** Review is the review step: its rows and the result of applying them. */
export interface Review {
    rows: ReviewRow[];
    /** The first config error of the whole result, or `""`. */
    configError: string;
    /** The settings with every row applied. */
    settings: docketSettings;
}

/** review reports whether saving the draft is possible. */
export function canSave(r: Review): boolean {
    return (
        r.rows.length > 0 &&
        r.configError === "" &&
        r.rows.every((row) => row.error === "")
    );
}

/**
 * review applies the draft to `s` — removals first, then renames, then
 * additions in tick order — checking each rename and addition against
 * everything before it, then the whole result as the config loader would.
 */
export function review(s: docketSettings, d: Draft, token: string): Review {
    const rows: ReviewRow[] = [];
    let next = s;
    for (const [key, l] of d.removes) {
        next = removeLocation(next, l);
        rows.push({
            op: "remove",
            key,
            title: l.dest,
            location: l,
            pageId: "",
            error: "",
        });
    }
    for (const [key, r] of d.renames) {
        const own = syncedAs(s, r.node);
        if (own !== null) {
            const name = own.kind === "page" ? `${r.name}.md` : r.name;
            const l: Location = {
                ...own,
                dest: posixJoin(posixDir(own.dest), name),
            };
            let error = nameError(r.name);
            if (error === "") error = checkLocation(next, l, own);
            if (error === "") next = putLocation(next, l, own);
            rows.push({
                op: "rename",
                key,
                title: r.node.title,
                location: l,
                pageId: "",
                error,
            });
            continue;
        }
        const error = r.name === "" ? "" : nameError(r.name);
        if (error === "") next = withName(next, r.node.id, r.name);
        rows.push({
            op: "rename",
            key,
            title: r.node.title,
            location: {
                kind: "page",
                dest: r.name === "" ? "" : `${r.name}.md`,
                src: r.node.src,
            },
            pageId: r.node.id,
            error,
        });
    }
    for (const [key, add] of d.adds) {
        const l: Location = {
            kind: add.node.kind,
            dest: add.dest,
            src: add.node.src,
        };
        const error = checkLocation(next, l, null);
        if (error === "") next = putLocation(next, l, null);
        rows.push({
            op: "add",
            key,
            title: add.node.title,
            location: l,
            pageId: "",
            error,
        });
    }
    let configError = "";
    try {
        buildPluginConfig(next, token);
    } catch (err) {
        configError = (
            err instanceof Error ? err.message : String(err)
        ).replace(/^config: /, "");
    }
    return { rows, configError, settings: next };
}

/** nameError returns why `name` is not a valid local name, or `""`. */
function nameError(name: string): string {
    try {
        validateName(name);
        return "";
    } catch (err) {
        return (err instanceof Error ? err.message : String(err)).replace(
            /^config: /,
            "",
        );
    }
}

/** withName returns `s` with page `id`'s name override set, or cleared for `""`. */
function withName(s: docketSettings, id: string, name: string): docketSettings {
    const names = { ...s.names };
    if (name === "") delete names[id];
    else names[id] = name;
    return { ...s, names };
}
