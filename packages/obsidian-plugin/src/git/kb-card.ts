// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// What a git knowledge base's settings card says and offers in each state
// (design 06): cloning with progress, a missing folder or failed clone,
// conflicts after a pull, offline with the last known role, and by role —
// own (Pull, Push or Commit & push), own on a protected branch (Propose), and
// read, pinned to a commit (Review & update pin when upstream moved, Move to
// pin when this device is behind the shared pin). Pure; the card draws it.

import { cloneHost, type Update } from "@docket/core";
import type { RoleRecord } from "./kb-role.ts";

/** CloneState is a clone docket runs for the card. */
export type CloneState =
    | { kind: "idle" }
    | { kind: "running"; text: string; percent: number }
    | { kind: "failed"; message: string };

/** CheckState is the last access check: none yet, running, or how it ended. */
export type CheckState =
    | { kind: "checking" }
    | { kind: "ok" }
    | { kind: "offline"; message: string }
    | { kind: "error"; message: string };

/** KbStatus is everything a git knowledge base's card is drawn from. */
export interface KbStatus {
    name: string;
    url: string;
    /** The checked-out branch, else the configured one. */
    branch: string;
    /** Whether the vault folder exists. */
    folder: boolean;
    clone: CloneState;
    check: CheckState;
    /** The role last learned on this device; undefined before any. */
    role: RoleRecord | undefined;
    /** Commits ahead of and behind `origin`'s branch, as last fetched. */
    ahead: number;
    behind: number;
    /** Files with uncommitted changes. */
    edited: number;
    /** Files a pull left with conflicts. */
    conflicts: string[];
    /** The commit HEAD points at. */
    head: string;
    /** The pin from the shared settings; absent when not pinned. */
    pin?: string;
    /** Whether the pin is ahead of HEAD, so this device can move to it. */
    pinAhead: boolean;
    /** What moving from the pin to `origin`'s branch would change. */
    update: Update | null;
    /** Whether an operation runs, which disables every action. */
    busy: boolean;
}

/** ActionId names what a card button does. */
export type ActionId =
    | "cancel"
    | "clone"
    | "pull"
    | "push"
    | "commitPush"
    | "propose"
    | "commitPropose"
    | "reviewPin"
    | "movePin"
    | "resolve"
    | "retry";

/** CardAction is one button: the main one is drawn as the call to action. */
export interface CardAction {
    id: ActionId;
    label: string;
    icon: string;
    main: boolean;
    disabled: boolean;
}

/** Pill is a small label next to the knowledge base's name. */
export interface Pill {
    text: string;
    tone: "green" | "orange" | "accent" | "red" | "muted";
    icon: string;
}

/** KbCardView is what the card draws. */
export interface KbCardView {
    pills: Pill[];
    /** The status line under the name. */
    line: string;
    /** Whether the status line is a warning. */
    warn: boolean;
    /** The clone's percent while it runs, else null. */
    progress: number | null;
    /** The update to list under the card, when upstream moved past a pin. */
    update: Update | null;
    actions: CardAction[];
}

/** BUTTON gives each action its button text and icon. */
const BUTTON: Record<ActionId, [string, string]> = {
    cancel: ["Cancel", "x"],
    clone: ["Clone", "download"],
    pull: ["Pull", "refresh-cw"],
    push: ["Push", "arrow-up"],
    commitPush: ["Commit & push", "arrow-up"],
    propose: ["Propose…", "git-pull-request"],
    commitPropose: ["Commit & propose…", "git-pull-request"],
    reviewPin: ["Review & update pin", "git-compare"],
    movePin: ["Move to pin", "pin"],
    resolve: ["Resolve…", "git-merge"],
    retry: ["Retry", "refresh-cw"],
};

