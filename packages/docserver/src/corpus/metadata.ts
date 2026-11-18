// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// A document's metadata table: the two-column key/value table a page may
// open its body with (Confluence page properties, an SRD's Status and
// Owners). It is read as plain text, so a caller can list a field across
// the corpus without reading each document.

import { splitTableRow } from "@docket/core";

/** MENTIONS_RE matches a run of adjacent mention spans (`adf:@Name`). */
const MENTIONS_RE = /(?:`adf:@[^`]*`\s*)+/g;

/** SEPARATOR_RE matches a table separator cell such as `---` or `:-:`. */
const SEPARATOR_RE = /^:?-+:?$/;

/**
 * metadataTable returns the rows of the table that opens body, each key
 * and value as {@link plainCell} text; the first of a repeated key wins. Only
 * two-cell rows count, and a row with an empty key is skipped. A body whose
 * first non-blank line is not a table row yields none.
 */
export function metadataTable(body: string): Record<string, string> {
    const out: Record<string, string> = {};
    const lines = body.split("\n");
    let i = 0;
    while (i < lines.length && (lines[i] as string).trim() === "") i++;
    for (; i < lines.length; i++) {
        const line = (lines[i] as string).trim();
        if (!line.startsWith("|")) break;
        const cells = splitTableRow(line);
        if (cells.length !== 2) continue;
        if (cells.every((c) => SEPARATOR_RE.test(c))) continue;
        const key = plainCell(cells[0] as string);
        if (key === "" || Object.hasOwn(out, key)) continue;
        out[key] = plainCell(cells[1] as string);
    }
    return out;
}

/**
 * plainCell returns the plain text of a table cell: a status label
 * (`adf:!TEXT|…`) as its text, mentions (`adf:@Name`) as names joined with
 * ", ", any other code span as its content, a link as its label, an
 * autolink as its URL, bold and `__` emphasis markers dropped, and
 * whitespace collapsed.
 */
export function plainCell(cell: string): string {
    const s = cell
        .replace(MENTIONS_RE, (run) => {
            const names = [...run.matchAll(/`adf:@([^`]*)`/g)];
            return ` ${names.map((m) => (m[1] as string).trim()).join(", ")} `;
        })
        .replace(/`adf:!([^`|]*)[^`]*`/g, "$1")
        .replace(/`([^`]*)`/g, "$1")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/<([a-z][a-z0-9+.-]*:[^>]*)>/gi, "$1")
        .replace(/\*+|_{2,}/g, "");
    return s.replace(/\s+/g, " ").trim();
}
