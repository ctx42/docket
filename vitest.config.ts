// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { defineConfig } from "vitest/config";

/** gate is the coverage floor each measured package must hold on its own. */
const gate = { statements: 95, lines: 95, functions: 95, branches: 90 };

export default defineConfig({
    test: {
        include: ["packages/*/{src,test}/**/*.test.ts"],
        // Live integration tests hit a real Atlassian Site; they run only via
        // the cli package's `test:live` script, never in the default suite.
        exclude: ["**/node_modules/**", "**/*.live.test.ts"],
        // Every package must ship at least one test; a package with none is a
        // mistake, not a pass.
        passWithNoTests: false,
        // Coverage gate (`test:coverage`, run by `check`) for the engine and the
        // docserver packages, each held to it separately so one package's
        // surplus cannot mask another's drop; the CLI and plugin adapters stay
        // unmeasured.
        coverage: {
            provider: "v8",
            include: [
                "packages/core/src/**/*.ts",
                "packages/docserver*/src/**/*.ts",
            ],
            reporter: ["text-summary"],
            thresholds: {
                ...gate,
                "packages/core/src/**/*.ts": gate,
                "packages/docserver*/src/**/*.ts": gate,
            },
        },
    },
});
