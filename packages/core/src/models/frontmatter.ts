// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The frontmatter keys docket owns in a note. Every sync-bookkeeping key
// carries the flat `docket_` prefix so it never collides with a key another
// tool reads; the shared-contract keys (`id`, `title`, `url`) stay
// unprefixed. Notes pulled before the prefix still
// carry the legacy unprefixed keys: every read falls back to them, every write
// emits only the prefixed ones, so a re-pull or push migrates the note.

/** FM names each docket-owned frontmatter key. */
export const FM = {
    /** The marker: `pull` (a managed note) or `ignore-push` (kept out of push). */
    mode: "docket_mode",
    /** `true` on a page created locally and never pulled. */
    local: "docket_local",
    pageId: "docket_page_id",
    pageVersion: "docket_page_version",
    pagePath: "docket_page_path",
    spaceId: "docket_space_id",
    spaceKey: "docket_space_key",
    parentId: "docket_parent_id",
    domain: "docket_domain",
    mentions: "docket_mentions",
    pageImages: "docket_page_images",
} as const;

/** FMField is a docket-owned frontmatter field, by its {@link FM} name. */
export type FMField = keyof typeof FM;

/** LEGACY_FM names each {@link FM} key as written before the `docket_` prefix. */
export const LEGACY_FM: Readonly<Record<FMField, string>> = {
    mode: "docket-plugin",
    local: "cf_local",
    pageId: "page_id",
    pageVersion: "page_version",
    pagePath: "page_path",
    spaceId: "space_id",
    spaceKey: "space_key",
    parentId: "parent_id",
    domain: "cf_domain",
    mentions: "mentions",
    pageImages: "page_images",
};

/** MODE_PULL marks a docket-managed note pulled from Confluence. */
export const MODE_PULL = "pull";

/** MODE_IGNORE_PUSH marks a note push never creates, updates, or moves. */
export const MODE_IGNORE_PUSH = "ignore-push";

/**
 * fmGet returns `field` from a parsed frontmatter object: the prefixed key when
 * present, else the legacy unprefixed key, else `undefined`.
 */
export function fmGet(o: Record<string, unknown>, field: FMField): unknown {
    const v = o[FM[field]];
    return v !== undefined ? v : o[LEGACY_FM[field]];
}

/**
 * fmKeyPattern is a regex source matching the prefixed or the legacy key of
 * `field`, for line-level reads and rewrites of raw frontmatter text.
 */
export function fmKeyPattern(field: FMField): string {
    return `(?:${escapeRe(FM[field])}|${escapeRe(LEGACY_FM[field])})`;
}

/**
 * fmRaw returns the scalar value of `field` from raw frontmatter text, unquoted
 * and trimmed: the prefixed key's line when present, else the legacy key's,
 * else `undefined`. It reads the text line by line, so it works on a note whose
 * YAML does not otherwise parse.
 */
export function fmRaw(frontmatter: string, field: FMField): string | undefined {
    return (
        rawLine(frontmatter, FM[field]) ??
        rawLine(frontmatter, LEGACY_FM[field])
    );
}

/** rawLine returns the unquoted scalar of the top-level `key:` line, if any. */
function rawLine(frontmatter: string, key: string): string | undefined {
    const re = new RegExp(
        `^${escapeRe(key)}:[ \\t]*(?:"([^"]*)"|'([^']*)'|([^\\r\\n]*?))[ \\t]*\\r?$`,
        "m",
    );
    const m = re.exec(frontmatter);
    if (m === null) {
        return undefined;
    }
    return m[1] ?? m[2] ?? m[3] ?? "";
}

/** escapeRe escapes the regex metacharacters in s. */
function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
