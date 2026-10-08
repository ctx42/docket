// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The remote side of the plugin's Confluence diff: for each note a status check
// lists as changed, the Markdown body a pull would write for its page, byte for
// byte, without writing anything. A note whose remote has not moved diffs
// against its cached base render; one whose remote moved is fetched at the
// version the check reported and rendered the way pull renders it — same link
// mapping, margin, and comments — with image paths taken from the attachment
// metadata instead of downloaded images.

import { pageDoc } from "../cache/cache.ts";
import { fileMedia } from "../models/adf.ts";
import { mapPool } from "../util/pool.ts";
import { planImages } from "./assets.ts";
import { toRenderComments } from "./comments.ts";
import { PULL_CONCURRENCY, readCacheBody, renderNote } from "./pull.ts";
import {
    type PreflightDeps,
    type PreflightEntry,
    splitFrontmatter,
} from "./push.ts";
import type { StatusReport } from "./status.ts";

/** RemoteDeps are the ports a remote-body render reads. */
export interface RemoteDeps extends PreflightDeps {
    /** The shared image directory pull writes into, for the image paths. */
    assetsDir: string;
}

/** RemoteBody is a note's remote body, or why it could not be had. */
export type RemoteBody = { body: string } | { error: string };

/**
 * remoteBody returns the body (frontmatter stripped) a pull would write for the
 * page of status entry `e`. A `modified` note reads its cached base render; a
 * `remote-moved` or `diverged` one is fetched at `e.remoteVersion` and
 * rendered. It throws when the base render is not cached, or a fetch fails —
 * comments included, since rendering without them would mark every callout.
 */
export async function remoteBody(
    deps: RemoteDeps,
    e: PreflightEntry,
): Promise<string> {
    const { client, fs, cacheDir, config } = deps;
    if (e.cls === "modified") {
        const body = await readCacheBody(fs, cacheDir, e.name, e.localBase);
        if (body === null) {
            throw new Error(`base render v${e.localBase} is not cached`);
        }
        return body;
    }
    const data = await client.fetchPage(e.pageId, e.remoteVersion);
    const doc = pageDoc({
        name: e.name,
        id: data.id,
        title: data.title,
        version: data.version,
        spaceId: data.spaceId,
        parentId: data.parentId,
        spaceKey: "",
        domain: config.domain,
        adf: data.adf,
    });
    const comments = config.comments
        ? toRenderComments(await client.fetchComments(e.pageId))
        : undefined;
    const plan = await planImages(
        client,
        deps.assetsDir,
        e.pageId,
        e.dest,
        fileMedia(doc),
    );
    const md = renderNote(deps, doc, e.dest, plan.assets, comments);
    return splitFrontmatter(md).body;
}

/**
 * remoteBodies returns, keyed by note path, the remote body of every note in
 * `report` that has one to diff against: outgoing edits (`modified`), incoming
 * changes, and notes changed on both sides. New, refused, and unchecked notes
 * are left out. A note whose body cannot be had gets the reason instead; one
 * failure never sinks the others.
 */
export async function remoteBodies(
    deps: RemoteDeps,
    report: StatusReport,
): Promise<Map<string, RemoteBody>> {
    const entries = [
        ...report.push.filter((e) => e.cls === "modified"),
        ...report.pull,
        ...report.diverged,
    ];
    const bodies = await mapPool(
        entries,
        PULL_CONCURRENCY,
        async (e): Promise<RemoteBody> => {
            try {
                return { body: await remoteBody(deps, e) };
            } catch (err) {
                return { error: message(err) };
            }
        },
    );
    return new Map(entries.map((e, i) => [e.dest, bodies[i] as RemoteBody]));
}

/** message renders a thrown value as text. */
function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
