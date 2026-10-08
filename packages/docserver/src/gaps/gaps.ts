// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The gap domain ported from Go `pkg/gaps/gaps.go`: a gap records a fact
// the corpus fails to supply, from report through fill. This module holds
// the types, the validation of author input (with the Go server's error
// texts), file naming, list filtering, the section hash that filled_by
// entries record, and the store and resolver contracts.

import { posixBase, posixJoin } from "@docket/core";
import { sha256Hex } from "../gocompat/sha256.ts";
import { goQuote } from "../gocompat/strconv.ts";
import { trimRight, trimSpace } from "../gocompat/strings.ts";
import { type GoTime, parseTime } from "../gocompat/time.ts";
import { errorIs } from "../ports.ts";
import { goToLower } from "../search/analyzer.ts";
import { fileSlug } from "./helpers.ts";

/** Kind classifies how the corpus fails to supply a fact. */
export type Kind = "missing" | "wrong" | "incomplete" | "ambiguous";
export const KINDS: readonly Kind[] = [
    "missing",
    "wrong",
    "incomplete",
    "ambiguous",
];

/** Status is where a gap sits in its lifecycle. */
export type Status = "draft" | "open" | "filled" | "wontfix";
export const STATUSES: readonly Status[] = [
    "draft",
    "open",
    "filled",
    "wontfix",
];

/** Answer records whether anyone can supply the fact ("" for neither). */
export type Answer = "" | "deferred" | "unknown";
export const ANSWERS: readonly Answer[] = ["", "deferred", "unknown"];

/** validKind reports a recognised kind. */
export function validKind(k: string): k is Kind {
    return (KINDS as readonly string[]).includes(k);
}

/** validStatus reports a recognised status. */
export function validStatus(s: string): s is Status {
    return (STATUSES as readonly string[]).includes(s);
}

/** validAnswer reports a recognised answer. */
export function validAnswer(a: string): a is Answer {
    return (ANSWERS as readonly string[]).includes(a);
}

/** closed reports a status whose file lives in {@link CLOSED_DIR}. */
export function closed(s: string): boolean {
    return s === "filled" || s === "wontfix";
}

/** CLOSED_DIR is the subfolder of filled and wontfix gap files. */
export const CLOSED_DIR = "closed";
/** MAX_SLUG caps a file name's slug; FALLBACK_SLUG replaces an empty one. */
export const MAX_SLUG = 60;
export const FALLBACK_SLUG = "gap";

/** ID_RE matches a gap ID and captures its number. */
export const ID_RE = /^gap-([0-9]{4,})$/;
/** FILE_RE matches a gap file name and captures its number. */
export const FILE_RE = /^gap-([0-9]+)(?:-[^/]*)?\.md$/;
/** HEAD_RE matches an ATX heading of level 1 or 2. */
export const HEAD_RE = /^#{1,2}(?:[ \t]|$)/;

/** FillRef is one filled_by entry. */
export interface FillRef {
    /** ref is "<identity>#<anchor>" or "<identity>". */
    ref: string;
    /** hash is the section's {@link hash} when recorded, else "". */
    hash: string;
}

/** StaleReason says why a filled_by entry no longer vouches. */
export type StaleReason = "changed" | "vanished" | "unhashed";

/** StaleRef is a stale filled_by entry and why. */
export interface StaleRef {
    ref: string;
    reason: StaleReason;
}

/** ZERO_TIME is Go's zero `time.Time` (0001-01-01 UTC). */
export const ZERO_TIME: GoTime = { unix: -62135596800, nsec: 0, offset: 0 };

/** isZeroTime reports Go's `time.Time.IsZero`. */
export function isZeroTime(t: GoTime): boolean {
    return t.unix === ZERO_TIME.unix && t.nsec === 0;
}

