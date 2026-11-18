// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Comment decoration for the ADF→Markdown render. A Confluence inline comment is
// an `annotation` mark on a run of body text; its thread content lives outside
// the body ADF (fetched separately) and is threaded in through
// {@link MdCtx.comments}. This module draws each thread as a GitHub-style
// `[!comment]` callout: an inline comment's callout is appended after the
// top-level block that carries its marker (the annotated run also gets a
// `[^cf-<markerRef>]` ref, emitted by the inline renderer), and footer comments
// plus any inline thread whose marker was not found in the body collect into a
// trailing `## Comments` section. The decorations are stripped before a push
// reconstruct, so they never reach Confluence (Stage 1 is read-only).

import type { Node } from "../../models/adf.ts";
import { type MdBlock, segmentBody } from "../parse/blocks.ts";
import {
    annotationIdsOf,
    type CommentThread,
    type MdCtx,
    type RenderComments,
    renderBlocks,
} from "./markdown.ts";

/** The heading that opens the trailing footer/orphaned-comment section. */
export const TRAILING_COMMENTS_HEADING = "## Comments";

/** Matches a `[^cf-<markerRef>]` inline anchor ref (the namespaced footnote ref). */
const COMMENT_REF_RE = /\[\^cf-[^\]]+\]/g;

/**
 * stripCommentDecorations removes the comment decorations from a note body,
 * recovering the exact comment-free body a push must reconstruct — the inverse of
 * the render's decoration. It drops every `[^cf-…]` anchor ref (each sits at a
 * text-run boundary, so removing it restores the run verbatim), every
 * top-level `[!comment]` callout block and `[!reply]` draft (the user's
 * replies wait outside the page body), including the trailing `## Comments`
 * heading and the footer callouts under it; a `## Comments` heading anywhere
 * else is page content and stays. Block segmentation reuses
 * {@link segmentBody}, so a fenced code block that happens to contain a blank
 * line or a `> [!comment]` line is kept whole, never mis-split. The surviving
 * blocks re-join with a blank line, matching how the render lays out top-level
 * blocks, so the result diffs cleanly against the comment-free baseline.
 */
export function stripCommentDecorations(body: string): string {
    const noRefs = body.replace(COMMENT_REF_RE, "");
    const blocks = segmentBody(noRefs);
    const kept = blocks.filter(
        (b, i) =>
            !isCallout(b.text) &&
            !(isTrailingHeading(b.text) && opensTrailing(blocks, i)),
    );
    return kept.map((b) => b.text).join("\n\n");
}

/**
 * isCallout reports whether a top-level block is a `[!comment]` callout or a
 * `[!reply]` draft; neither is page content.
 */
function isCallout(text: string): boolean {
    const first = text.split("\n", 1)[0] ?? "";
    return /^>\s*\[!(?:comment|reply)\]/i.test(first);
}

/** isTrailingHeading reports whether a block is a bare `## Comments` heading. */
function isTrailingHeading(text: string): boolean {
    return text.trimEnd() === TRAILING_COMMENTS_HEADING;
}

/**
 * opensTrailing reports whether the `## Comments` heading at `blocks[i]` opens
 * the trailing comment section: every block after it is a callout, or none
 * follows (its footer callouts were deleted). A page's own `## Comments`
 * heading with content after it is kept; one that ends the page cannot be told
 * from an emptied trailing section and is stripped.
 */
function opensTrailing(blocks: MdBlock[], i: number): boolean {
    return blocks.slice(i + 1).every((b) => isCallout(b.text));
}

/**
 * blockComments returns the `[!comment]` callouts for the inline threads
 * anchored within one top-level block `node`, joined by a blank line, or `""`
 * when the block carries none. A thread is matched by the id of an annotation
 * mark anywhere in the block's subtree, in document order; each matched marker is
 * added to `used` so it is neither drawn twice nor repeated in the trailing
 * section. With no comments in the context this returns `""`.
 */
