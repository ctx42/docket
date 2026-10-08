// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// JSON golden loader for goldens frozen from the Go oracle
// (`tmp/mcp-port/oracle`). Goldens are Biome-formatted, so tests compare
// parsed values, never raw bytes. Test-only support code, so it may use
// `node:` freely.

import { readFileSync } from "node:fs";

/** readGolden parses the JSON golden at url (e.g. `new URL(..., import.meta.url)`). */
export function readGolden<T>(url: URL): T {
    return JSON.parse(readFileSync(url, "utf8")) as T;
}