/** Gap is one recorded gap. */
export interface Gap {
    id: string;
    status: string;
    kind: string;
    answer: string;
    /** ask names who can answer, de-duplicated; never null. */
    ask: string[];
    /** asked is the YYYY-MM-DD date the questions went out, or "". */
    asked: string;
    srdRef: string;
    docID: string;
    headingPath: string[];
    searchTerms: string[];
    hits: number;
    created: GoTime;
    filledBy: FillRef[];
    topic: string;
    demand: string;
    detail: string;
    targetClaim: string;
    /** file is the path within the gap folder, "closed/…" when closed. */
    file: string;
    /** score is the query relevance; 0 without a query. */
    score: number;
    stale: boolean;
    staleRefs: StaleRef[];
}

/** emptyGap returns a gap with Go's zero values. */
export function emptyGap(): Gap {
    return {
        id: "",
        status: "",
        kind: "",
        answer: "",
        ask: [],
        asked: "",
        srdRef: "",
        docID: "",
        headingPath: [],
        searchTerms: [],
        hits: 0,
        created: ZERO_TIME,
        filledBy: [],
        topic: "",
        demand: "",
        detail: "",
        targetClaim: "",
        file: "",
        score: 0,
        stale: false,
        staleRefs: [],
    };
}

/** Stable codes of the gap errors. */
export const EC_NOT_FOUND = "ECGapNotFound";
export const EC_STATUS = "ECGapStatus";
export const EC_INVALID = "ECGapInvalid";
export const EC_BAD_FILE = "ECGapBadFile";

/** GapError is a store error carrying its stable code. */
export class GapError extends Error {
    constructor(
        readonly code: string,
        message: string,
        options?: { cause?: unknown },
    ) {
        super(message, options);
        this.name = "GapError";
    }
}

/** Go's sentinel texts, which every wrapped message starts with. */
const SENTINEL: Readonly<Record<string, string>> = {
    [EC_NOT_FOUND]: "gap not found",
    [EC_STATUS]: "gap status does not allow the operation",
    [EC_INVALID]: "invalid gap input",
    [EC_BAD_FILE]: "invalid gap file",
};

/** gapError builds the error Go's `fmt.Errorf("%w: …", ErrX, …)` gives. */
export function gapError(code: string, detail?: string): GapError {
    const head = SENTINEL[code] as string;
    return new GapError(
        code,
        detail === undefined ? head : `${head}: ${detail}`,
    );
}

/** isGapError reports err (or a cause) carrying code. */
export function isGapError(err: unknown, code: string): boolean {
    return errorIs(err, (e) => e instanceof GapError && e.code === code);
}

const invalid = (detail: string) => gapError(EC_INVALID, detail);

/**
 * hash returns the hex SHA-256 a filled_by entry records for a section's
 * text, normalized so cosmetic saves keep it: CRLF becomes LF, then
 * trailing spaces, tabs and line endings are dropped.
 */
export function hash(text: string): string {
    return sha256Hex(trimRight(text.replaceAll("\r\n", "\n"), " \t\r\n"));
}

/**
 * validateGap reports an author-supplied field a new gap cannot store (Go
 * `Gap.validate`).
 */
export function validateGap(gap: Gap): void {
    if (!validKind(gap.kind))
        throw invalid(`unknown kind ${goQuote(gap.kind)}`);
    if (!validAnswer(gap.answer))
        throw invalid(`unknown answer ${goQuote(gap.answer)}`);
    checkAsk(gap.ask);
    checkAsked(gap.asked);
    checkTopic(gap.topic);
    checkRequired("demand", gap.demand);
    checkRequired("detail", gap.detail);
    checkSection("target_claim", gap.targetClaim);
}

/**
 * checkGap reports why a fully specified gap cannot be written as is (Go
 * `Gap.Check`): the author fields, plus id, status, hits, created and
 * filled_by. It does not resolve corpus references.
 */
