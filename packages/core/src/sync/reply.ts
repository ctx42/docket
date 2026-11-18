// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Replying to a Confluence comment from a note. The reply is written as
// Markdown, turned into ADF by the configured flavor, and posted under the live
// comment straight away, outside a push. The caller pulls the note afterwards,
// so the reply shows as a callout and the comment record stays current.

import type { Config } from "../config/config.ts";
import type {
    ConfluenceClient,
    PageComment,
    PageComments,
} from "../confluence/client.ts";
import { resolveFlavor } from "../flavor/flavor.ts";
import { type Node, newADF } from "../models/adf.ts";
import type { FileSystem } from "../ports/fs.ts";
import type { Yaml } from "../ports/yaml.ts";
import type { Draft } from "./drafts.ts";
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
    return deps.client.createReply({
        parentId: parent.id,
        kind: parent.kind,
        adf: replyADF(deps.config, text),
    });
}

/** replyADF builds the ADF JSON of a reply's Markdown `text`, trimmed. */
export function replyADF(config: Config, text: string): string {
    const doc = resolveFlavor(config.flavor).reconstruct(
        newADF(EMPTY_PAGE),
        text.trim(),
        { mentions: null, assets: null, images: null, links: null },
    ).doc;
    return JSON.stringify(doc);
}

/** DraftSend is what {@link sendDrafts} did with a note's drafts. */
export interface DraftSend {
    /** Drafts now on Confluence (sent, or found already sent): drop them. */
    sent: Draft[];
    /** Drafts still to send: keep them in the note. */
    unsent: Draft[];
    /** One report line per draft that was sent, already there, or cannot go. */
    lines: string[];
    /** The failed sends, or `""`. */
    warning: string;
}

/**
 * sendDrafts posts each draft as a reply to its thread's root comment in
 * `live`, the page's current comments, in order. A thread that is gone or
 * resolved keeps its draft unsent ("cannot send"). A draft whose text the
 * thread already holds (an earlier push sent it, then failed to update the
 * note) counts as sent without a post. A failed post keeps the draft and
 * becomes the warning.
 */
export async function sendDrafts(
    client: ConfluenceClient,
    config: Config,
    drafts: Draft[],
    live: PageComments,
): Promise<DraftSend> {
    const out: DraftSend = { sent: [], unsent: [], lines: [], warning: "" };
    const failed: string[] = [];
    const roots = [...live.inline, ...live.footer];
    for (const d of drafts) {
        const root = roots.find((c) => c.id === d.threadId);
        const why =
            root === undefined
                ? "thread is no longer on Confluence"
                : root.resolution === "resolved"
                  ? "thread is resolved on Confluence"
                  : "";
        if (root === undefined || why !== "") {
            out.unsent.push(d);
            out.lines.push(
                `cannot send reply to comment id:${d.threadId}: ${why}`,
            );
            continue;
        }
        const adf = replyADF(config, d.text);
        const said = adfText(JSON.parse(adf) as Node);
        if (threadTexts(root).includes(said)) {
            out.sent.push(d);
            out.lines.push(
                `reply to comment id:${d.threadId} already sent: ${quote(d.text)}`,
            );
            continue;
        }
        try {
            await client.createReply({
                parentId: root.id,
                kind: root.kind,
                adf,
            });
            out.sent.push(d);
            out.lines.push(
                `replied to comment id:${d.threadId} ${quote(d.text)}`,
            );
        } catch (err) {
            out.unsent.push(d);
            failed.push(`id:${d.threadId} (${message(err)})`);
        }
    }
    if (failed.length > 0) {
        out.warning = `sending reply failed: ${failed.join(", ")}`;
    }
    return out;
}

/** threadTexts is the plain text of every comment in thread `root`. */
function threadTexts(root: PageComment): string[] {
    const out: string[] = [];
    const walk = (c: PageComment): void => {
        try {
            out.push(adfText(JSON.parse(c.adf) as Node));
        } catch {
            // An unreadable body matches no draft.
        }
        c.replies.forEach(walk);
    };
    walk(root);
    return out;
}

/**
 * adfText is the plain text of ADF `node`: its text runs and mention names,
 * each block and break a space, whitespace collapsed.
 */
function adfText(node: Node): string {
    const parts: string[] = [];
    const walk = (n: Node): void => {
        if (n.type === "text") {
            parts.push(n.text ?? "");
        } else if (n.type === "mention") {
            parts.push(String(n.attrs?.["text"] ?? ""));
        } else {
            parts.push(" ");
        }
        n.content?.forEach(walk);
    };
    walk(node);
    return parts.join("").replace(/\s+/g, " ").trim();
}

/** QUOTE_MAX caps a draft's text in a report line. */
const QUOTE_MAX = 60;

/** quote is a draft's first line, shortened, in double quotes. */
function quote(text: string): string {
    const first = (text.split("\n", 1)[0] ?? "").trim();
    const short =
        first.length > QUOTE_MAX ? `${first.slice(0, QUOTE_MAX)}…` : first;
    return `"${short}"`;
}

/** message returns an unknown thrown value's message. */
function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
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
