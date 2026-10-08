// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// docket's ignore list: the lines between `# docket:begin` and `# docket:end` in
// the vault-root `.gitignore`. Pure text in, text out — the host reads and
// writes the file. Every line outside the block is kept byte for byte.

/** IGNORE_BEGIN and IGNORE_END delimit docket's block in `.gitignore`. */
export const IGNORE_BEGIN = "# docket:begin";
export const IGNORE_END = "# docket:end";

/** DEFAULT_IGNORES are the entries a newly written block starts with. */
export const DEFAULT_IGNORES: readonly string[] = [
    ".obsidian/workspace*.json",
    ".obsidian/cache",
    ".trash/",
    ".adf_cache/",
];

/** blockRange locates the block's begin and end line indexes, or null. */
function blockRange(lines: string[]): [number, number] | null {
    const begin = lines.findIndex((l) => l.trim() === IGNORE_BEGIN);
    if (begin < 0) return null;
    const end = lines.findIndex((l, i) => i > begin && l.trim() === IGNORE_END);
    return end < 0 ? null : [begin, end];
}

/** ignoreEntries returns the entries in `text`'s block, or null when it has none. */
export function ignoreEntries(text: string): string[] | null {
    const lines = text.split(/\r?\n/);
    const r = blockRange(lines);
    if (r === null) return null;
    return lines
        .slice(r[0] + 1, r[1])
        .map((l) => l.trimEnd())
        .filter((l) => l !== "");
}

/**
 * withIgnoreEntries returns `text` with its block holding exactly `entries`. A
 * text without a block gets one appended, after a blank line when the text is
 * not empty. The text's line ending (CRLF or LF) is kept.
 */
export function withIgnoreEntries(text: string, entries: string[]): string {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const block = [IGNORE_BEGIN, ...entries, IGNORE_END];
    const lines = text.split(/\r?\n/);
    const r = blockRange(lines);
    if (r !== null) {
        lines.splice(r[0], r[1] - r[0] + 1, ...block);
        return lines.join(eol);
    }
    let head = text;
    if (head !== "" && !head.endsWith("\n")) head += eol;
    if (head.trim() !== "") head += eol;
    return head + block.join(eol) + eol;
}

/**
 * addIgnoreEntry returns `text` with `entry` added to its block — a missing
 * block is first created with {@link DEFAULT_IGNORES} — or `text` unchanged when
 * the block already holds the entry.
 */
export function addIgnoreEntry(text: string, entry: string): string {
    const cur = ignoreEntries(text);
    if (cur?.includes(entry)) return text;
    const base = cur ?? [...DEFAULT_IGNORES];
    return withIgnoreEntries(
        text,
        base.includes(entry) ? base : [...base, entry],
    );
}

/** defaultIgnoreBlock returns `text` with a block of the default entries. */
export function defaultIgnoreBlock(text: string): string {
    return ignoreEntries(text) === null
        ? withIgnoreEntries(text, [...DEFAULT_IGNORES])
        : text;
}

/**
 * ignorePattern turns a vault-relative path into a `.gitignore` pattern that
 * matches exactly it: anchored to the vault root, folder patterns ending in
 * `/`, and wildcard and trailing-space characters escaped.
 */
export function ignorePattern(path: string, folder: boolean): string {
    const esc = path.replace(/[\\*?[]/g, (c) => `\\${c}`).replace(/ $/, "\\ ");
    return `/${esc}${folder ? "/" : ""}`;
}
