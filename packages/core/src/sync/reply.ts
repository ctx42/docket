// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Replying to a Confluence comment from a note. The reply is written as
// Markdown, turned into ADF by the configured flavor, and posted under the live
// comment straight away, outside a push. The caller pulls the note afterwards,
// so the reply shows as a callout and the comment record stays current.

import type { Config } from "../config/config.ts";
import type { ConfluenceClient, PageComment } from "../confluence/client.ts";
import { resolveFlavor } from "../flavor/flavor.ts";
import { newADF } from "../models/adf.ts";
import type { FileSystem } from "../ports/fs.ts";
import type { Yaml } from "../ports/yaml.ts";
import { pageName } from "./linkindex.ts";
import { readPageMeta } from "./push.ts";

/** EMPTY_PAGE is the empty ADF a reply's Markdown is built onto. */
const EMPTY_PAGE = '{"adf":{"type":"doc","version":1,"content":[]}}';

/** ReplyDeps are the ports a reply reads and writes through. */
export interface ReplyDeps {
    client: ConfluenceClient;
    fs: FileSystem;
    yaml: Yaml;
    config: Config;
}

/**
 * replyToComment posts `text` (Markdown) as a reply to comment `commentId` on
 * the page of note `dest`, and returns the new reply's id. The reply takes the
 * comment's kind (inline or footer) from the live page. It refuses an empty
 * reply, a note not on Confluence, and a comment the page no longer has.
 */
export async function replyToComment(
    deps: ReplyDeps,
    dest: string,
    commentId: string,
    text: string,
): Promise<string> {
    if (text.trim() === "") {
        throw new Error("the reply is empty");
    }
    const meta = await readPageMeta(deps.fs, deps.yaml, dest);
    if (meta === null || meta.pageId === "") {
        const name = pageName(deps.config.syncRoot, dest);
        throw new Error(`${name}: not on Confluence yet; push it first`);
    }
    const live = await deps.client.fetchComments(meta.pageId);
    const parent = findComment([...live.inline, ...live.footer], commentId);
    if (parent === null) {
        throw new Error(
            `comment ${commentId} is no longer on Confluence; pull the note`,
        );
    }
    const doc = resolveFlavor(deps.config.flavor).reconstruct(
        newADF(EMPTY_PAGE),
        text.trim(),
        { mentions: null, assets: null, images: null, links: null },
    ).doc;
    return deps.client.createReply({
        parentId: parent.id,
        kind: parent.kind,
        adf: JSON.stringify(doc),
    });
}

/** findComment returns the comment `id` in `comments` or their replies, or null. */
function findComment(comments: PageComment[], id: string): PageComment | null {
    for (const c of comments) {
        if (c.id === id) {
            return c;
        }
        const found = findComment(c.replies, id);
        if (found !== null) {
            return found;
        }
    }
    return null;
}
