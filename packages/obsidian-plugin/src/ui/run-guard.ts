// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Whether a run that writes synced pages — pull, push, discard, or a status
// apply — may start. Obsidian-free, so it unit-tests; the run controller shows
// the refusal as a notice. The command-line tool refuses with the same text.

import { NO_SYNC_FOLDER, syncFolder } from "@docket/core";
import type { docketSettings } from "../settings/model.ts";

/** runRefusal returns the notice refusing a run, or `""` when it may start. */
export function runRefusal(settings: docketSettings): string {
    return syncFolder(settings.syncRoot) === ""
        ? `docket: ${NO_SYNC_FOLDER}`
        : "";
}
