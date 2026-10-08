// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Corpus documents ported from Go `pkg/corpus/corpus.go`: loading a Markdown
// file into a document and its retrievable chunks, and the heading anchors
// and section texts that gap fills cite (`<doc>#<anchor>`). Anchors and
// section texts feed the gap hashes, so they reproduce Go byte for byte.

import { trimSpace } from "../gocompat/strings.ts";
import type { DocFs } from "../ports.ts";
import {
    DEFAULT_WHOLE_FILE_TOKENS,
    headingLevel,
    headingLines,
    headingText,
    splitSections,
} from "./chunker.ts";
import { parseFrontMatter } from "./frontmatter.ts";
import { sourceURL } from "./helpers.ts";

/** Chunk is a retrievable section of a {@link Doc}. */
export interface Chunk {
    /** docID is the source document's identity, as {@link Doc.id}. */
    docID: string;
    /** docPath is the source document's corpus path, as {@link Doc.path}. */
    docPath: string;
    title: string;
    /** headingPath is the heading trail from the document root. */
    headingPath: string[];
    /** text is the section's raw Markdown, heading line included. */
    text: string;
    /** sourceURL is the document's canonical URL; never a fragment. */
    sourceURL: string;
    aliases: string[];
    /** startLine is the 1-based body line where the section begins. */
    startLine: number;
}

/**
 * chunkPrefix returns the citation heading trail: the title and heading
 * path joined with " > ", empty parts skipped.
 */
export function chunkPrefix(chk: Pick<Chunk, "title" | "headingPath">): string {
    return [chk.title, ...chk.headingPath].filter((p) => p !== "").join(" > ");
}

/** Doc is a parsed Markdown document and the chunks derived from it. */
export interface Doc {
    /** id is the front-matter id when set, else the path. */
    id: string;
    /** path is the caller-assigned corpus path, unique within a corpus. */
    path: string;
    /** title is the front-matter title, falling back to the file name. */
    title: string;
    /** sourceURL is the front-matter url, else the first body URL, or "". */
    sourceURL: string;
    aliases: string[];
    chunks: Chunk[];
}

/** CorpusError wraps a load failure as Go's `xrr.New(msg, WithCause(err))`. */
export class CorpusError extends Error {
    /** code is the cause's stable code, if it has one. */
    readonly code: string | undefined;

    constructor(prefix: string, cause: unknown) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        super(`${prefix}: ${msg}`, { cause });
        this.name = "CorpusError";
        const code = (cause as { code?: unknown } | null)?.code;
        this.code = typeof code === "string" ? code : undefined;
    }
}

/** Loader ingests Markdown files into chunked {@link Doc}s. */
export class Loader {
    /**
     * @param fs reads the files.
     * @param wholeFileTokensOverride replaces the whole-file chunk threshold
     *   when positive.
     */
    constructor(
        private readonly fs: DocFs,
        private readonly wholeFileTokensOverride = 0,
    ) {}

    /** wholeFileTokens returns the effective whole-file chunk threshold. */
    wholeFileTokens(): number {
        return this.wholeFileTokensOverride > 0
            ? this.wholeFileTokensOverride
            : DEFAULT_WHOLE_FILE_TOKENS;
    }

    /**
     * file parses the Markdown file at path into a {@link Doc} at corpus path
     * docPath. It throws a {@link CorpusError}: "read: …" when the file cannot
     * be read, "<path>: front-matter: …" when its front matter is malformed.
     */
    async file(docPath: string, path: string): Promise<Doc> {
        let raw: string;
        try {
            raw = await this.fs.readText(path);
        } catch (err) {
            throw new CorpusError("read", err);
        }
        let parsed: ReturnType<typeof parseFrontMatter>;
        try {
            parsed = parseFrontMatter(raw);
        } catch (err) {
            throw new CorpusError(path, err);
        }
        const { fm, body } = parsed;
        const base = path.slice(path.lastIndexOf("/") + 1);
        const title = fm.title !== "" ? fm.title : base.replace(/\.md$/, "");
        const docURL = fm.url !== "" ? fm.url : sourceURL(body);
        const id = fm.id !== "" ? fm.id : docPath;
        const aliases = fm.aliases ?? [];
        return {
            id,
            path: docPath,
            title,
            sourceURL: docURL,
            aliases,
            chunks: splitSections(body, this.wholeFileTokens()).map((sec) => ({
                docID: id,
                docPath,
                title,
                headingPath: sec.headingPath,
                text: sec.text,
                sourceURL: docURL,
                aliases,
                startLine: sec.startLine,
            })),
        };
    }
}