/** kbCardView decides what a git knowledge base's card shows. */
export function kbCardView(s: KbStatus): KbCardView {
    const view: KbCardView = {
        pills: rolePills(s),
        line: "",
        warn: false,
        progress: null,
        update: null,
        actions: [],
    };
    const act = (id: ActionId, main = false): void => {
        const [label, icon] = BUTTON[id];
        view.actions.push({ id, label, icon, main, disabled: s.busy });
    };
    if (s.clone.kind === "running") {
        view.line = s.clone.text;
        view.progress = s.clone.percent;
        act("cancel");
        return view;
    }
    if (!s.folder) {
        if (s.clone.kind === "failed") {
            view.line = `Clone failed: ${s.clone.message}`;
            view.warn = true;
        } else {
            view.line = "Folder missing";
        }
        act("clone", true);
        return view;
    }
    if (s.conflicts.length > 0) {
        const n = s.conflicts.length;
        view.pills.push({
            text: `${n} conflict${n === 1 ? "" : "s"}`,
            tone: "red",
            icon: "git-merge",
        });
        view.line = `${s.conflicts.join(", ")} ${n === 1 ? "was" : "were"} changed here and upstream`;
        act("resolve", true);
        return view;
    }
    if (s.check.kind === "offline") {
        view.pills.push({ text: "offline", tone: "muted", icon: "wifi-off" });
        const host = cloneHost(s.url) || "the server";
        view.line = `Could not reach ${host} · last known role kept`;
        act("retry");
        return view;
    }
    if (s.check.kind === "error") {
        view.line = `Could not check access: ${s.check.message}`;
        view.warn = true;
        act("retry");
        return view;
    }
    if (s.role?.role === "read") {
        readView(s, view, act);
        return view;
    }
    if (s.role?.protected === true) {
        view.line = `Push to ${s.branch} was refused; your changes go through pull requests`;
        act("pull");
        if (s.edited > 0) act("commitPropose", true);
        else if (s.ahead > 0) act("propose", true);
        return view;
    }
    const parts = [s.branch];
    if (s.role === undefined) parts.push("checking access…");
    if (s.ahead > 0) parts.push(`↑${s.ahead} to push`);
    if (s.behind > 0) parts.push(`↓${s.behind} to pull`);
    if (s.edited > 0) {
        parts.push(
            `${s.edited} note${s.edited === 1 ? "" : "s"} edited, not committed`,
        );
    }
    if (parts.length === 1) parts.push("up to date");
    view.line = parts.join(" · ");
    act("pull");
    if (s.role === undefined) return view;
    if (s.edited > 0) act("commitPush", true);
    else if (s.ahead > 0) act("push", true);
    return view;
}

/** readView fills the view of a read knowledge base, pinned to a commit. */
function readView(
    s: KbStatus,
    view: KbCardView,
    act: (id: ActionId, main?: boolean) => void,
): void {
    const pin = s.pin ?? "";
    if (pin !== "" && s.head !== pin) {
        view.line = `This device is at ${short(s.head)}; the pin is ${short(pin)}`;
        view.warn = true;
        if (s.pinAhead) act("movePin", true);
        return;
    }
    const n = s.update?.commits ?? 0;
    if (n > 0) {
        view.line = `${s.branch} has ${n} newer commit${n === 1 ? "" : "s"}`;
        view.update = s.update;
        act("reviewPin", true);
    } else {
        view.line = `Pinned at ${short(pin === "" ? s.head : pin)} · up to date`;
    }
    if (s.ahead > 0) act("propose");
}

/** rolePills are the pills naming the role and, for read, the pin. */
function rolePills(s: KbStatus): Pill[] {
    const r = s.role;
    if (r === undefined) return [];
    if (r.role === "read") {
        const out: Pill[] = [{ text: "read", tone: "orange", icon: "lock" }];
        const pin = s.pin ?? "";
        if (pin !== "") {
            out.push({ text: short(pin), tone: "accent", icon: "pin" });
        }
        return out;
    }
    const out: Pill[] = [{ text: "own", tone: "green", icon: "pencil" }];
    if (r.protected) {
        out.push({
            text: `${s.branch} protected`,
            tone: "muted",
            icon: "shield",
        });
    }
    return out;
}

/** short is a commit's 7-character abbreviation. */
function short(hash: string): string {
    return hash.slice(0, 7);
}
