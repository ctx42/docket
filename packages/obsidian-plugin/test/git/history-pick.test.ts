// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import type { LogEntry } from "@docket/core";
import { describe, expect, it } from "vitest";
import {
    BARS_OFF,
    isPicked,
    NOT_MARKDOWN,
    nextPick,
    pickBlock,
} from "../../src/git/history-pick.ts";
import type { CommitPick } from "../../src/ui/bar-base.ts";

const OLD: LogEntry = { hash: "h1", at: 1000, subject: "s", path: "old.md" };
const MERGE: LogEntry = { hash: "h2", at: 2000, subject: "m" };

describe("pickBlock", () => {
    it("lets a Markdown note's rows be picked while the bars are on", () => {
        expect(pickBlock(true, "a/b.md")).toBeNull();
        expect(pickBlock(true, "A.MD")).toBeNull();
    });

    it("blocks the rows while the bars are off", () => {
        expect(pickBlock(false, "a.md")).toBe(BARS_OFF);
    });

    it("blocks the rows of a file that is not Markdown", () => {
        expect(pickBlock(true, "x.canvas")).toBe(NOT_MARKDOWN);
        expect(pickBlock(true, "doc.pdf")).toBe(NOT_MARKDOWN);
    });
});

describe("nextPick", () => {
    it("picks a row with the path the note had at its commit", () => {
        const have = nextPick(null, "new.md", "new.md", OLD);

        expect(have).toEqual({
            note: "new.md",
            hash: "h1",
            path: "old.md",
            at: 1000,
        });
    });

    it("gives a row without a path the queried one", () => {
        const have = nextPick(null, "new.md", "moved-from.md", MERGE);

        expect(have?.path).toBe("moved-from.md");
    });

    it("clears the pick when its row is clicked again", () => {
        const cur = nextPick(null, "a.md", "a.md", OLD);

        expect(nextPick(cur, "a.md", "a.md", OLD)).toBeNull();
    });

    it("moves the pick to another row", () => {
        const cur = nextPick(null, "a.md", "a.md", OLD);

        expect(nextPick(cur, "a.md", "a.md", MERGE)?.hash).toBe("h2");
    });
});

describe("isPicked", () => {
    it("marks only the picked row of the picked note", () => {
        const cur: CommitPick = {
            note: "a.md",
            hash: "h1",
            path: "a.md",
            at: 0,
        };

        expect(isPicked(cur, "a.md", OLD)).toBe(true);
        expect(isPicked(cur, "a.md", MERGE)).toBe(false);
        expect(isPicked(cur, "b.md", OLD)).toBe(false);
        expect(isPicked(null, "a.md", OLD)).toBe(false);
    });
});
