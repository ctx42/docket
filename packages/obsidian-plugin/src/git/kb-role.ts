// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// What this person may do in each git knowledge base, as last learned on this
// device: `own` (may push) or `read`, and whether the branch is protected,
// which only a refused push shows. A check that could not reach the server
// keeps the last record, so an offline card still names the role. Pure;
// settings/store.ts keeps the records in this device's local storage.

import type { Access, PushProblem } from "@docket/core";

/** KbRole is what this person may do in a knowledge base. */
export type KbRole = "own" | "read";

/** RoleRecord is a knowledge base's role as last learned on this device. */
export interface RoleRecord {
    role: KbRole;
    /** Whether a push to the branch was refused by a branch rule. */
    protected: boolean;
    /** When the role was learned, in epoch milliseconds. */
    checkedAt: number;
}

/**
 * afterProbe is the record after an access check at `now`: write access is
 * `own` (keeping a protection learned before), read access is `read`, and a
 * check that could not tell keeps `prev`.
 */
export function afterProbe(
    prev: RoleRecord | undefined,
    access: Access,
    now: number,
): RoleRecord | undefined {
    switch (access.kind) {
        case "write":
            return {
                role: "own",
                protected: prev?.role === "own" && prev.protected,
                checkedAt: now,
            };
        case "read":
            return { role: "read", protected: false, checkedAt: now };
        default:
            return prev;
    }
}

/**
 * afterPush is the record after a push to the branch at `now`: `ok` when it
 * went through, else its {@link PushProblem}. A branch rule marks the branch
 * protected, a denial makes the role `read`, and a push that went through
 * clears the protection; other failures keep `prev`.
 */
export function afterPush(
    prev: RoleRecord | undefined,
    outcome: PushProblem | "ok",
    now: number,
): RoleRecord | undefined {
    switch (outcome) {
        case "ok":
            return { role: "own", protected: false, checkedAt: now };
        case "protected":
            return { role: "own", protected: true, checkedAt: now };
        case "denied":
            return { role: "read", protected: false, checkedAt: now };
        default:
            return prev;
    }
}

/** readRoles cleans the records read back from local storage. */
export function readRoles(v: unknown): Record<string, RoleRecord> {
    const out: Record<string, RoleRecord> = {};
    if (typeof v !== "object" || v === null || Array.isArray(v)) return out;
    for (const [name, r] of Object.entries(v as Record<string, unknown>)) {
        if (typeof r !== "object" || r === null) continue;
        const {
            role,
            protected: prot,
            checkedAt,
        } = r as Record<string, unknown>;
        if (role !== "own" && role !== "read") continue;
        if (typeof prot !== "boolean" || typeof checkedAt !== "number") {
            continue;
        }
        out[name] = { role, protected: prot, checkedAt };
    }
    return out;
}
