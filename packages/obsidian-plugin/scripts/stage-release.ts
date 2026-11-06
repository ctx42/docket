// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// stage-release.ts — prepare the built plugin for a GitHub release.
//
// Checks dist/ holds the plugin's three shipping files and writes the tag's
// version into dist/manifest.json. The tag decides the version, so the
// manifest in the repository keeps its placeholder. Obsidian and BRAT want the
// released manifest to match the tag.
//
//   bun packages/obsidian-plugin/scripts/stage-release.ts <tag> <dist-dir>

import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** SHIPPING_FILES are the files a release attaches, named as BRAT expects. */
export const SHIPPING_FILES = ["main.js", "manifest.json", "styles.css"];

/** SEMVER matches a release version, a pre-release suffix included. */
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** releaseVersion returns the version of `tag`, without a leading `v`. */
export function releaseVersion(tag: string): string {
    const version = tag.replace(/^v/, "");
    if (!SEMVER.test(version)) {
        throw new Error(`tag "${tag}" is not a semantic version`);
    }
    return version;
}

/** stampManifest returns the manifest `text` with its version set. */
export function stampManifest(text: string, version: string): string {
    const manifest = JSON.parse(text) as Record<string, unknown>;
    if (typeof manifest["id"] !== "string") {
        throw new Error("manifest has no id");
    }
    return `${JSON.stringify({ ...manifest, version }, null, 2)}\n`;
}

/** stageRelease checks the build in `dist` and stamps its manifest for `tag`. */
export async function stageRelease(tag: string, dist: string): Promise<void> {
    const version = releaseVersion(tag);
    for (const name of SHIPPING_FILES) {
        await access(join(dist, name)).catch(() => {
            throw new Error(`build is missing ${name}`);
        });
    }
    const path = join(dist, "manifest.json");
    await writeFile(path, stampManifest(await readFile(path, "utf8"), version));
}

if (import.meta.main) {
    const [tag, dist] = process.argv.slice(2);
    if (tag === undefined || dist === undefined) {
        console.error("usage: stage-release.ts <tag> <dist-dir>");
        process.exit(2);
    }
    await stageRelease(tag, dist);
}
