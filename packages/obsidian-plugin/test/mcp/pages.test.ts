// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import type { PreflightEntry } from "@docket/core";
import { describe, expect, it } from "vitest";
import { pageStates } from "../../src/mcp/pages.ts";

/** entry is a preflight result for dest. */
function entry(
    dest: string,
    cls: PreflightEntry["cls"],
    reason = "",
): PreflightEntry {
    return {
        dest,
        name: dest,
        pageId: "1",
        localBase: 77,
        remoteVersion: 78,
        cls,
        reason,
        resolves: [],
        replies: [],
    };
}

describe("pageStates", () => {
    it("classifies vault notes with one preflight, in order", async () => {
        // --- Given ---
        let asked: string[] = [];
        const preflight = async (dests: string[]) => {
            asked = dests;
            return [
                entry("conflu/a.md", "remote-moved"),
                entry("conflu/b.md", "skip", "unreadable note"),
            ];
        };

        // --- When ---
        const have = await pageStates(
            ["/v/conflu/a.md", "/elsewhere/x.md", "/v/conflu/b.md"],
            { base: "/v", preflight },
        );

        // --- Then ---
        expect(asked).toEqual(["conflu/a.md", "conflu/b.md"]);
        expect(have).toEqual([
            {
                file: "/v/conflu/a.md",
                state: "remote-moved",
                localVersion: 77,
                remoteVersion: 78,
                reason: "",
            },
            {
                file: "/elsewhere/x.md",
                state: "skip",
                localVersion: 0,
                remoteVersion: 0,
                reason: "not in the vault",
            },
            {
                file: "/v/conflu/b.md",
                state: "skip",
                localVersion: 77,
                remoteVersion: 78,
                reason: "unreadable note",
            },
        ]);
    });

    it("asks nothing when no file is in the vault", async () => {
        // --- Given ---
        let calls = 0;
        const preflight = async () => {
            calls++;
            return [];
        };

        // --- When ---
        const have = await pageStates(["/x.md"], { base: "/v", preflight });

        // --- Then ---
        expect(calls).toBe(0);
        expect(have.map((p) => p.state)).toEqual(["skip"]);
    });

    it("treats a base with a trailing slash as the same vault", async () => {
        // --- Given ---
        const preflight = async (dests: string[]) =>
            dests.map((d) => entry(d, "unchanged"));

        // --- When ---
        const have = await pageStates(["/v/a.md"], { base: "/v/", preflight });

        // --- Then ---
        expect(have[0]?.state).toBe("unchanged");
    });
});
