// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// One level of the Confluence content tree, as the location picker browses it
// and the discovery walk syncs it: a node's direct children, every page of the
// listing followed, keeping only live pages and folders. Whiteboards,
// databases, embeds, and smart links are dropped together with everything
// beneath them, so the picker never offers what a sync would not pull.

import {
    CHILDREN_PATH,
    type ChildNode,
    type ConfluenceClient,
    FOLDER_ENDPOINT,
    PAGE_ENDPOINT,
    type Space,
} from "./client.ts";

/** NodeKind is a content node a tree level can hold. */
export type NodeKind = "page" | "folder";

/**
 * isCurrent reports whether a child status denotes live content; an absent
 * status counts as live.
 */
export function isCurrent(status: string): boolean {
    return status === "" || status === "current";
}

/** isSyncable reports whether a child is a live page or folder. */
export function isSyncable(node: ChildNode): boolean {
    return (
        isCurrent(node.status) &&
        (node.type === "page" || node.type === "folder")
    );
}

/** childrenLink builds the direct-children path for a page or folder node. */
export function childrenLink(kind: string, id: string): string {
    const base = kind === "folder" ? FOLDER_ENDPOINT : PAGE_ENDPOINT;
    return `${base}${id}${CHILDREN_PATH}`;
}

/**
 * listChildren returns the syncable direct children of a page or folder in
 * listing order, following the pagination cursor to completion. It throws when
 * a listing request fails.
 */
export async function listChildren(
    client: ConfluenceClient,
    kind: NodeKind,
    id: string,
): Promise<ChildNode[]> {
    const out: ChildNode[] = [];
    let path = childrenLink(kind, id);
    while (path !== "") {
        const resp = await client.fetchChildren(path);
        out.push(...resp.results.filter(isSyncable));
        path = resp.next;
    }
    return out;
}

/**
 * SpaceTopLevel is a space's first level as its Confluence sidebar shows it,
 * split by whether a space sync pulls the node.
 */
export interface SpaceTopLevel {
    /** The homepage's syncable children: what a space sync places. */
    children: ChildNode[];
    /** Other live root-level pages beside the homepage, which it does not. */
    beside: ChildNode[];
}

/**
 * spaceTopLevel returns the first level of a space: the homepage's syncable
 * children and every other live root-level page. A space without a homepage
 * has only the latter.
 */
export async function spaceTopLevel(
    client: ConfluenceClient,
    space: Space,
): Promise<SpaceTopLevel> {
    const [children, roots] = await Promise.all([
        space.homepageId === ""
            ? Promise.resolve<ChildNode[]>([])
            : listChildren(client, "page", space.homepageId),
        client.fetchRootPages(space.id),
    ]);
    const beside = roots.filter(
        (p) => p.id !== space.homepageId && isSyncable(p),
    );
    return { children, beside };
}
