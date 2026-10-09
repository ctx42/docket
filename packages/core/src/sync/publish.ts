// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Publishing a page restricted to its author: the deliberate step that lifts
// such a restriction. It clears only restrictions naming the author alone: a
// page or folder restricted to anyone else is refused, never widened.
// Author-only folders directly above the page are cleared with it, since a
// hidden folder hides the page; an author-only ancestor *page* is left alone and
// reported, as publishing its content is its own decision. Planning reads only;
// nothing is cleared until {@link publish} runs the confirmed plan.

import type { Config } from "../config/config.ts";
import type {
    ConfluenceClient,
    ContentRestriction,
} from "../confluence/client.ts";
import type { FileSystem } from "../ports/fs.ts";
import type { Yaml } from "../ports/yaml.ts";
import { pageName } from "./linkindex.ts";
import { readPageMeta } from "./push.ts";

/** MAX_ANCESTORS bounds the walk up the content tree. */
const MAX_ANCESTORS = 64;

/**
 * RestrictionKind classifies a page's or folder's direct restrictions: `none`
 * (open), `author` (every restricted operation names only the author), or
 * `custom` (anyone else, or any group, is named).
 */
export type RestrictionKind = "none" | "author" | "custom";

/** PublishTarget is one page or folder a publish clears. */
export interface PublishTarget {
    id: string;
    kind: "page" | "folder";
    title: string;
}

/** PublishPlan is what publishing one note's page clears, before it runs. */
export interface PublishPlan {
    dest: string;
    /** The account the cleared restrictions must name alone. */
    accountId: string;
    /**
     * The pages and folders to clear, top-down: the author-only ancestor
     * folders, then the page itself unless it is already open. Empty when
     * there is nothing to clear.
     */
    items: PublishTarget[];
    /** Why the page stays hidden after publishing; `""` when nothing hides it. */
    warning: string;
}

/** PublishDeps are the ports a publish reads and writes through. */
export interface PublishDeps {
    client: ConfluenceClient;
    fs: FileSystem;
    yaml: Yaml;
    config: Config;
}

/**
 * restrictionKind classifies the direct restrictions `rs` of a page or folder
 * against the author `accountId` (see {@link RestrictionKind}).
 */
export function restrictionKind(
    rs: ContentRestriction[],
    accountId: string,
): RestrictionKind {
    if (rs.length === 0) {
        return "none";
    }
    for (const r of rs) {
        if (r.groups.length > 0 || r.users.some((u) => u !== accountId)) {
            return "custom";
        }
    }
    return "author";
}

/**
 * planPublish resolves what publishing the page of the note at `dest` clears.
 * The note must carry a page id. A page restricted to anyone but the author is
 * refused. The walk up the tree collects the author-only folders directly
 * above the page and stops at the first ancestor that is not one; when that
 * ancestor still restricts viewing (an author-only page, or a custom read
 * restriction) the plan carries a warning naming it.
 */
export async function planPublish(
    deps: PublishDeps,
    dest: string,
): Promise<PublishPlan> {
    const name = pageName(deps.config.syncRoot, dest);
    const meta = await readPageMeta(deps.fs, deps.yaml, dest);
    if (meta === null || meta.pageId === "") {
        throw new Error(`${name}: not on Confluence yet; push it first`);
    }
    const accountId = await deps.client.currentAccountID();

    let node = await deps.client.fetchNode("page", meta.pageId);
    const items: PublishTarget[] = [];
    const own = restrictionKind(
        await deps.client.fetchRestrictions(meta.pageId),
        accountId,
    );
    if (own === "custom") {
        throw new Error(
            `${name}: restricted to other users or groups; ` +
                "change its restrictions in Confluence",
        );
    }
    if (own === "author") {
        items.push({ id: meta.pageId, kind: "page", title: node.title });
    }

    let warning = "";
    for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
        const kind = node.parentType;
        if (node.parentId === "" || (kind !== "page" && kind !== "folder")) {
            break;
        }
        const parent = await deps.client.fetchNode(kind, node.parentId);
        const rs = await deps.client.fetchRestrictions(node.parentId);
        const pk = restrictionKind(rs, accountId);
        if (pk === "author" && kind === "folder") {
            items.unshift({ id: node.parentId, kind, title: parent.title });
            node = parent;
            continue;
        }
        if (pk === "author") {
            warning =
                `parent page "${parent.title}" is still private; ` +
                "publish it to make this page visible";
        } else if (pk === "custom" && rs.some((r) => r.operation === "read")) {
            warning =
                `${kind} "${parent.title}" restricts who can view it; ` +
                "the page stays hidden from everyone it excludes";
        }
        break;
    }
    return { dest, accountId, items, warning };
}

/**
 * publish clears the restrictions of every item in the confirmed `plan`,
 * top-down. Each item is re-checked first: one opened meanwhile is skipped,
 * and one whose restrictions changed to name anyone else stops the run, so a
 * publish never widens a restriction it did not plan. Items cleared before a
 * failure stay cleared — a visible folder over a still-private page exposes no
 * content. It returns the items it cleared.
 */
export async function publish(
    client: ConfluenceClient,
    plan: PublishPlan,
): Promise<PublishTarget[]> {
    const cleared: PublishTarget[] = [];
    for (const item of plan.items) {
        const label = `${item.kind} "${item.title}"`;
        const kind = restrictionKind(
            await client.fetchRestrictions(item.id),
            plan.accountId,
        );
        if (kind === "none") {
            continue;
        }
        if (kind === "custom") {
            throw new Error(
                `${label}: restrictions changed since the check; not cleared`,
            );
        }
        await client.clearRestrictions(item.id);
        cleared.push(item);
    }
    return cleared;
}