/** Heading is one body heading of a Markdown document. */
export interface Heading {
    /** level is the ATX level, 1 to 6. */
    level: number;
    /** text is the heading text without its "#" markers. */
    text: string;
    /**
     * anchor names the heading in a section reference, without "#": the
     * {@link slug} of text, suffixed "-1", "-2", … when an earlier heading
     * has the same slug.
     */
    anchor: string;
}

/**
 * anchors splits the Markdown document src into its body and the anchor of
 * each body heading, keyed by the heading's 0-based body line.
 */
export function anchors(src: string): {
    body: string;
    anchors: Map<number, string>;
} {
    const { body, headings } = bodyHeadings(src);
    return { body, anchors: new Map(headings.map((h) => [h.line, h.anchor])) };
}

/**
 * frontMatterURL returns the front-matter url of src, "" when unset; unlike
 * {@link Doc.sourceURL} it never falls back to a body URL.
 */
export function frontMatterURL(src: string): string {
    return parseFrontMatter(src).fm.url;
}

/**
 * slug returns the GitHub-style anchor of a heading's text: trimmed and
 * lowercased, every character other than a letter, decimal digit, space,
 * "-" or "_" dropped, and each space turned into "-".
 */
export function slug(text: string): string {
    let out = "";
    for (const ch of trimSpace(text)) {
        const r = goToLower(ch);
        if (r === " ") out += "-";
        else if (r === "-" || r === "_" || LETTER_OR_DIGIT.test(r)) out += r;
    }
    return out;
}

/** LETTER_OR_DIGIT is Go's `unicode.IsLetter || unicode.IsDigit` (Nd only). */
const LETTER_OR_DIGIT = /^[\p{L}\p{Nd}]$/u;

/**
 * goToLower lowercases one code point as Go's `unicode.ToLower` does: the
 * simple mapping, with no context rules (final sigma) and no expansions.
 */
function goToLower(ch: string): string {
    if (ch === "İ") return "i";
    const lower = ch.toLowerCase();
    return [...lower].length === 1 ? lower : ch;
}

/** headings returns the body headings of src in document order. */
export function headings(src: string): Heading[] {
    return bodyHeadings(src).headings.map(({ level, text, anchor }) => ({
        level,
        text,
        anchor,
    }));
}

/**
 * section returns the section of src whose heading has anchor: the heading
 * line through the line before the next heading of the same or a higher
 * level, or through the end of the body, as written. found is false when no
 * heading has the anchor.
 */
export function section(
    src: string,
    anchor: string,
): { text: string; found: boolean } {
    const { body, headings: hdgs } = bodyHeadings(src);
    const lines = body.split("\n");
    for (const [i, bhd] of hdgs.entries()) {
        if (bhd.anchor !== anchor) continue;
        let end = lines.length;
        for (const next of hdgs.slice(i + 1)) {
            if (next.level <= bhd.level) {
                end = next.line;
                break;
            }
        }
        return { text: lines.slice(bhd.line, end).join("\n"), found: true };
    }
    return { text: "", found: false };
}

/** BodyHeading is a {@link Heading} and its 0-based body line. */
interface BodyHeading extends Heading {
    line: number;
}

/** bodyHeadings returns src's body and its headings, fences skipped. */
function bodyHeadings(src: string): { body: string; headings: BodyHeading[] } {
    const { body } = parseFrontMatter(src);
    const lines = body.split("\n");
    const seen = new Map<string, number>();
    const out: BodyHeading[] = [];
    for (const num of headingLines(body)) {
        const line = lines[num] as string;
        const text = headingText(line);
        let anchor = slug(text);
        const n = seen.get(anchor) ?? 0;
        if (n > 0) {
            seen.set(anchor, n + 1);
            anchor += `-${n}`;
        } else {
            seen.set(anchor, 1);
        }
        out.push({ level: headingLevel(line), text, anchor, line: num });
    }
    return { body, headings: out };
}
