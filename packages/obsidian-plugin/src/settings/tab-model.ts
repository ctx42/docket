// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The settings tab's decisions that are not DOM: reading a whole-number field,
// the validation banner's message and the location row it marks, and the
// connection test's result line. It is obsidian-free, so it unit-tests; the
// section modules draw it.

import { errorDest } from "./locations.ts";
import { buildPluginConfig, type docketSettings } from "./model.ts";

/** errorMessage returns an unknown thrown value's message text. */
export function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** wholeNumber reads a non-negative whole number, or null for anything else. */
export function wholeNumber(v: string): number | null {
    return /^\d+$/.test(v.trim()) ? Number(v) : null;
}

/** Validation is the settings' first error, if any, and the row it names. */
export interface Validation {
    /** The error without its `config: ` prefix; `""` when the settings are valid. */
    message: string;
    /** The location dest the error names; `""` when it names none. */
    dest: string;
}

/**
 * validation builds the plugin config from the settings and token and returns
 * the first error it raises, if any, with the location row it names.
 */
export function validation(s: docketSettings, token: string): Validation {
    try {
        buildPluginConfig(s, token);
    } catch (err) {
        const message = errorMessage(err).replace(/^config: /, "");
        return { message, dest: errorDest(message) };
    }
    return { message: "", dest: "" };
}

/** connectedAs is the connection test's success line for the signed-in user. */
export function connectedAs(user: {
    displayName: string;
    accountId: string;
}): string {
    return `Connected as ${user.displayName || user.accountId}`;
}
