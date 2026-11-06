// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    releaseVersion,
    stageRelease,
    stampManifest,
} from "../scripts/stage-release.ts";

describe("releaseVersion", () => {
    it("reads the version of a tag", () => {
        expect(releaseVersion("1.2.3")).toBe("1.2.3");
        expect(releaseVersion("v1.2.3")).toBe("1.2.3");
        expect(releaseVersion("1.2.3-beta.1")).toBe("1.2.3-beta.1");
    });

    it("refuses a tag that is not a semantic version", () => {
        expect(() => releaseVersion("latest")).toThrow(
            'tag "latest" is not a semantic version',
        );
        expect(() => releaseVersion("1.2")).toThrow("not a semantic version");
    });
});

describe("stampManifest", () => {
    it("sets the version and keeps the other keys", () => {
        // --- Given ---
        const text = '{"id":"x","version":"0.0.0","name":"n"}';

        // --- When ---
        const have = stampManifest(text, "1.2.3");

        // --- Then ---
        expect(JSON.parse(have)).toEqual({
            id: "x",
            version: "1.2.3",
            name: "n",
        });
        expect(have.endsWith("}\n")).toBe(true);
    });

    it("refuses a manifest without an id", () => {
        expect(() => stampManifest('{"version":"0.0.0"}', "1.2.3")).toThrow(
            "manifest has no id",
        );
    });
});

describe("stageRelease", () => {
    let dist: string;

    beforeEach(async () => {
        dist = await mkdtemp(join(tmpdir(), "docket-release-"));
    });

    afterEach(async () => {
        await rm(dist, { recursive: true, force: true });
    });

    /** seed writes the named files, a valid manifest among them. */
    async function seed(...names: string[]): Promise<void> {
        for (const name of names) {
            await writeFile(join(dist, name), '{"id":"x","version":"0.0.0"}');
        }
    }

    it("stamps the built manifest with the tag's version", async () => {
        // --- Given ---
        await seed("main.js", "manifest.json", "styles.css");

        // --- When ---
        await stageRelease("v1.2.3", dist);

        // --- Then ---
        const have = await readFile(join(dist, "manifest.json"), "utf8");
        expect(JSON.parse(have).version).toBe("1.2.3");
    });

    it("refuses a build missing a shipping file", async () => {
        // --- Given ---
        await seed("main.js", "manifest.json");

        // --- When ---
        const have = stageRelease("1.2.3", dist);

        // --- Then ---
        await expect(have).rejects.toThrow("styles.css");
    });
});
