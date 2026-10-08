// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Go `strings` functions whose JavaScript look-alikes differ: Go's notion of
// whitespace is `unicode.IsSpace` (it includes U+0085 and excludes U+FEFF,
// unlike JS `\s`), and Go trims by cutset rather than by pattern.

/** GO_SPACE_CLASS is the regex class body of Go's `unicode.IsSpace`. */
export const GO_SPACE_CLASS =
    "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

const SPACE_RUN = new RegExp(`[${GO_SPACE_CLASS}]+`);
const LEADING = new RegExp(`^[${GO_SPACE_CLASS}]+`);
const TRAILING = new RegExp(`[${GO_SPACE_CLASS}]+$`);

/** fields splits s around runs of Go whitespace (Go `strings.Fields`). */
export function fields(s: string): string[] {
    return s.split(SPACE_RUN).filter((f) => f !== "");
}

/** trimSpace drops leading and trailing Go whitespace (`strings.TrimSpace`). */
export function trimSpace(s: string): string {
    return s.replace(LEADING, "").replace(TRAILING, "");
}

/** trimRight drops trailing characters found in cutset (`strings.TrimRight`). */
export function trimRight(s: string, cutset: string): string {
    let end = s.length;
    while (end > 0 && cutset.includes(s[end - 1] as string)) end--;
    return s.slice(0, end);
}

/** trimLeft drops leading characters found in cutset (`strings.TrimLeft`). */
export function trimLeft(s: string, cutset: string): string {
    let start = 0;
    while (start < s.length && cutset.includes(s[start] as string)) start++;
    return s.slice(start);
}
