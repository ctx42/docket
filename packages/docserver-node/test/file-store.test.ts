// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The FileStore primitives on the real filesystem: what the in-memory
// DocFs of the docserver tests stands in for.

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileStore } from "@docket/docserver";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NodeDocFs } from "../src/fs.ts";

const EPOCH = { unix: 0, nsec: 0, offset: 0 };
const NAME = "gap-0007-epub-token-lifetime.md";

let dir: string;
let fst: FileStore;

beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), "gap-store-"));
    fst = new FileStore(new NodeDocFs(), dir, () => EPOCH, undefined);
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("FileStore on NodeDocFs", () => {
    it("writes keeping the mode and no temp file", async () => {
        // --- Given ---
        fs.writeFileSync(join(dir, NAME), "old");
        fs.chmodSync(join(dir, NAME), 0o600);

        // --- When ---
        await fst.write(NAME, "new");

        // --- Then ---
        expect(fs.readdirSync(dir)).toEqual([NAME]);
        expect(fs.readFileSync(join(dir, NAME), "utf8")).toBe("new");
        expect(fs.statSync(join(dir, NAME)).mode & 0o777).toBe(0o600);
    });

    it("moves into a new closed folder and refuses to overwrite", async () => {
        // --- Given ---
        fs.writeFileSync(join(dir, NAME), "x");

        // --- When ---
        await fst.move(NAME, `closed/${NAME}`);

        // --- Then ---
        expect(fs.readdirSync(dir)).toEqual(["closed"]);
        expect(fs.statSync(join(dir, "closed")).mode & 0o777).toBe(0o755);
        fs.writeFileSync(join(dir, NAME), "y");
        await expect(fst.move(NAME, `closed/${NAME}`)).rejects.toThrow(
            `move gap file ${NAME}: closed/${NAME} exists`,
        );
    });

    it("fingerprints names, sizes and nanosecond mtimes", async () => {
        // --- Given ---
        fs.mkdirSync(join(dir, "closed"));
        fs.writeFileSync(join(dir, "closed", NAME), "abc");
        const ns = fs.lstatSync(join(dir, "closed", NAME), {
            bigint: true,
        }).mtimeNs;

        // --- When ---
        const have = await fst.state();

        // --- Then ---
        expect(have).toBe(`${[`closed/${NAME}`, 3, ns].join("\0")}\n`);
    });
});
