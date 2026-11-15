// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { type KbStatus, kbCardView } from "../../src/git/kb-card.ts";

const PIN = "3f9c2a1".padEnd(40, "0");
const HEAD = "aaaaaaa".padEnd(40, "0");

/** status builds a checked, clean, own knowledge base, then applies `over`. */
function status(over: Partial<KbStatus> = {}): KbStatus {
    return {
        name: "kb",
        url: "git@bitbucket.org:me/kb.git",
        branch: "main",
        folder: true,
        clone: { kind: "idle" },
        check: { kind: "ok" },
        role: { role: "own", protected: false, checkedAt: 0 },
        ahead: 0,
        behind: 0,
        edited: 0,
        conflicts: [],
        head: HEAD,
        pinAhead: false,
        update: null,
        busy: false,
        ...over,
    };
}

/** ids lists a view's action ids, the main one marked with `*`. */
function ids(s: KbStatus): string[] {
    return kbCardView(s).actions.map((a) => (a.main ? `*${a.id}` : a.id));
}

/** pills lists a view's pill texts. */
function pills(s: KbStatus): string[] {
    return kbCardView(s).pills.map((p) => p.text);
}

describe("kbCardView while cloning or without a folder", () => {
    it("shows clone progress with Cancel", () => {
        const s = status({
            folder: false,
            clone: {
                kind: "running",
                text: "Receiving objects 62%",
                percent: 62,
            },
        });

        expect(kbCardView(s).line).toBe("Receiving objects 62%");
        expect(kbCardView(s).progress).toBe(62);
        expect(ids(s)).toEqual(["cancel"]);
    });

    it("offers Clone for a missing folder, and says why a clone failed", () => {
        const missing = status({ folder: false });
        const failed = status({
            folder: false,
            clone: { kind: "failed", message: "the server refused the key" },
        });

        expect(kbCardView(missing).line).toBe("Folder missing");
        expect(ids(missing)).toEqual(["*clone"]);
        expect(kbCardView(failed).line).toBe(
            "Clone failed: the server refused the key",
        );
        expect(kbCardView(failed).warn).toBe(true);
        expect(ids(failed)).toEqual(["*clone"]);
    });
});

describe("kbCardView for an own knowledge base", () => {
    it("counts what to push and pull and offers Commit & push for edits", () => {
        const s = status({ ahead: 3, behind: 2, edited: 1 });

        expect(pills(s)).toEqual(["own"]);
        expect(kbCardView(s).line).toBe(
            "main · ↑3 to push · ↓2 to pull · 1 note edited, not committed",
        );
        expect(ids(s)).toEqual(["pull", "*commitPush"]);
    });

    it("offers Push for commits only, and nothing more when clean", () => {
        expect(ids(status({ ahead: 2 }))).toEqual(["pull", "*push"]);
        expect(ids(status())).toEqual(["pull"]);
        expect(kbCardView(status()).line).toBe("main · up to date");
    });

    it("turns Push into Propose on a protected branch", () => {
        const s = status({
            role: { role: "own", protected: true, checkedAt: 0 },
            ahead: 1,
        });

        expect(pills(s)).toEqual(["own", "main protected"]);
        expect(kbCardView(s).line).toBe(
            "Push to main was refused; your changes go through pull requests",
        );
        expect(ids(s)).toEqual(["pull", "*propose"]);
        expect(
            ids(
                status({
                    role: { role: "own", protected: true, checkedAt: 0 },
                    edited: 2,
                }),
            ),
        ).toEqual(["pull", "*commitPropose"]);
    });
});

describe("kbCardView for a read knowledge base", () => {
    const read = { role: "read" as const, protected: false, checkedAt: 0 };

    it("names the pin and offers a review when upstream moved", () => {
        const s = status({
            role: read,
            head: PIN,
            pin: PIN,
            update: {
                commits: 4,
                changed: ["a.md", "b.md", "c.md"],
                added: ["d.md"],
                removed: [],
            },
        });

        expect(pills(s)).toEqual(["read", "3f9c2a1"]);
        expect(kbCardView(s).line).toBe("main has 4 newer commits");
        expect(kbCardView(s).update?.added).toEqual(["d.md"]);
        expect(ids(s)).toEqual(["*reviewPin"]);
    });

    it("says it is up to date, and offers Propose for local commits", () => {
        const s = status({ role: read, head: PIN, pin: PIN, ahead: 1 });

        expect(kbCardView(s).line).toBe("Pinned at 3f9c2a1 · up to date");
        expect(ids(s)).toEqual(["propose"]);
    });

    it("offers to move a device that is behind the shared pin", () => {
        const s = status({ role: read, head: HEAD, pin: PIN, pinAhead: true });

        expect(kbCardView(s).line).toBe(
            "This device is at aaaaaaa; the pin is 3f9c2a1",
        );
        expect(kbCardView(s).warn).toBe(true);
        expect(ids(s)).toEqual(["*movePin"]);
    });

    it("only warns when the device is past the pin", () => {
        const s = status({ role: read, head: HEAD, pin: PIN, pinAhead: false });

        expect(kbCardView(s).warn).toBe(true);
        expect(ids(s)).toEqual([]);
    });
});

describe("kbCardView for problems", () => {
    it("names conflicting files and offers Resolve", () => {
        const s = status({
            conflicts: ["data-points.md", "device-registry.md"],
        });

        expect(pills(s)).toEqual(["own", "2 conflicts"]);
        expect(kbCardView(s).line).toBe(
            "data-points.md, device-registry.md were changed here and upstream",
        );
        expect(ids(s)).toEqual(["*resolve"]);
    });

    it("keeps the last role when offline and offers Retry", () => {
        const s = status({
            role: { role: "read", protected: false, checkedAt: 0 },
            check: { kind: "offline", message: "no route" },
        });

        expect(pills(s)).toEqual(["read", "offline"]);
        expect(kbCardView(s).line).toBe(
            "Could not reach bitbucket.org · last known role kept",
        );
        expect(ids(s)).toEqual(["retry"]);
    });

    it("says when access could not be checked", () => {
        const s = status({
            role: undefined,
            check: { kind: "error", message: "Permission denied (publickey)." },
        });

        expect(pills(s)).toEqual([]);
        expect(kbCardView(s).line).toBe(
            "Could not check access: Permission denied (publickey).",
        );
        expect(ids(s)).toEqual(["retry"]);
    });

    it("says it is checking before the first check ends", () => {
        const s = status({ role: undefined, check: { kind: "checking" } });

        expect(kbCardView(s).line).toBe("main · checking access…");
        expect(ids(s)).toEqual(["pull"]);
    });

    it("disables every action while an operation runs", () => {
        const s = status({ ahead: 1, busy: true });

        expect(kbCardView(s).actions.every((a) => a.disabled)).toBe(true);
    });
});
