// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

/**
 * `@docket/docserver` is the runtime-neutral documentation server ported from
 * an earlier Go server: corpus loading and chunking, a BM25 search that
 * reproduces bleve's English analyzer and scoring, the glossary, the gap
 * store, and the MCP and REST surfaces over them. Like `@docket/core` it imports nothing from
 * `node:`, `bun:`, `obsidian`, `electron`, or `@codemirror/*`; all I/O goes
 * through its ports, and `test/boundary.test.ts` fails CI on any leak. Hosting
 * on real files, sockets, and stdio lives in `@docket/docserver-node`.
 */
export const PACKAGE_NAME = "@docket/docserver";

export * from "./config/config.ts";
export * from "./config/project.ts";
export * from "./corpus/chunker.ts";
export * from "./corpus/corpus.ts";
export * from "./corpus/frontmatter.ts";
export * from "./corpus/helpers.ts";
export * from "./engine/engine.ts";
export * from "./gaps/file-store.ts";
export * from "./gaps/format.ts";
export * from "./gaps/gaps.ts";
export * from "./gaps/helpers.ts";
export * from "./gaps/index.ts";
export * from "./gaps/render.ts";
export * from "./glossary/glossary.ts";
export * from "./gocompat/duration.ts";
export * from "./gocompat/json.ts";
export * from "./gocompat/jsonscan.ts";
export * from "./gocompat/math.ts";
export * from "./gocompat/sha256.ts";
export * from "./gocompat/strconv.ts";
export * from "./gocompat/strings.ts";
export * from "./gocompat/time.ts";
export * from "./gocompat/url.ts";
export * from "./gocompat/utf8.ts";
export * from "./mcp/schema.ts";
export * from "./mcp/tool-defs.ts";
export * from "./mcp/tools.ts";
export * from "./ports.ts";
export * from "./resolver/resolver.ts";
export * from "./rest/decode.ts";
export * from "./rest/openapi.ts";
export * from "./rest/rest.ts";
export * from "./search/analyzer.ts";
export * from "./search/bm25.ts";
export * from "./search/porter.ts";
export * from "./search/retrieval.ts";
export * from "./search/segment.ts";
export * from "./search/segment-tables.ts";
export * from "./search/stop-words.ts";
export * from "./util/cancel.ts";
export * from "./util/mutex.ts";
export * from "./util/timers.ts";
export * from "./watch/loop.ts";
export * from "./yamlv3/decode.ts";
export * from "./yamlv3/encode.ts";
export * from "./yamlv3/node.ts";
