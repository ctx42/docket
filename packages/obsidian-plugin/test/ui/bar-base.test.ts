// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { BarBaseState, type CommitPick } from "../../src/ui/bar-base.ts";

const A1: CommitPick = { note: "a.md", hash: "h1", path: "a.md", at: 1000 };
const A2: CommitPick = { note: "a.md", hash: "h2", path: "old.md", at: 500 };

describe("BarBaseState", () => {
    it("offers the icon for the note opened from its row, diff off", () => {
        const s = new BarBaseState();

        expect(s.open("a.md")).toBe(true);

        expect(s.opened).toBe("a.md");
        expect(s.confluencePath).toBeNull();
    });

    it("toggles the opened note between git and Confluence", () => {
        const s = new BarBaseState();
        s.open("a.md");

        expect(s.toggle("a.md")).toBe(true);
        expect(s.confluencePath).toBe("a.md");
        expect(s.toggle("a.md")).toBe(true);
        expect(s.confluencePath).toBeNull();
    });

    it("ignores a toggle for any note but the opened one", () => {
        const s = new BarBaseState();
        s.open("a.md");

        expect(s.toggle("b.md")).toBe(false);
        expect(s.confluencePath).toBeNull();
    });

    it("keeps the opened note while it stays active", () => {
        const s = new BarBaseState();
        s.open("a.md");
        s.toggle("a.md");

        expect(s.focus("a.md")).toBe(false);
        expect(s.confluencePath).toBe("a.md");
    });

    it("forgets the opened note once another note is active", () => {
        const s = new BarBaseState();
        s.open("a.md");
        s.toggle("a.md");

        expect(s.focus("b.md")).toBe(true);

        expect(s.opened).toBeNull();
        expect(s.confluencePath).toBeNull();
        // Coming back (Back/Forward) does not bring the icon back.
        expect(s.focus("a.md")).toBe(false);
        expect(s.opened).toBeNull();
    });

    it("forgets the opened note when no note is active", () => {
        const s = new BarBaseState();
        s.open("a.md");

        expect(s.focus(null)).toBe(true);
        expect(s.opened).toBeNull();
    });

    it("re-opening a note from its row turns its diff off", () => {
        const s = new BarBaseState();
        s.open("a.md");
        s.toggle("a.md");

        expect(s.open("a.md")).toBe(true);
        expect(s.confluencePath).toBeNull();
        expect(s.open("a.md")).toBe(false);
    });

    it("drops back to git when the note loses its remote body", () => {
        const s = new BarBaseState();
        s.open("a.md");
        s.toggle("a.md");

        expect(s.reconcile(() => true)).toBe(false);
        expect(s.confluencePath).toBe("a.md");
        expect(s.reconcile(() => false)).toBe(true);

        expect(s.confluencePath).toBeNull();
        expect(s.opened).toBe("a.md");
    });

    it("reconciles nothing while the diff is off", () => {
        const s = new BarBaseState();
        s.open("a.md");

        expect(s.reconcile(() => false)).toBe(false);
    });

    it("compares a note against its picked commit", () => {
        const s = new BarBaseState();

        expect(s.pick(A1)).toBe(true);

        expect(s.base("a.md")).toEqual({ kind: "commit", commit: A1 });
        expect(s.base("b.md")).toEqual({ kind: "head" });
        expect(s.pick(A1)).toBe(false);
    });

    it("moves the pick to another commit, and clears it", () => {
        const s = new BarBaseState();
        s.pick(A1);

        expect(s.pick(A2)).toBe(true);
        expect(s.commit).toBe(A2);
        expect(s.pick(null)).toBe(true);

        expect(s.base("a.md")).toEqual({ kind: "head" });
        expect(s.pick(null)).toBe(false);
    });

    it("keeps the pick while its note stays active", () => {
        const s = new BarBaseState();
        s.pick(A1);

        expect(s.focus("a.md")).toBe(false);
        expect(s.commit).toBe(A1);
    });

    it("forgets the pick once another note is active", () => {
        const s = new BarBaseState();
        s.pick(A1);

        expect(s.focus("b.md")).toBe(true);

        expect(s.commit).toBeNull();
        expect(s.focus("a.md")).toBe(false);
    });

    it("lets a pick take over from Confluence mode, and hands it back", () => {
        const s = new BarBaseState();
        s.open("a.md");
        s.toggle("a.md");

        s.pick(A1);

        expect(s.base("a.md")).toEqual({ kind: "commit", commit: A1 });
        expect(s.confluencePath).toBe("a.md");
        s.pick(null);
        expect(s.base("a.md")).toEqual({ kind: "confluence" });
    });

    it("drops the pick when Confluence mode turns on", () => {
        const s = new BarBaseState();
        s.open("a.md");
        s.pick(A1);

        expect(s.toggle("a.md")).toBe(true);

        expect(s.commit).toBeNull();
        expect(s.base("a.md")).toEqual({ kind: "confluence" });
    });

    it("keeps the pick when Confluence mode turns off", () => {
        const s = new BarBaseState();
        s.open("a.md");
        s.toggle("a.md");
        s.pick(A1);

        expect(s.toggle("a.md")).toBe(true);

        expect(s.commit).toBe(A1);
        expect(s.base("a.md")).toEqual({ kind: "commit", commit: A1 });
    });

    it("keeps a pick when another note is opened from its row", () => {
        const s = new BarBaseState();
        s.pick(A1);

        s.open("a.md");

        expect(s.commit).toBe(A1);
    });
});