export function blockComments(
    node: Node,
    ctx: MdCtx,
    used: Set<string>,
): string {
    const byMarker = ctx.comments?.byMarker;
    if (byMarker === undefined || byMarker.size === 0) {
        return "";
    }
    const parts: string[] = [];
    for (const id of annotationIdsIn(node)) {
        if (used.has(id)) {
            continue;
        }
        const thread = byMarker.get(id);
        if (thread === undefined) {
            continue;
        }
        used.add(id);
        parts.push(calloutLines(thread, ctx, 0).join("\n"));
    }
    return parts.join("\n\n");
}

/**
 * trailingComments returns the trailing `## Comments` section: the footer
 * (page-level) comments, each as a `[!comment]` callout. It returns `""` when
 * there are none, so a page with only anchored inline comments grows no trailing
 * section. An inline thread whose marker was not found in the body is dangling —
 * its highlighted text was deleted, so Confluence no longer shows it on the page —
 * and is dropped here rather than surfaced, keeping the note in step with the CF
 * view.
 */
export function trailingComments(comments: RenderComments, ctx: MdCtx): string {
    if (comments.trailing.length === 0) {
        return "";
    }
    const callouts = comments.trailing.map((t) =>
        calloutLines(t, ctx, 0).join("\n"),
    );
    return `${TRAILING_COMMENTS_HEADING}\n\n${callouts.join("\n\n")}`;
}

/**
 * annotationIdsIn returns the inlineComment annotation-mark ids anywhere in
 * `node`'s subtree, in document order (a marker may sit on any inline text,
 * however deeply nested). Duplicates are kept; the caller dedups via `used`.
 */
export function annotationIdsIn(node: Node): string[] {
    const out: string[] = [];
    const walk = (n: Node): void => {
        for (const id of annotationIdsOf(n)) {
            out.push(id);
        }
        for (const child of n.content ?? []) {
            walk(child);
        }
    };
    walk(node);
    return out;
}

/**
 * calloutLines renders one comment thread as the lines of a `[!comment]` callout
 * at nesting `depth` (0 for a top-level comment, +1 per reply level), each line
 * carrying the `> ` blockquote prefix repeated `depth + 1` times so a reply nests
 * inside its parent. The metadata line leads, the comment body (rendered through
 * the normal block dispatch) follows, and each reply is drawn recursively one
 * level deeper. A bare `>` line at this depth separates sibling replies;
 * without it the second reply's tag line would continue the first reply's
 * callout as text. Every line stays `>`-prefixed — no bare blank line — so the
 * whole thread is one contiguous blockquote the strip step can drop as a unit.
 */
function calloutLines(
    thread: CommentThread,
    ctx: MdCtx,
    depth: number,
): string[] {
    const prefix = "> ".repeat(depth + 1);
    const bare = prefix.trimEnd();
    const lines = [prefix + metaLine(thread)];
    const body = renderBlocks(thread.body, ctx);
    if (body !== "") {
        for (const ln of body.split("\n")) {
            lines.push(ln === "" ? bare : prefix + ln);
        }
    }
    thread.replies.forEach((reply, i) => {
        if (i > 0) {
            lines.push(bare);
        }
        lines.push(...calloutLines(reply, ctx, depth + 1));
    });
    return lines;
}

/**
 * metaLine is the `[!comment]` tag line of a callout: the thread id, then the
 * author, timestamp, and (inline only) resolution, joined by ` · `. Empty fields
 * are omitted, so a reply — which carries no resolution — shows just id, author,
 * and date. The author is the name when known, else the account id.
 */
function metaLine(thread: CommentThread): string {
    const parts = [`id:${thread.id}`];
    const author = oneLine(thread.authorName) || thread.authorId;
    if (author !== "") {
        parts.push(`@${author}`);
    }
    if (thread.createdAt !== "") {
        parts.push(thread.createdAt);
    }
    if (thread.resolution !== "") {
        parts.push(thread.resolution);
    }
    return `[!comment] ${parts.join(" · ")}`;
}

/**
 * oneLine collapses every whitespace run in `s` (line breaks included) to one
 * space and trims it, so a name cannot break the callout's tag line.
 */
function oneLine(s: string): string {
    return s.replace(/\s+/g, " ").trim();
}
