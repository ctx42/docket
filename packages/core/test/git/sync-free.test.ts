// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Pull and push never commit: their file changes are left for the user to
// commit from the Git tab. This holds as long as no sync module reaches the git
// module or the git port, which this test enforces.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SYNC_DIR = fileURLToPath(new URL("../../src/sync", import.meta.url));

describe("sync layer", () => {
    it("imports nothing from git", () => {
        const have = readdirSync(SYNC_DIR)
            .filter((f) => f.endsWith(".ts"))
            .filter((f) =>
                /from "\.\.\/(git\/|ports\/git\.ts)/.test(
                    readFileSync(join(SYNC_DIR, f), "utf8"),
                ),
            );

        expect(have).toEqual([]);
    });
});