export function checkGap(gap: Gap): void {
    if (!ID_RE.test(gap.id))
        throw invalid(`want id gap-NNNN, have ${goQuote(gap.id)}`);
    if (!validStatus(gap.status))
        throw invalid(`unknown status ${goQuote(gap.status)}`);
    validateGap(gap);
    if (gap.hits < 1)
        throw invalid(`hits must be at least 1, have ${gap.hits}`);
    if (isZeroTime(gap.created)) throw invalid("created is required");
    for (const ref of gap.filledBy) {
        if (trimSpace(ref.ref) === "") throw invalid("blank filled_by entry");
    }
    if (gap.status === "filled" && gap.filledBy.length === 0) {
        throw invalid("a filled gap needs filled_by");
    }
}

/** fileName returns gap-NNNN-<slug>.md for the gap's ID and topic. */
export function fileName(gap: Pick<Gap, "id" | "topic">): string {
    const s = fileSlug(gap.topic, MAX_SLUG);
    return `${gap.id}-${s !== "" ? s : FALLBACK_SLUG}.md`;
}

/** filePath returns where the gap's file belongs within the gap folder. */
export function filePath(gap: Pick<Gap, "id" | "topic" | "status">): string {
    return home(fileName(gap), gap.status);
}

/**
 * home returns where a file named name belongs for a gap in status sts: at
 * the top for draft and open, in {@link CLOSED_DIR} otherwise.
 */
export function home(name: string, sts: string): string {
    const base = posixBase(name);
    return closed(sts) ? posixJoin(CLOSED_DIR, base) : base;
}

/** Patch changes some author fields; an undefined field is left alone. */
export interface Patch {
    kind?: string;
    answer?: string;
    ask?: string[];
    asked?: string;
    srdRef?: string;
    docID?: string;
    headingPath?: string[];
    searchTerms?: string[];
    topic?: string;
    demand?: string;
    detail?: string;
    targetClaim?: string;
    /** addHit bumps the hit count by one. */
    addHit?: boolean;
}

/** validatePatch reports a field the gap cannot store, or an empty patch. */
export function validatePatch(pch: Patch): void {
    const fields = Object.entries(pch).filter(
        ([k, v]) => v !== undefined && !(k === "addHit" && v === false),
    );
    if (fields.length === 0) throw invalid("nothing to update");
    if (pch.kind !== undefined && !validKind(pch.kind))
        throw invalid(`unknown kind ${goQuote(pch.kind)}`);
    if (pch.answer !== undefined && !validAnswer(pch.answer)) {
        throw invalid(`unknown answer ${goQuote(pch.answer)}`);
    }
    if (pch.ask !== undefined) checkAsk(pch.ask);
    if (pch.asked !== undefined) checkAsked(pch.asked);
    if (pch.topic !== undefined) checkTopic(pch.topic);
    if (pch.demand !== undefined) checkRequired("demand", pch.demand);
    if (pch.detail !== undefined) checkRequired("detail", pch.detail);
    if (pch.targetClaim !== undefined)
        checkSection("target_claim", pch.targetClaim);
}

/** Fill records the sections that state an open gap's fact. */
export interface Fill {
    /** refs replace the gap's filled_by list. */
    refs: string[];
    /** complete moves an open gap to filled. */
    complete: boolean;
    /** remaining, when set, replaces the Detail section. */
    remaining?: string;
}

/** validateFill reports an empty or blank list, or a bad remaining text. */
export function validateFill(fll: Fill): void {
    if (fll.refs.length === 0) throw invalid("filled_by is required");
    for (const ref of fll.refs) {
        if (trimSpace(ref) === "") throw invalid("blank filled_by entry");
    }
    if (fll.remaining !== undefined) checkSection("remaining", fll.remaining);
}

/** BadFile is an invalid gap file and why. */
export interface BadFile {
    file: string;
    reason: string;
}

/** Move is a gap file the store moved between folders. */
export interface Move {
    from: string;
    to: string;
}

