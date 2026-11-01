// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { ICON_ID, ICON_SVG } from "../src/icon.ts";

describe("ICON_SVG", () => {
    it("draws the brackets mark: two brackets around two lines", () => {
        const paths = [...ICON_SVG.matchAll(/<path d="([^"]+)"\/>/g)].map(
            (m) => m[1],
        );

        expect(paths).toEqual([
            "M8 3H5v18h3",
            "M16 3h3v18h-3",
            "M9 9.5h6",
            "M9 14.5h6",
        ]);
    });

    it("scales the 24-unit grid into the 100-unit box and follows the theme", () => {
        expect(ICON_SVG).toContain('transform="scale(4.1667)"');
        expect(ICON_SVG).toContain('stroke="currentColor"');
        expect(ICON_SVG).toContain("stroke-width: var(--icon-stroke, 2)");
    });
});

describe("ICON_ID", () => {
    it("is the id the plugin registers its icon under", () => {
        expect(ICON_ID).toBe("docket");
    });
});
