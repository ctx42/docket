// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Corpus path prefixes: whether a document path lies under a folder, by
// whole path segments, for the trust ranking and the folder filter of
// search and the document list.

import { posixClean } from "@docket/core";

/**
 * under reports whether a document path lies under prefix pfx, comparing
 * whole path segments; an empty pfx covers nothing.
 */
export function under(path: string, pfx: string): boolean {
    if (pfx === "") return false;
    return path === pfx || path.startsWith(`${pfx}/`);
}

/**
 * cleanFolder returns a folder filter as a document path prefix: trimmed,
 * cleaned of `./` and trailing slashes; "" when it names no folder.
 */
export function cleanFolder(folder: string): string {
    const trimmed = folder.trim();
    if (trimmed === "") return "";
    const clean = posixClean(trimmed);
    return clean === "." ? "" : clean;
}

/**
 * inFolder reports whether a document path lies under folder (see
 * {@link cleanFolder}); a folder that names none keeps every path.
 */
export function inFolder(path: string, folder: string): boolean {
    const pfx = cleanFolder(folder);
    return pfx === "" || under(path, pfx);
}
