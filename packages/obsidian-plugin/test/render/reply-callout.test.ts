// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { calloutCommentId } from "../../src/render/reply-callout.ts";

describe("calloutCommentId", () => {
    it.each([
        [
            "a full title",
            "id:2379284494 · @Jane Doe · 2026-11-12 · open",
            "2379284494",
        ],
        ["a title with leading space", "  id:C1", "C1"],
        ["a title with no author", "id:F1 · 2026-11-12", "F1"],
    ])("reads the id from %s", (_name, title, want) => {
        const have = calloutCommentId(title);

        expect(have).toBe(want);
    });

    it.each([
        ["an empty title", ""],
        ["a title of another callout", "Note"],
        ["an id later in the title", "see id:C1"],
    ])("reads nothing from %s", (_name, title) => {
        const have = calloutCommentId(title);

        expect(have).toBeNull();
    });
});
