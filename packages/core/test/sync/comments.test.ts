// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import type { PageComment } from "../../src/confluence/client.ts";
import {
    planResolves,
    type RecordedThread,
    toRenderComments,
} from "../../src/sync/comments.ts";

const thread: RecordedThread = {
    id: "C1",
    markerRef: "M1",
    anchorText: "x",
    version: 1,
    replies: [],
};

const callout = "> [!comment] id:C1 · @u · 2026-01-01T00:00:00Z · open\n> Hi";
const anchored = `Text.[^cf-M1]\n\n${callout}`;
const unanchored = `Text.\n\n${callout}`;

describe("planResolves", () => {
    it("refuses a removed anchor the base render drew", () => {
        expect(() => planResolves([thread], unanchored, anchored)).toThrow(
            "id:C1 (anchor removed)",
        );
    });

    it("keeps a comment whose anchor the base render never drew", () => {
        const have = planResolves([thread], unanchored, unanchored);

        expect(have).toEqual([]);
    });

    it("resolves an anchorless comment once its callout is gone", () => {
        const have = planResolves([thread], "Text.", unanchored);

        expect(have).toEqual([thread]);
    });

    it("expects every anchor when the base render is unknown", () => {
        expect(() => planResolves([thread], unanchored, null)).toThrow(
            "anchor removed",
        );
    });
});

describe("toRenderComments", () => {
    /** A live comment by `authorName`, with `replies`. */
    const live = (
        id: string,
        authorName: string,
        replies: PageComment[] = [],
    ): PageComment => ({
        id,
        kind: "footer",
        resolution: "",
        markerRef: "",
        anchorText: "",
        authorId: `acc-${id}`,
        authorName,
        createdAt: "",
        version: 1,
        adf: "",
        replies,
    });

    it("carries each author's id and name, replies included", () => {
        const have = toRenderComments({
            inline: [],
            footer: [live("F1", "Ann", [live("F2", "Bob")])],
        });

        const f1 = have.trailing[0];
        expect(f1?.authorId).toBe("acc-F1");
        expect(f1?.authorName).toBe("Ann");
        expect(f1?.replies[0]?.authorId).toBe("acc-F2");
        expect(f1?.replies[0]?.authorName).toBe("Bob");
    });
});
