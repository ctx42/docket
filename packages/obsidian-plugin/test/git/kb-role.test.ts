// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
    afterProbe,
    afterPush,
    type RoleRecord,
    readRoles,
} from "../../src/git/kb-role.ts";

const own: RoleRecord = { role: "own", protected: false, checkedAt: 1 };

describe("afterProbe", () => {
    it("records write access as own and read access as read", () => {
        const w = afterProbe(undefined, { kind: "write", message: "" }, 5);
        const r = afterProbe(own, { kind: "read", message: "denied" }, 5);

        expect(w).toEqual({ role: "own", protected: false, checkedAt: 5 });
        expect(r).toEqual({ role: "read", protected: false, checkedAt: 5 });
    });

    it("keeps a protected branch it learned while access stays write", () => {
        const prev: RoleRecord = { ...own, protected: true };

        const have = afterProbe(prev, { kind: "write", message: "" }, 9);

        expect(have).toEqual({ role: "own", protected: true, checkedAt: 9 });
    });

    it("keeps the last known record when the check could not tell", () => {
        expect(afterProbe(own, { kind: "offline", message: "x" }, 9)).toBe(own);
        expect(afterProbe(own, { kind: "unknown", message: "x" }, 9)).toBe(own);
        expect(
            afterProbe(undefined, { kind: "offline", message: "x" }, 9),
        ).toBeUndefined();
    });
});

describe("afterPush", () => {
    it("learns a protected branch from a refused push", () => {
        expect(afterPush(own, "protected", 7)).toEqual({
            role: "own",
            protected: true,
            checkedAt: 7,
        });
    });

    it("learns read access from a denied push", () => {
        expect(afterPush(own, "denied", 7)).toEqual({
            role: "read",
            protected: false,
            checkedAt: 7,
        });
    });

    it("forgets the protection after a push went through", () => {
        const prev: RoleRecord = { ...own, protected: true };

        expect(afterPush(prev, "ok", 7)).toEqual({
            role: "own",
            protected: false,
            checkedAt: 7,
        });
    });

    it("changes nothing for a push that failed another way", () => {
        expect(afterPush(own, "behind", 7)).toBe(own);
        expect(afterPush(own, "network", 7)).toBe(own);
        expect(afterPush(undefined, "other", 7)).toBeUndefined();
    });
});

describe("readRoles", () => {
    it("keeps well-formed records and drops the rest", () => {
        const have = readRoles({
            kb: { role: "own", protected: true, checkedAt: 3 },
            bad: { role: "boss", protected: false, checkedAt: 3 },
            worse: "x",
        });

        expect(have).toEqual({
            kb: { role: "own", protected: true, checkedAt: 3 },
        });
        expect(readRoles(null)).toEqual({});
        expect(readRoles([1])).toEqual({});
    });
});
