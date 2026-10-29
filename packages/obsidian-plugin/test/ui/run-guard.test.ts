// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { NO_SYNC_FOLDER } from "@docket/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/settings/model.ts";
import { runRefusal } from "../../src/ui/run-guard.ts";

describe("runRefusal", () => {
    it("refuses pull and push without a sync folder, as the CLI does", () => {
        const s = { ...DEFAULT_SETTINGS, syncRoot: "" };

        expect(runRefusal(s)).toBe(`docket: ${NO_SYNC_FOLDER}`);
        expect(runRefusal({ ...s, syncRoot: "." })).toBe(
            `docket: ${NO_SYNC_FOLDER}`,
        );
    });

    it("lets a run start with a sync folder", () => {
        expect(
            runRefusal({ ...DEFAULT_SETTINGS, syncRoot: "confluence" }),
        ).toBe("");
    });
});
