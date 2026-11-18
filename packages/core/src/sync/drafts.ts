// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Reply drafts: a `> [!reply] draft` block a user keeps in a note, right after
// the `[!comment]` callout of the thread it answers, until a push sends it.
// Drafts are the user's text, not docket's overlay: a push strips them from
// the page body like the comment callouts, but a pull or a push refresh puts
// them back after their thread ({@link placeDrafts}). A draft whose thread is
// gone keeps its place and gets a mark on its tag line naming the thread, so
// it is never lost and never sent by surprise.

import { isFenceLine, segmentBody } from "../adf/parse/blocks.ts";
import type { PageComments } from "../confluence/client.ts";

/** DRAFT_TAG is a draft block's tag line, before any mark. */
const DRAFT_TAG = "> [!reply] draft";

/** DRAFT_RE matches a draft's tag line at any quote depth. */
const DRAFT_RE = /^(?:>\s*)+\[!reply\]/i;

/** TOP_DRAFT_RE matches a top-level draft tag line, capturing what follows. */
const TOP_DRAFT_RE = /^>\s*\[!reply\]\s*(.*)$/i;

/** THREAD_RE matches a thread's top-level callout tag line, capturing its id. */
const THREAD_RE = /^>\s*\[!comment\]\s+id:(\S+)/i;

/** COMMENT_RE matches a comment callout tag line at any depth, capturing the rest. */
const COMMENT_RE = /^(?:>\s*)+\[!comment\](.*)$/i;

/** MARK_ID_RE captures the thread id a mark names. */
const MARK_ID_RE = /thread id:(\S+)/;

/** Draft is one reply draft as a note holds it. */
export interface Draft {
    /**
     * The draft's handle within its note: `<thread id>#<n>`, n counting the
     * thread's drafts from 1 in note order; `line:<n>` for a draft with no
     * thread.
     */
    key: string;
    /** The thread it answers: from its mark, else the callout right above it; `""` when none. */
    threadId: string;
    /** The reply's Markdown, `> ` prefixes removed. */
    text: string;
    /** 1-based body line of the tag line. */
    line: number;
    /** The block as the note holds it. */
    block: string;
    /** The tag line's mark after `draft · `; `""` when unmarked. */
    mark: string;
    /** The nearest page block above the draft, past any callouts; `""` when none. */
    anchor: string;
}

/** PendingReply is one reply draft as a push review lists it. */
export interface PendingReply {
    /** The draft's key, what `PusherDeps.hold` names to keep it back. */
    key: string;
    /** The author of the thread it answers, as the note shows it; `""` when unknown. */
    to: string;
    /** The reply's Markdown. */
    text: string;
    /** Why it cannot be sent (its mark), or `""` when it can. */
    mark: string;
}

/** REPLY_QUOTE_MAX caps a draft's first line in a review line. */
const REPLY_QUOTE_MAX = 60;

/**
 * replyLabel words one reply draft for a push review: who it answers and its
 * first line, or why it cannot be sent.
 */
export function replyLabel(r: PendingReply): string {
    const first = (r.text.split("\n", 1)[0] ?? "").trim();
    const quote =
        first.length > REPLY_QUOTE_MAX
            ? `"${first.slice(0, REPLY_QUOTE_MAX)}…"`
            : `"${first}"`;
    if (r.mark !== "") return `Cannot send reply ${quote}: ${r.mark}`;
    return r.to === "" ? `Reply: ${quote}` : `Reply to ${r.to}: ${quote}`;
}

/**
 * draftBlock renders a draft for `text`: the tag line, with ` · <mark>` when
 * `mark` is set, then each text line quoted, a blank line as a bare `>`.
 */
export function draftBlock(text: string, mark = ""): string {
    const tag = mark === "" ? DRAFT_TAG : `${DRAFT_TAG} · ${mark}`;
    const lines = text.split("\n").map((ln) => (ln === "" ? ">" : `> ${ln}`));
    return [tag, ...lines].join("\n");
}

/** firstLine is the first line of a block. */
function firstLine(text: string): string {
    return text.split("\n", 1)[0] ?? "";
}

/** isDraft reports whether a top-level block is a draft. */
function isDraft(text: string): boolean {
    return TOP_DRAFT_RE.test(firstLine(text));
}

/** isCallout reports whether a top-level block is a comment callout. */
function isCallout(text: string): boolean {
    return /^>\s*\[!comment\]/i.test(firstLine(text));
}

/** threadOfBlock is the thread id of a top-level comment callout, or `""`. */
function threadOfBlock(text: string): string {
    return THREAD_RE.exec(firstLine(text))?.[1] ?? "";
}

/** unquote is a quoted block's text without its tag line and `> ` prefixes. */
function unquote(lines: string[]): string {
    return lines
        .map((ln) => ln.replace(/^> ?/, ""))
        .join("\n")
        .trim();
}

