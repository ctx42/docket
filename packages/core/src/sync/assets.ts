// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Image-asset download, ported from the download half of `pkg/docket/assets.go`.
// A pull resolves every file-media reference in a page against the page's
// attachments and downloads each into the shared assets directory (under the sync
// root, so Obsidian `![[…]]` embeds resolve), returning a map from each media node
// localId to the image path relative to the note. Everything goes through the
// injected {@link ConfluenceClient} and {@link FileSystem} ports. Upload/canonical
// naming (`canonicalAssetName`) is the push side, M7.3.

import type { Attachment, ConfluenceClient } from "../confluence/client.ts";
import type { MediaRef } from "../models/adf.ts";
import type { FileSystem } from "../ports/fs.ts";
import { posixDir, posixExt, posixJoin, posixRel } from "../util/path.ts";

/**
 * assetsFromDisk reconstructs the {@link downloadImages} assets map — media node
 * localId → image path relative to `dest` — from the files already in
 * `assetsDir`, without any network I/O. A pull uses it on a version/cache hit
 * (the page body was served from the ADF cache, so its images were downloaded by
 * an earlier pull and are already on disk), skipping the attachment round-trip.
 *
 * It matches each ref to a file named `{fileId}-{localId}{ext}` — or, for an
 * inline file link, `{fileId}-{localId}-{title}` — the name {@link assetName}
 * writes, by prefix, since the extension and title come from the attachment
 * metadata, which is not known here. It returns null (signalling
 * the caller to fall back to {@link downloadImages}) if ANY referenced image is
 * absent: a ref never resolved to an attachment, or a prior pull was interrupted
 * after the ADF was cached but before its images were downloaded. Returning the
 * whole map or nothing keeps the fallback all-or-nothing, so a partial map never
 * renders a page with some images missing.
 */
export async function assetsFromDisk(
    fs: FileSystem,
    assetsDir: string,
    dest: string,
    refs: MediaRef[],
): Promise<Record<string, string> | null> {
    if (refs.length === 0) {
        return {};
    }
    let entries: string[];
    try {
        entries = await fs.readdir(assetsDir);
    } catch {
        return null; // no assets dir yet: nothing on disk to reconstruct from
    }
    const assets: Record<string, string> = {};
    for (const ref of refs) {
        const prefix = `${ref.fileId}-${ref.localId}`;
        const name = entries.find(
            (e) =>
                e === prefix ||
                e.startsWith(`${prefix}.`) ||
                (ref.inline && e.startsWith(`${prefix}-`)),
        );
        if (name === undefined) {
            return null; // a referenced image is missing: fall back to a fetch
        }
        assets[ref.localId] = relPath(dest, posixJoin(assetsDir, name));
    }
    return assets;
}

/** ImagePlan is where each image of a page lands, before anything downloads. */
export interface ImagePlan {
    /** Media node localId → image path relative to the note. */
    assets: Record<string, string>;
    /** The attachments to fetch, each with the vault path it is written to. */
    downloads: { link: string; path: string }[];
}

/**
 * planImages resolves every file-media reference against the page's attachments
 * and returns the {@link downloadImages} assets map without downloading: the
 * file names come from the attachment metadata ({@link assetName}), not its
 * bytes. A reference with no matching attachment is left out (it renders as a
 * placeholder).
 */
export async function planImages(
    client: ConfluenceClient,
    assetsDir: string,
    pageId: string,
    dest: string,
    refs: MediaRef[],
): Promise<ImagePlan> {
    const plan: ImagePlan = { assets: {}, downloads: [] };
    if (refs.length === 0) {
        return plan;
    }
    const atts = await client.fetchAttachments(pageId);
    for (const ref of refs) {
        const att = atts.get(ref.fileId);
        if (att === undefined) {
            continue;
        }
        const path = posixJoin(assetsDir, assetName(ref, att));
        plan.assets[ref.localId] = relPath(dest, path);
        plan.downloads.push({ link: att.downloadLink, path });
    }
    return plan;
}

/**
 * downloadImages resolves every file-media reference against the page's
 * attachments, downloads each matched image into `assetsDir`, and returns a map
 * from each media node localId to the image path relative to `dest`. A reference
 * with no matching attachment is skipped (it renders as a placeholder), and an
 * image already on disk is left in place.
 */
export async function downloadImages(
    client: ConfluenceClient,
    fs: FileSystem,
    assetsDir: string,
    pageId: string,
    dest: string,
    refs: MediaRef[],
): Promise<Record<string, string>> {
    const plan = await planImages(client, assetsDir, pageId, dest, refs);
    for (const d of plan.downloads) {
        await ensureAsset(client, fs, d.link, d.path);
    }
    return plan.assets;
}

/**
 * ensureAsset downloads the attachment at `downloadLink` to `path`, unless a file
 * is already present there.
 */
export async function ensureAsset(
    client: ConfluenceClient,
    fs: FileSystem,
    downloadLink: string,
    path: string,
): Promise<void> {
    if (await fs.exists(path)) {
        return;
    }
    await fs.write(path, await client.download(downloadLink));
}

/**
 * assetName builds the on-disk file name for a media reference,
 * `{fileId}-{localId}{ext}`, with the extension taken from the attachment's media
 * type. The localId makes the name unique per media node. An inline file link
 * (`mediaInline`) is named `{fileId}-{localId}-{title}` instead, so the rendered
 * link can show the attachment's title (see `renderMediaInline`); a title-less
 * attachment falls back to the plain form.
 */
export function assetName(ref: MediaRef, att: Attachment): string {
    const prefix = `${ref.fileId}-${ref.localId}`;
    const title = safeTitle(att.title);
    if (ref.inline && title !== "") {
        return `${prefix}-${title}`;
    }
    return `${prefix}${imageExt(att.mediaType, att.title)}`;
}

/**
 * safeTitle makes an attachment title safe as a file name and as an Obsidian
 * wiki-link target and alias: a path separator, a character Windows forbids, a
 * control character, or one that ends or splits a wiki link (`#`, `^`, `[`,
 * `]`, `|`) becomes `_`. Surrounding whitespace is trimmed.
 */
function safeTitle(title: string): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are stripped on purpose
    return title.trim().replace(/[\x00-\x1f/\\:*?"<>|#^[\]]/g, "_");
}

/**
 * imageExt returns the file extension for an image, preferring a known mapping
 * from its media type and falling back to the title's extension.
 */
export function imageExt(mediaType: string, title: string): string {
    switch (mediaType) {
        case "image/jpeg":
            return ".jpg";
        case "image/png":
            return ".png";
        case "image/gif":
            return ".gif";
        case "image/webp":
            return ".webp";
        case "image/svg+xml":
            return ".svg";
        case "image/bmp":
            return ".bmp";
        case "image/tiff":
            return ".tiff";
        default:
            return posixExt(title);
    }
}

/** relPath returns `target` relative to the directory of `dest`, for a Markdown link. */
export function relPath(dest: string, target: string): string {
    return posixRel(posixDir(dest), target);
}
