// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Temp-name clashes need a predictable random source, so this file mocks
// node:crypto's randomInt.

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const draws: number[] = [];

vi.mock("node:crypto", async (orig) => ({
    ...(await orig<typeof import("node:crypto")>()),
    randomInt: () => draws.shift() ?? 7,
}));

const { NodeDocFs } = await import("../src/fs.ts");

let dir: string;

beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), "docfs-temp-"));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("NodeDocFs temp names", () => {
    it("retries a clashing name like os.CreateTemp", async () => {
        fs.writeFileSync(join(dir, ".gaps-check-7"), "");
        draws.push(7, 8);

        await new NodeDocFs().probeWritable(dir, ".gaps-check-");

        expect(fs.readdirSync(dir)).toEqual([".gaps-check-7"]);
    });

    it("gives up after repeated clashes", async () => {
        fs.writeFileSync(join(dir, ".gaps-check-7"), "");

        const have = new NodeDocFs().probeWritable(dir, ".gaps-check-");

        await expect(have).rejects.toThrow(
            `open ${dir}/.gaps-check-7: file exists`,
        );
    });
});