/**
 * readDrafts returns the drafts of note body `body`, in order. A draft answers
 * the thread its mark names, else the thread whose callout sits right above it
 * (other drafts of that thread may sit between).
 */
export function readDrafts(body: string): Draft[] {
    const blocks = segmentBody(body);
    const counts = new Map<string, number>();
    const out: Draft[] = [];
    blocks.forEach((b, i) => {
        const tag = TOP_DRAFT_RE.exec(firstLine(b.text));
        if (tag === null) {
            return;
        }
        const rest = tag[1] ?? "";
        const sep = rest.indexOf("·");
        const mark = sep < 0 ? "" : rest.slice(sep + 1).trim();
        let threadId = MARK_ID_RE.exec(mark)?.[1] ?? "";
        let j = i - 1;
        while (j >= 0 && isDraft(blocks[j]?.text ?? "")) {
            j--;
        }
        if (threadId === "" && j >= 0) {
            threadId = threadOfBlock(blocks[j]?.text ?? "");
        }
        while (
            j >= 0 &&
            (isDraft(blocks[j]?.text ?? "") || isCallout(blocks[j]?.text ?? ""))
        ) {
            j--;
        }
        const n = (counts.get(threadId) ?? 0) + 1;
        counts.set(threadId, n);
        out.push({
            key: threadId === "" ? `line:${b.line}` : `${threadId}#${n}`,
            threadId,
            text: unquote(b.text.split("\n").slice(1)),
            line: b.line,
            block: b.text,
            mark,
            anchor: j >= 0 ? (blocks[j]?.text ?? "") : "",
        });
    });
    return out;
}

/**
 * checkDrafts throws, naming the file line (`firstLine` is the body's first
 * line in the file), on the first draft or comment callout a push cannot
 * read: a draft with no thread, an empty draft, a draft inside a comment
 * callout, or a comment callout without an id (a reply typed by hand). Fenced
 * code is page text and is not checked.
 */
export function checkDrafts(body: string, firstLine = 1): void {
    const at = (line: number): number => firstLine + line - 1;
    const drafts = new Map(readDrafts(body).map((d) => [d.line, d]));
    for (const b of segmentBody(body)) {
        const lines = b.text.split("\n");
        if (isFenceLine(lines[0] ?? "")) {
            continue;
        }
        const d = drafts.get(b.line);
        if (d !== undefined && d.threadId === "") {
            throw new Error(
                `reply draft at line ${at(d.line)} is not under a comment; ` +
                    "put it right after the comment's [!comment] callout",
            );
        }
        if (d !== undefined && d.text === "") {
            throw new Error(`reply draft at line ${at(d.line)} is empty`);
        }
        for (const [k, ln] of lines.entries()) {
            const line = at(b.line + k);
            if (k > 0 && isCallout(b.text) && DRAFT_RE.test(ln)) {
                throw new Error(
                    `reply draft at line ${line} is inside a comment ` +
                        "callout; put a blank line before it",
                );
            }
            const m = COMMENT_RE.exec(ln);
            if (m !== null && !/^\s+id:\S/.test(m[1] ?? "")) {
                throw new Error(
                    `comment callout at line ${line} has no id; to reply, ` +
                        "use the reply button or a [!reply] draft under " +
                        "the comment",
                );
            }
        }
    }
}

/**
 * placeDrafts puts `drafts` (read from the note before a pull or push rewrote
 * it) back into the rewritten body `body`. A draft whose thread `body` shows
 * goes right after that thread's callout, its mark cleared. Any other draft
 * goes after its anchor block and the callouts following it, or at the end
 * when the anchor is gone; `gone(threadId)` says why its thread is missing
 * (`is resolved on Confluence`), which becomes its mark, or `""` to leave the
 * draft as it was. Drafts keep their order.
 */
