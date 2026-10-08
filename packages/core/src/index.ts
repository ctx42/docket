// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

/**
 * `@docket/core` is the runtime-neutral heart of docket: the ADF↔Markdown
 * retentive lens, sync orchestration, and the port interfaces through which all
 * I/O is injected. It imports nothing from `node:`, `bun:`, or `obsidian` — the
 * boundary test in `test/boundary.test.ts` fails CI on any leak, which is what
 * keeps the mobile-ready promise real.
 *
 * Modules land here from M1.1 onward.
 */
export const PACKAGE_NAME = "@docket/core";

export * from "./adf/lens/build.ts";
export * from "./adf/lens/diff.ts";
export * from "./adf/lens/merge.ts";
export * from "./adf/lens/reconstruct.ts";
export * from "./adf/lens/sourcemap.ts";
export * from "./adf/links.ts";
export * from "./adf/parse/blocks.ts";
export * from "./adf/parse/inline.ts";
export * from "./adf/parse/selfcheck.ts";
export * from "./adf/render/directives.ts";
export * from "./adf/render/escape.ts";
export * from "./adf/render/frontmatter.ts";
export * from "./adf/render/markdown.ts";
export * from "./adf/render/table.ts";
export * from "./cache/cache.ts";
export * from "./config/config.ts";
export * from "./config/device.ts";
export * from "./config/settings.ts";
export * from "./confluence/browse.ts";
export * from "./confluence/client.ts";
export * from "./confluence/sources.ts";
export * from "./flavor/flavor.ts";
export * from "./git/ignore.ts";
export * from "./git/log.ts";
export * from "./git/repo.ts";
export * from "./git/status.ts";
export * from "./models/adf.ts";
export * from "./models/frontmatter.ts";
export * from "./ports/index.ts";
export * from "./sync/actions.ts";
export * from "./sync/assets.ts";
export * from "./sync/clean.ts";
export * from "./sync/create.ts";
export * from "./sync/discover.ts";
export * from "./sync/fswalk.ts";
export * from "./sync/gc.ts";
export * from "./sync/images.ts";
export * from "./sync/linkindex.ts";
export { hasConflictMarkers } from "./sync/merge.ts";
export * from "./sync/pull.ts";
export * from "./sync/push.ts";
export * from "./sync/remote.ts";
export * from "./sync/runlock.ts";
export * from "./sync/status.ts";
export * from "./util/path.ts";
