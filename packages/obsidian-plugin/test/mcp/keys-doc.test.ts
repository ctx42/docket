// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    KEYS_HEADING,
    KEYS_SECTION,
    withKeysSection,
} from "../../src/mcp/keys-doc.ts";

describe("withKeysSection", () => {
    const FRONT = "---\nmcp-server: docs\n---\n";

    it("appends the section after the body", () => {
        const have = withKeysSection(`${FRONT}\n# Project\n\nNotes.\n`);

        expect(have).toBe(`${FRONT}\n# Project\n\nNotes.\n\n${KEYS_SECTION}`);
    });

    it("leaves a current section alone", () => {
        const text = `${FRONT}\n# Project\n\n${KEYS_SECTION}\n## SRD skill keys\n\nTheirs.\n`;

        expect(withKeysSection(text)).toBe(text);
    });

    it("replaces an outdated section in place and keeps the rest", () => {
        const text = `${FRONT}\n# Project\n\n${KEYS_HEADING}\n\nOld text.\n\n## SRD skill keys\n\nTheirs.\n`;

        const have = withKeysSection(text);

        expect(have).toBe(
            `${FRONT}\n# Project\n\n${KEYS_SECTION}\n## SRD skill keys\n\nTheirs.\n`,
        );
    });

    it("documents only the keys the plugin owns, with no vault names", () => {
        for (const key of [
            "mcp-server",
            "mcp-port",
            "sources",
            "watch",
            "initiatives",
            "glossary",
            "gaps",
            "precedence",
        ]) {
            expect(KEYS_SECTION).toContain(`\`${key}\``);
        }
        expect(KEYS_SECTION).not.toMatch(/`(kb|srd-standard|srd-work)`/);
        expect(KEYS_SECTION).not.toMatch(/infraport|conflu/i);
    });
});