export function placeDrafts(
    body: string,
    drafts: Draft[],
    gone: (threadId: string) => string,
): string {
    if (drafts.length === 0) {
        return body;
    }
    const blocks = segmentBody(body);
    const blockEnd = (i: number): number => {
        const b = blocks[i];
        return b === undefined ? -1 : b.line - 2 + b.text.split("\n").length;
    };
    const inserts = new Map<number, string[]>();
    const tail: string[] = [];
    for (const d of drafts) {
        const t =
            d.threadId === ""
                ? -1
                : blocks.findIndex((b) => threadOfBlock(b.text) === d.threadId);
        if (t >= 0) {
            const text = d.mark === "" ? d.block : draftBlock(d.text);
            inserts.set(blockEnd(t), [
                ...(inserts.get(blockEnd(t)) ?? []),
                text,
            ]);
            continue;
        }
        const reason = d.threadId === "" ? "" : gone(d.threadId);
        const text =
            reason === ""
                ? d.block
                : draftBlock(d.text, `thread id:${d.threadId} ${reason}`);
        let a =
            d.anchor === ""
                ? -1
                : blocks.findIndex(
                      (b) =>
                          b.text === d.anchor &&
                          !isCallout(b.text) &&
                          !isDraft(b.text),
                  );
        if (a < 0) {
            tail.push(text);
            continue;
        }
        while (isCallout(blocks[a + 1]?.text ?? "")) {
            a++;
        }
        inserts.set(blockEnd(a), [...(inserts.get(blockEnd(a)) ?? []), text]);
    }
    const lines = body.split("\n");
    let trail = 0;
    while (trail < lines.length && lines[lines.length - 1 - trail] === "") {
        trail++;
    }
    const out: string[] = [];
    for (let i = 0; i < lines.length - trail; i++) {
        out.push(lines[i] ?? "");
        for (const text of inserts.get(i) ?? []) {
            out.push("", ...text.split("\n"));
        }
    }
    for (const text of tail) {
        out.push("", ...text.split("\n"));
    }
    for (let i = 0; i < trail; i++) {
        out.push("");
    }
    return out.join("\n");
}

/** Span is an inclusive 0-based line range. */
type Span = [number, number];

/**
 * threadDrafts finds, in note lines, the top-level callout of thread
 * `threadId` and the draft blocks right after it, or null when the note does
 * not show the thread.
 */
function threadDrafts(
    lines: string[],
    threadId: string,
): { thread: Span; drafts: Span[] } | null {
    const quoteEnd = (s: number): number => {
        let e = s;
        while ((lines[e + 1] ?? "").startsWith(">")) {
            e++;
        }
        return e;
    };
    const start = lines.findIndex((ln) => THREAD_RE.exec(ln)?.[1] === threadId);
    if (start < 0) {
        return null;
    }
    const thread: Span = [start, quoteEnd(start)];
    const drafts: Span[] = [];
    let j = thread[1] + 1;
    for (;;) {
        let k = j;
        while (k < lines.length && (lines[k] ?? "").trim() === "") {
            k++;
        }
        if (!TOP_DRAFT_RE.test(lines[k] ?? "")) {
            break;
        }
        drafts.push([k, quoteEnd(k)]);
        j = quoteEnd(k) + 1;
    }
    return { thread, drafts };
}

/**
 * draftOf returns the text of the last draft under thread `threadId` in note
 * `note`, or null when it has none.
 */
export function draftOf(note: string, threadId: string): string | null {
    const lines = note.split("\n");
    const last = threadDrafts(lines, threadId)?.drafts.at(-1);
    return last === undefined
        ? null
        : unquote(lines.slice(last[0] + 1, last[1] + 1));
}

/**
 * upsertDraft returns note `note` with `text` as the last draft under thread
 * `threadId`: it rewrites the thread's last draft, or inserts one right after
 * the thread's callout. It throws when the note does not show the thread.
 */
export function upsertDraft(
    note: string,
    threadId: string,
    text: string,
): string {
    const lines = note.split("\n");
    const found = threadDrafts(lines, threadId);
    if (found === null) {
        throw new Error(`comment id:${threadId} is not in the note; pull it`);
    }
    const block = draftBlock(text).split("\n");
    const last = found.drafts.at(-1);
    if (last !== undefined) {
        lines.splice(last[0], last[1] - last[0] + 1, ...block);
    } else {
        lines.splice(found.thread[1] + 1, 0, "", ...block);
    }
    return lines.join("\n");
}

/**
 * removeDraft returns note `note` without the last draft under thread
 * `threadId`, and the blank line before it; the note as it is when the thread
 * has no draft.
 */
export function removeDraft(note: string, threadId: string): string {
    const lines = note.split("\n");
    const last = threadDrafts(lines, threadId)?.drafts.at(-1);
    if (last === undefined) {
        return note;
    }
    let s = last[0];
    if ((lines[s - 1] ?? "x").trim() === "") {
        s--;
    }
    lines.splice(s, last[1] - s + 1);
    return lines.join("\n");
}

/**
 * threadGone explains why thread `threadId` is missing from a render of the
 * page whose live comments are `live`, as a draft mark's tail: resolved, no
 * longer on Confluence, or open but no longer shown (its highlighted text was
 * deleted). It returns `""` when `live` is unknown (comments off or not
 * fetched), so the draft keeps its tag as it was.
 */
export function threadGone(
    live: PageComments | undefined,
    threadId: string,
): string {
    if (live === undefined) {
        return "";
    }
    const root = [...live.inline, ...live.footer].find(
        (c) => c.id === threadId,
    );
    if (root === undefined) {
        return "is no longer on Confluence";
    }
    return root.resolution === "resolved"
        ? "is resolved on Confluence"
        : "is no longer shown on the page";
}