/** Filter selects gaps for {@link Store.list}; empty matches every gap. */
export interface Filter {
    status?: string;
    /** srdRef keeps gaps whose srd_ref contains it. */
    srdRef?: string;
    /** query ranks gaps by relevance (BM25) and keeps the matches. */
    query?: string;
    /** stale keeps only stale gaps. */
    stale?: boolean;
    /** ask keeps gaps with an ask name containing it, ignoring case. */
    ask?: string;
    /** asked keeps gaps with (true) or without (false) an asked date. */
    asked?: boolean;
}

/** matchFilter reports whether gap passes flt (Go `Filter.match`). */
export function matchFilter(flt: Filter, gap: Gap): boolean {
    if (flt.status && gap.status !== flt.status) return false;
    if (flt.stale && !gap.stale) return false;
    if (flt.asked !== undefined && (gap.asked !== "") !== flt.asked)
        return false;
    const ask = goLower(trimSpace(flt.ask ?? ""));
    if (ask !== "" && !gap.ask.some((name) => goLower(name).includes(ask)))
        return false;
    return gap.srdRef.includes(flt.srdRef ?? "");
}

/** goLower is Go's `strings.ToLower`. */
function goLower(s: string): string {
    let out = "";
    for (const ch of s)
        out += String.fromCodePoint(goToLower(ch.codePointAt(0) as number));
    return out;
}

/** ResolvedRef is a normalized reference and the hash of the text it names. */
export interface ResolvedRef {
    norm: string;
    hash: string;
}

/** Resolver checks the corpus references a gap stores. */
export interface Resolver {
    /** resolve checks a doc_id or fill ref; invalid refs throw ErrInvalid. */
    resolve(ref: string): Promise<ResolvedRef>;
    /** resolveFill also refuses a document that may not fill a gap. */
    resolveFill(ref: string): Promise<ResolvedRef>;
    /** current returns the hash of ref's text in the current corpus. */
    current(ref: string): Promise<string>;
}

/** Store records and retrieves gaps. */
export interface Store {
    append(gap: Gap): Promise<string>;
    appendDraft(gap: Gap): Promise<string>;
    update(id: string, pch: Patch): Promise<void>;
    submit(id: string): Promise<void>;
    discard(id: string): Promise<void>;
    fill(id: string, fll: Fill): Promise<void>;
    reopen(id: string, reason: string): Promise<void>;
    wontfix(id: string, reason: string): Promise<void>;
    list(filter: Filter): Promise<Gap[]>;
    badFiles(): Promise<BadFile[]>;
}

/** checkTopic reports a blank topic or one that is not one line. */
export function checkTopic(topic: string): void {
    if (trimSpace(topic) === "") throw invalid("topic is required");
    if (/[\r\n]/.test(topic)) throw invalid("topic must be one line");
}

/** checkAsk reports a blank ask name. */
export function checkAsk(names: readonly string[]): void {
    for (const name of names) {
        if (trimSpace(name) === "") throw invalid("blank ask name");
    }
}

/** checkAsked reports an asked date that is neither "" nor YYYY-MM-DD. */
export function checkAsked(date: string): void {
    const err = checkDate(date);
    if (err !== undefined) throw invalid(`asked: ${err}`);
}

/** checkDate returns why date is neither "" nor YYYY-MM-DD, if it is not. */
export function checkDate(date: string): string | undefined {
    if (date === "") return undefined;
    try {
        parseTime("DateOnly", date);
        return undefined;
    } catch {
        return `want a YYYY-MM-DD date, have ${goQuote(date)}`;
    }
}

/** checkRequired reports a blank section field, or one checkSection refuses. */
export function checkRequired(name: string, text: string): void {
    if (trimSpace(text) === "") throw invalid(`${name} is required`);
    checkSection(name, text);
}

/** checkSection reports a section field holding a level-1 or -2 heading. */
export function checkSection(name: string, text: string): void {
    for (const line of text.split("\n")) {
        if (HEAD_RE.test(trimRight(line, " \t\r"))) {
            throw invalid(`${name} must not hold a level-1 or level-2 heading`);
        }
    }
}
