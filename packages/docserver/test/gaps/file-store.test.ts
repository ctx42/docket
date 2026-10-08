// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    FileStore,
    type GapFileName,
    peers,
    TidyError,
} from "../../src/gaps/file-store.ts";
import { FileError } from "../../src/gaps/format.ts";
import {
    EC_BAD_FILE,
    EC_INVALID,
    EC_NOT_FOUND,
    EC_STATUS,
    emptyGap,
    type Fill,
    type Gap,
    hash,
    home,
    isGapError,
    type Patch,
    type Resolver,
    type Status,
} from "../../src/gaps/gaps.ts";
import { GapIndex } from "../../src/gaps/index.ts";
import { isNotExist } from "../../src/ports.ts";
import { CanceledError } from "../../src/util/cancel.ts";
import { MemDocFs } from "../support/mem-doc-fs.ts";
import {
    AUTHORED,
    AUTHORED_NAME,
    AUTHORED_STORED,
    BrokenResolver,
    DIR,
    DriftedResolver,
    gapFileText,
    IMPORTED,
    IMPORTED_NAME,
    newStore,
    RANKED_GAPS,
    TEST_EPOCH,
    TEST_RESOLVER,
    Warnings,
    writeGap,
} from "./fixtures.ts";

/** CLOSED is the closed subfolder of the test stores. */
const CLOSED = `${DIR}/closed`;

/** caught returns what fn throws. */
async function caught(fn: () => Promise<unknown>): Promise<Error> {
    try {
        await fn();
    } catch (err) {
        return err as Error;
    }
    throw new Error("did not throw");
}

/** withRanked returns a store holding RANKED_GAPS. */
function withRanked(opts: { warn?: (err: Error) => void } = {}) {
    const st = newStore(opts);
    for (const gap of RANKED_GAPS) writeGap(st.mfs, DIR, gap);
    return st;
}

/** absentStore returns a store over a folder that does not exist. */
function absentStore(): FileStore {
    return new FileStore(
        new MemDocFs(),
        "/absent",
        () => TEST_EPOCH,
        TEST_RESOLVER,
    );
}

describe("FileStore", () => {
    // go: Test_NewFileStore
    it("keeps its folder and resolver", () => {
        // --- When ---
        const { fst } = newStore();

        // --- Then ---
        expect(fst.dir).toBe(DIR);
        expect(fst.res).toBe(TEST_RESOLVER);
        expect(fst.warn).toBeTypeOf("function");
        expect(fst.idx).toBeUndefined();
    });

    // go: Test_WithWarn
    it("reports to the warn option", () => {
        // --- Given ---
        const wrn = new Warnings();

        // --- When ---
        const { fst } = newStore({ warn: wrn.warn });

        // --- Then ---
        fst.warn(new Error("x"));
        expect(wrn.errs).toHaveLength(1);
    });
});

describe("FileStore.reindex", () => {
    // go: Test_FileStore_Reindex
    it("indexes every gap", async () => {
        // --- Given ---
        const { fst } = withRanked();

        // --- When ---
        const have = await fst.reindex();

        // --- Then ---
        expect(have).toBe(3);
        expect(fst.idx?.count).toBe(3);
    });

    // go: Test_FileStore_Reindex_skips_invalid_files
    it("skips invalid files", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        writeGap(mfs, DIR, AUTHORED_STORED);
        mfs.writeFile(`${DIR}/gap-0002-broken.md`, "junk");

        // --- When ---
        const have = await fst.reindex();

        // --- Then ---
        expect(have).toBe(1);
    });

    // go: Test_FileStore_Reindex_error_keeps_index
    it("keeps the index when the rebuild fails", async () => {
        // --- Given ---
        const { fst, mfs } = withRanked();
        await fst.reindex();
        const prev = fst.idx;
        mfs.removeAll(DIR);

        // --- When ---
        const err = await caught(() => fst.reindex());

        // --- Then ---
        expect(err.message).toContain("read gap folder");
        expect(fst.idx).toBe(prev);
    });

    // go: Test_FileStore_Reindex_error_canceled_context
    it("stops on a canceled signal", async () => {
        // --- Given ---
        const { fst } = newStore();

        // --- When ---
        const err = await caught(() => fst.reindex({ aborted: true }));

        // --- Then ---
        expect(err).toBeInstanceOf(CanceledError);
        expect(err.message).toBe("context canceled");
        expect(fst.idx).toBeUndefined();
    });
});

describe("FileStore.close", () => {
    // go: Test_FileStore_Close
    it("releases the index, twice", async () => {
        // --- Given ---
        const { fst } = newStore();
        await fst.reindex();
        const idx = fst.idx as GapIndex;

        // --- When ---
        await fst.close();

        // --- Then ---
        expect(fst.idx).toBeUndefined();
        expect(idx.search("x")).toEqual([]);
        await expect(fst.close()).resolves.toBeUndefined();
    });
});

describe("FileStore.current", () => {
    // go: Test_FileStore_current_rebuilds_on_change
    it("rebuilds an index the folder outgrew", async () => {
        // --- Given --- an index built before the gaps were written.
        const { fst } = withRanked();
        const stale = new GapIndex("", []);
        fst.idx = stale;

        // --- When ---
        const have = await fst.current();

        // --- Then ---
        expect(have).not.toBe(stale);
        expect(have.count).toBe(3);
    });

    // go: Test_FileStore_current_error_serves_previous
    it("serves the previous index when the rebuild fails", async () => {
        // --- Given ---
        const wrn = new Warnings();
        const { fst, mfs } = newStore({ warn: wrn.warn });
        await fst.reindex();
        const prev = fst.idx;
        mfs.removeAll(DIR);

        // --- When ---
        const have = await fst.current();

        // --- Then ---
        expect(have).toBe(prev);
        expect(wrn.errs).toHaveLength(1);
        expect(wrn.errs[0]?.message).toContain(
            "gap index: serving previous index: read gap folder",
        );
    });

    // go: Test_FileStore_current_error_without_index
    it("fails without a previous index", async () => {
        // --- Given ---
        const fst = absentStore();

        // --- When ---
        const err = await caught(() => fst.current());

        // --- Then ---
        expect(err.message).toContain("read gap folder");
    });
});

describe("FileStore.afterWrite", () => {
    // go: Test_FileStore_afterWrite_error_warns
    it("warns when the rebuild fails", async () => {
        // --- Given ---
        const wrn = new Warnings();
        const { fst, mfs } = newStore({ warn: wrn.warn });
        await fst.reindex();
        mfs.removeAll(DIR);

        // --- When ---
        await fst.afterWrite();

        // --- Then ---
        expect(wrn.errs).toHaveLength(1);
        expect(wrn.errs[0]?.message).toContain(
            "gap index: rebuild after write: read gap folder",
        );
    });

    it("does nothing without an index", async () => {
        // --- Given ---
        const { fst } = withRanked();

        // --- When ---
        await fst.afterWrite();

        // --- Then ---
        expect(fst.idx).toBeUndefined();
    });
});

describe("FileStore.refresh", () => {
    // go: Test_FileStore_refresh_keeps_current_index
    it("keeps an index matching the folder", async () => {
        // --- Given ---
        const { fst } = withRanked();
        await fst.reindex();
        const prev = fst.idx;

        // --- When ---
        await fst.refresh();

        // --- Then ---
        expect(fst.idx).toBe(prev);
    });

    // go: Test_FileStore_refresh_builds_missing_index
    it("builds a missing index", async () => {
        // --- Given ---
        const { fst } = withRanked();

        // --- When ---
        await fst.refresh();

        // --- Then ---
        expect(fst.idx?.count).toBe(3);
    });
});

describe("FileStore.rebuild", () => {
    // go: Test_FileStore_rebuild
    it("records the state", async () => {
        // --- Given ---
        const { fst } = withRanked();

        // --- When ---
        await fst.rebuild("state");

        // --- Then ---
        expect(fst.idx?.state).toBe("state");
        expect(fst.idx?.count).toBe(3);
    });

    // go: Test_FileStore_rebuild_warns_new_bad_files
    it("warns of new bad files and new reasons", async () => {
        // --- Given --- one bad file known to the index, then a second one
        // and a new reason for the first.
        const wrn = new Warnings();
        const { fst, mfs } = newStore({ warn: wrn.warn });
        mfs.writeFile(`${DIR}/gap-0001-a.md`, "junk");
        await fst.rebuild("one");
        mfs.writeFile(`${DIR}/gap-0001-a.md`, "---\n");
        mfs.writeFile(`${DIR}/gap-0002-b.md`, "junk");

        // --- When ---
        await fst.rebuild("two");

        // --- Then ---
        expect(wrn.errs.map((e) => e.message)).toEqual([
            "invalid gap file gap-0001-a.md: no front matter",
            "invalid gap file gap-0001-a.md: front matter not closed",
            "invalid gap file gap-0002-b.md: no front matter",
        ]);
        expect(isGapError(wrn.errs[1], EC_BAD_FILE)).toBe(true);
    });

    // go: Test_FileStore_rebuild_known_bad_file_warns_once
    it("warns of a known bad file once", async () => {
        // --- Given ---
        const wrn = new Warnings();
        const { fst, mfs } = newStore({ warn: wrn.warn });
        mfs.writeFile(`${DIR}/gap-0001-a.md`, "junk");
        await fst.rebuild("one");

        // --- When ---
        await fst.rebuild("two");

        // --- Then ---
        expect(wrn.errs).toHaveLength(1);
        expect(fst.idx?.bad).toHaveLength(1);
    });
});

describe("FileStore.state", () => {
    // go: Test_FileStore_state
    it("fingerprints the gap files only", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        writeGap(mfs, DIR, AUTHORED_STORED);
        mfs.writeFile(`${DIR}/notes.md`, "notes");
        mfs.mkdirp(`${DIR}/gap-0005-dir.md`);

        // --- When ---
        const have = await fst.state();

        // --- Then ---
        const info = await mfs.lstat(`${DIR}/${AUTHORED_NAME}`);
        expect(have).toBe(`${AUTHORED_NAME}\0${info.size}\0${info.mtimeNs}\n`);
    });

    // go: Test_FileStore_state_changes_on_rewrite
    it("changes when a file is rewritten", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        writeGap(mfs, DIR, AUTHORED_STORED);
        const prev = await fst.state();
        await fst.write(
            AUTHORED_NAME,
            gapFileText({ ...AUTHORED_STORED, hits: 2, topic: "x" }),
        );

        // --- When ---
        const have = await fst.state();

        // --- Then ---
        expect(have).not.toBe(prev);
    });

    // go: Test_FileStore_state_covers_closed_folder
    it("covers the closed folder", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        writeGap(mfs, CLOSED, IMPORTED);

        // --- When ---
        const have = await fst.state();

        // --- Then ---
        const info = await mfs.lstat(`${CLOSED}/${IMPORTED_NAME}`);
        expect(have).toBe(
            `closed/${IMPORTED_NAME}\0${info.size}\0${info.mtimeNs}\n`,
        );
    });

    // go: Test_FileStore_state_changes_on_move
    it("changes when a file is moved", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        writeGap(mfs, DIR, AUTHORED_STORED);
        const prev = await fst.state();
        mfs.mkdirp(CLOSED);
        await mfs.rename(
            `${DIR}/${AUTHORED_NAME}`,
            `${CLOSED}/${AUTHORED_NAME}`,
        );

        // --- When ---
        const have = await fst.state();

        // --- Then ---
        expect(have).not.toBe(prev);
    });

    // go: Test_FileStore_state_error_missing_folder
    it("fails on a missing folder", async () => {
        // --- When ---
        const err = await caught(() => absentStore().state());

        // --- Then ---
        expect(err.message).toContain("read gap folder");
    });

    it("skips a file gone since the listing", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        writeGap(mfs, DIR, AUTHORED_STORED);
        mfs.failOn("lstat", `${DIR}/${AUTHORED_NAME}`, { code: "ENOENT" });

        // --- When ---
        const have = await fst.state();

        // --- Then ---
        expect(have).toBe("");
    });

    it("fails when a file cannot be stat-ed", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        writeGap(mfs, DIR, AUTHORED_STORED);
        mfs.failOn("lstat", `${DIR}/${AUTHORED_NAME}`);

        // --- When ---
        const err = await caught(() => fst.state());

        // --- Then ---
        expect(err.message).toMatch(/^stat gap file: lstat .*: /);
    });
});

describe("FileStore.readAll", () => {
    // go: Test_FileStore_readAll
    it("returns valid gaps and bad files", async () => {
        // --- Given ---
        const { fst, mfs } = withRanked();
        mfs.writeFile(`${DIR}/gap-0004-broken.md`, "junk");

        // --- When ---
        const { list, bad } = await fst.readAll();

        // --- Then ---
        expect(list.map((g) => g.id)).toEqual([
            "gap-0001",
            "gap-0002",
            "gap-0003",
        ]);
        expect(bad).toEqual([
            { file: "gap-0004-broken.md", reason: "no front matter" },
        ]);
    });

    // go: Test_FileStore_readAll_shared_number
    it("refuses two files sharing a number", async () => {
        // --- Given --- two valid files carrying one number.
        const { fst, mfs } = newStore();
        writeGap(mfs, DIR, AUTHORED_STORED);
        mfs.writeFile(`${DIR}/gap-1-copy.md`, gapFileText(AUTHORED_STORED));
        writeGap(mfs, DIR, { ...AUTHORED_STORED, id: "gap-0002" });

        // --- When ---
        const { list, bad } = await fst.readAll();

        // --- Then ---
        expect(list.map((g) => g.id)).toEqual(["gap-0002"]);
        expect(bad).toEqual([
            {
                file: AUTHORED_NAME,
                reason: "duplicate id gap-0001, also in gap-1-copy.md",
            },
            {
                file: "gap-1-copy.md",
                reason: `duplicate id gap-0001, also in ${AUTHORED_NAME}`,
            },
        ]);
    });

    // go: Test_FileStore_readAll_shared_number_across_folders
    it("refuses a number shared across the folders", async () => {
        // --- Given --- one gap's file at the top and a copy in closed.
        const { fst, mfs } = newStore();
        writeGap(mfs, DIR, IMPORTED);
        writeGap(mfs, CLOSED, IMPORTED);

        // --- When ---
        const { list, bad } = await fst.readAll();

        // --- Then ---
        expect(list).toEqual([]);
        expect(bad).toEqual([
            {
                file: `closed/${IMPORTED_NAME}`,
                reason: `duplicate id gap-0007, also in ${IMPORTED_NAME}`,
            },
            {
                file: IMPORTED_NAME,
                reason: `duplicate id gap-0007, also in closed/${IMPORTED_NAME}`,
            },
        ]);
    });

    // go: Test_FileStore_readAll_empty_folder
    it("reads an empty folder", async () => {
        // --- When ---
        const have = await newStore().fst.readAll();

        // --- Then ---
        expect(have).toEqual({ list: [], bad: [] });
    });

    // go: Test_FileStore_readAll_error_missing_folder
    it("fails on a missing folder", async () => {
        // --- When ---
        const err = await caught(() => absentStore().readAll());

        // --- Then ---
        expect(err.message).toContain("read gap folder");
    });

    it("leaves out a file gone since the listing", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        writeGap(mfs, DIR, AUTHORED_STORED);
        mfs.failOn("readText", `${DIR}/${AUTHORED_NAME}`, { code: "ENOENT" });

        // --- When ---
        const have = await fst.readAll();

        // --- Then ---
        expect(have).toEqual({ list: [], bad: [] });
    });

    it("fails when a file cannot be read", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        writeGap(mfs, DIR, AUTHORED_STORED);
        mfs.failOn("readText", `${DIR}/${AUTHORED_NAME}`);

        // --- When ---
        const err = await caught(() => fst.readAll());

        // --- Then ---
        expect(err.message).toMatch(/^read gap file: open .*: /);
    });
});

describe("FileStore.load", () => {
    it("loads a gap by id", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        writeGap(mfs, DIR, AUTHORED_STORED);

        // --- When ---
        const have = await fst.load("gap-0001");

        // --- Then ---
        expect(have.name).toBe(AUTHORED_NAME);
        expect(have.gap.topic).toBe(AUTHORED_STORED.topic);
    });

    it.each([
        ["malformed id", "gap-1"],
        ["no file", "gap-0009"],
        ["id differs", "gap-00001"],
    ])("reports %s as not found", async (_name, id) => {
        // --- Given ---
        const { fst, mfs } = newStore();
        writeGap(mfs, DIR, AUTHORED_STORED);

        // --- When ---
        const err = await caught(() => fst.load(id));

        // --- Then ---
        expect(err.message).toBe("gap not found");
    });

    it("refuses a file of another number claiming the id", async () => {
        // --- Given --- a file numbered 2 stating gap-0001.
        const { fst, mfs } = newStore();
        mfs.writeFile(
            `${DIR}/gap-0002-x.md`,
            gapFileText({ ...AUTHORED_STORED, id: "gap-0002" }).replace(
                "id: gap-0002",
                "id: gap-0001",
            ),
        );

        // --- When ---
        const err = await caught(() => fst.load("gap-0001"));

        // --- Then ---
        expect(err).toBeInstanceOf(FileError);
        expect(err.message).toBe(
            'invalid gap file gap-0002-x.md: file name does not match id "gap-0001"',
        );
    });

    it("ignores a file whose front matter is unreadable", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        mfs.writeFile(`${DIR}/gap-0002-x.md`, "---\nid: gap-0001\n");

        // --- When ---
        const err = await caught(() => fst.load("gap-0001"));

        // --- Then ---
        expect(err.message).toBe("gap not found");
    });

    it("skips a claimant gone since the listing", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        writeGap(mfs, DIR, { ...AUTHORED_STORED, id: "gap-0002" });
        mfs.failOn("readText", `${DIR}/gap-0002-epub-download-token-ttl.md`, {
            code: "ENOENT",
        });

        // --- When ---
        const err = await caught(() => fst.load("gap-0001"));

        // --- Then ---
        expect(err.message).toBe("gap not found");
    });

    it("fails when a claimant cannot be read", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        writeGap(mfs, DIR, { ...AUTHORED_STORED, id: "gap-0002" });
        mfs.failOn("readText", `${DIR}/gap-0002-epub-download-token-ttl.md`);

        // --- When ---
        const err = await caught(() => fst.load("gap-0001"));

        // --- Then ---
        expect(err.message).toMatch(/^read gap file: /);
    });
});

describe("peers", () => {
    // go: Test_gapFileName_peers
    it("lists the other files of the number", () => {
        // --- Given ---
        const files: GapFileName[] = [
            { name: "gap-0001-a.md", num: 1 },
            { name: "gap-0002-b.md", num: 2 },
            { name: "gap-0002-c.md", num: 2 },
            { name: "gap-02-d.md", num: 2 },
        ];

        // --- When ---
        const have = peers(files[2] as GapFileName, files);

        // --- Then ---
        expect(have).toEqual(["gap-0002-b.md", "gap-02-d.md"]);
    });

    // go: Test_gapFileName_peers_none
    it("lists none for a unique number", () => {
        // --- Given ---
        const files: GapFileName[] = [
            { name: "gap-0001-a.md", num: 1 },
            { name: "gap-0002-b.md", num: 2 },
        ];

        // --- When ---
        const have = peers(files[0] as GapFileName, files);

        // --- Then ---
        expect(have).toEqual([]);
    });
});

describe("FileStore.entries", () => {
    // go: Test_FileStore_entries
    it("lists gap files of both folders", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        mfs.writeFile(`${DIR}/gap-0002-b.md`, "x");
        mfs.writeFile(`${DIR}/notes.md`, "x");
        mfs.mkdirp(`${DIR}/gap-0005-dir.md`);
        mfs.mkdirp(`${CLOSED}/sub`);
        mfs.writeFile(`${CLOSED}/gap-0001-a.md`, "x");
        mfs.writeFile(`${CLOSED}/sub/gap-0003-c.md`, "x");

        // --- When ---
        const have = await fst.entries();

        // --- Then ---
        expect(have).toEqual([
            { name: "gap-0002-b.md", base: "gap-0002-b.md" },
            { name: "closed/gap-0001-a.md", base: "gap-0001-a.md" },
        ]);
    });

    // go: Test_FileStore_entries_missing_closed_folder
    it("reads a missing closed folder as empty", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        mfs.writeFile(`${DIR}/gap-0002-b.md`, "x");

        // --- When ---
        const have = await fst.entries();

        // --- Then ---
        expect(have.map((e) => e.name)).toEqual(["gap-0002-b.md"]);
        expect(mfs.exists(CLOSED)).toBe(false);
    });

    // go: Test_FileStore_entries_error_closed_not_a_folder
    it("fails when closed is not a folder", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        mfs.writeFile(CLOSED, "x");

        // --- When ---
        const err = await caught(() => fst.entries());

        // --- Then ---
        expect(err.message).toMatch(/^read gap folder: .*not a directory/);
    });
});

describe("FileStore.write", () => {
    // go: Test_FileStore_write_keeps_mode_and_no_temp_file
    it("keeps the mode and leaves no temp file", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        writeGap(mfs, DIR, AUTHORED_STORED);
        mfs.chmod(`${DIR}/${AUTHORED_NAME}`, 0o600);

        // --- When ---
        await fst.write(
            AUTHORED_NAME,
            gapFileText({ ...AUTHORED_STORED, hits: 2 }),
        );

        // --- Then ---
        expect(mfs.paths().filter((p) => p.startsWith(`${DIR}/`))).toEqual([
            `${DIR}/${AUTHORED_NAME}`,
        ]);
        expect(mfs.modeOf(`${DIR}/${AUTHORED_NAME}`)).toBe(0o600);
        expect(mfs.readFile(`${DIR}/${AUTHORED_NAME}`)).toContain("hits: 2\n");
    });

    // go: Test_FileStore_write_creates_closed_folder
    it("creates the closed folder", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();

        // --- When ---
        await fst.write(`closed/${IMPORTED_NAME}`, "x");

        // --- Then ---
        expect(mfs.readFile(`${CLOSED}/${IMPORTED_NAME}`)).toBe("x");
        expect(mfs.modeOf(`${CLOSED}/${IMPORTED_NAME}`)).toBe(0o644);
        expect(mfs.modeOf(CLOSED)).toBe(0o755);
        expect(mfs.synced).toEqual([DIR, CLOSED]);
    });

    it.each([
        ["create", "create temp gap file"],
        ["chmod", "chmod temp gap file"],
        ["write", "write temp gap file"],
        ["sync", "sync temp gap file"],
        ["close", "close temp gap file"],
        ["rename", "replace gap file"],
        ["syncdir", "sync gap folder"],
    ] as const)("names a failing %s step", async (stage, want) => {
        // --- Given ---
        const { fst, mfs } = newStore();
        mfs.failOn("writeAtomic", `${DIR}/${IMPORTED_NAME}`, { stage });

        // --- When ---
        const err = await caught(() => fst.write(IMPORTED_NAME, "x"));

        // --- Then ---
        expect(err.message.startsWith(`${want}: `)).toBe(true);
    });
});

describe("FileStore.move", () => {
    // go: Test_FileStore_move
    it("moves into the closed folder", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        mfs.writeFile(`${DIR}/${IMPORTED_NAME}`, "x");

        // --- When ---
        await fst.move(IMPORTED_NAME, `closed/${IMPORTED_NAME}`);

        // --- Then ---
        expect(mfs.exists(`${DIR}/${IMPORTED_NAME}`)).toBe(false);
        expect(mfs.readFile(`${CLOSED}/${IMPORTED_NAME}`)).toBe("x");
        expect(mfs.synced).toEqual([DIR, CLOSED, DIR]);
    });

    // go: Test_FileStore_move_same_path
    it("does nothing for the same path", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        mfs.writeFile(`${DIR}/${IMPORTED_NAME}`, "x");

        // --- When ---
        await fst.move(IMPORTED_NAME, IMPORTED_NAME);

        // --- Then ---
        expect(mfs.readFile(`${DIR}/${IMPORTED_NAME}`)).toBe("x");
        expect(mfs.synced).toEqual([]);
    });

    // go: Test_FileStore_move_error_destination_exists
    it("refuses to replace a file", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        mfs.writeFile(`${DIR}/${IMPORTED_NAME}`, "top");
        mfs.writeFile(`${CLOSED}/${IMPORTED_NAME}`, "closed");

        // --- When ---
        const err = await caught(() =>
            fst.move(IMPORTED_NAME, `closed/${IMPORTED_NAME}`),
        );

        // --- Then ---
        expect(err.message).toBe(
            `move gap file ${IMPORTED_NAME}: closed/${IMPORTED_NAME} exists`,
        );
        expect(mfs.readFile(`${DIR}/${IMPORTED_NAME}`)).toBe("top");
        expect(mfs.readFile(`${CLOSED}/${IMPORTED_NAME}`)).toBe("closed");
    });

    // go: Test_FileStore_move_error_missing_source
    it("fails on a missing source", async () => {
        // --- Given ---
        const { fst } = newStore();

        // --- When ---
        const err = await caught(() =>
            fst.move(IMPORTED_NAME, `closed/${IMPORTED_NAME}`),
        );

        // --- Then ---
        expect(isNotExist(err)).toBe(true);
        expect(err.message).toContain("move gap file: rename ");
    });

    it("fails when the destination cannot be checked", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        mfs.failOn("lstat", `${CLOSED}/${IMPORTED_NAME}`);

        // --- When ---
        const err = await caught(() =>
            fst.move(IMPORTED_NAME, `closed/${IMPORTED_NAME}`),
        );

        // --- Then ---
        expect(err.message).toMatch(
            new RegExp(`^move gap file ${IMPORTED_NAME}: lstat `),
        );
    });

    it.each([
        ["destination", CLOSED],
        ["source", DIR],
    ])("fails when the %s folder cannot be synced", async (_name, dir) => {
        // --- Given ---
        const { fst, mfs } = newStore();
        mfs.writeFile(`${DIR}/${IMPORTED_NAME}`, "x");
        mfs.mkdirp(CLOSED);
        mfs.failOn("syncDir", dir);

        // --- When ---
        const err = await caught(() =>
            fst.move(IMPORTED_NAME, `closed/${IMPORTED_NAME}`),
        );

        // --- Then ---
        expect(err.message).toMatch(/^sync gap folder: /);
    });
});

describe("FileStore.ensureDir", () => {
    // go: Test_FileStore_ensureDir
    it("creates the closed folder", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();

        // --- When ---
        await fst.ensureDir(`closed/${IMPORTED_NAME}`);

        // --- Then ---
        expect(mfs.exists(CLOSED)).toBe(true);
        expect(mfs.synced).toEqual([DIR]);
    });

    // go: Test_FileStore_ensureDir_existing_folder
    it("keeps an existing closed folder", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        mfs.writeFile(`${CLOSED}/${IMPORTED_NAME}`, "x");

        // --- When ---
        await fst.ensureDir(`closed/${IMPORTED_NAME}`);

        // --- Then ---
        expect(mfs.readFile(`${CLOSED}/${IMPORTED_NAME}`)).toBe("x");
        expect(mfs.synced).toEqual([]);
    });

    // go: Test_FileStore_ensureDir_top_level_name
    it("does nothing for a top-level name", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();

        // --- When ---
        await fst.ensureDir(IMPORTED_NAME);

        // --- Then ---
        expect(mfs.exists(CLOSED)).toBe(false);
    });

    // go: Test_FileStore_ensureDir_error_missing_folder
    it("fails on a missing gap folder", async () => {
        // --- When ---
        const err = await caught(() =>
            absentStore().ensureDir(`closed/${IMPORTED_NAME}`),
        );

        // --- Then ---
        expect(isNotExist(err)).toBe(true);
        expect(err.message).toContain("create closed gap folder: ");
    });

    it("fails when the gap folder cannot be synced", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        mfs.failOn("syncDir", DIR);

        // --- When ---
        const err = await caught(() =>
            fst.ensureDir(`closed/${IMPORTED_NAME}`),
        );

        // --- Then ---
        expect(err.message).toMatch(/^sync gap folder: /);
    });
});

describe("FileStore.path", () => {
    // go: Test_FileStore_path
    it("joins the folder and name", () => {
        // --- When ---
        const have = newStore().fst.path(`closed/${IMPORTED_NAME}`);

        // --- Then ---
        expect(have).toBe(`${CLOSED}/${IMPORTED_NAME}`);
    });
});

describe("home", () => {
    // go: Test_home_tabular
    it.each([
        ["draft at top", IMPORTED_NAME, "draft", IMPORTED_NAME],
        ["open at top", IMPORTED_NAME, "open", IMPORTED_NAME],
        ["open in closed", `closed/${IMPORTED_NAME}`, "open", IMPORTED_NAME],
        ["filled at top", IMPORTED_NAME, "filled", `closed/${IMPORTED_NAME}`],
        [
            "filled in closed",
            `closed/${IMPORTED_NAME}`,
            "filled",
            `closed/${IMPORTED_NAME}`,
        ],
        ["wontfix at top", IMPORTED_NAME, "wontfix", `closed/${IMPORTED_NAME}`],
    ] as [string, string, Status, string][])("%s", (_n, name, sts, want) => {
        // --- When ---
        const have = home(name, sts);

        // --- Then ---
        expect(have).toBe(want);
    });
});

/** AUTHORED_FILE is the file append writes for AUTHORED as gap-0001. */
const AUTHORED_FILE = gapFileText(AUTHORED_STORED);

describe("FileStore.append", () => {
    // go: Test_FileStore_Append
    it("writes a new open gap", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();

        // --- When ---
        const have = await fst.append(AUTHORED);

        // --- Then ---
        expect(have).toBe("gap-0001");
        expect(mfs.readFile(`${DIR}/${AUTHORED_NAME}`)).toBe(
            "---\n" +
                "id: gap-0001\n" +
                "status: open\n" +
                "kind: missing\n" +
                "answer: deferred\n" +
                "ask: []\n" +
                'asked: ""\n' +
                "srd_ref: SRD-7 §4.3\n" +
                "doc_id: epub\n" +
                "heading_path:\n" +
                "  - Catalog\n" +
                "  - Delivery\n" +
                "search_terms:\n" +
                "  - token\n" +
                "  - ttl\n" +
                "hits: 1\n" +
                "created: 2026-07-14T10:00:00Z\n" +
                "filled_by: []\n" +
                "---\n" +
                "# EPUB download token TTL\n" +
                "\n" +
                "## Demand\n" +
                "\n" +
                "SRD-7 needs the token TTL.\n" +
                "\n" +
                "## Detail\n" +
                "\n" +
                "TTL never stated.\n" +
                "\n" +
                "## Target claim\n" +
                "\n" +
                "Token valid 24h.\n",
        );
        expect(AUTHORED_FILE).toBe(mfs.readFile(`${DIR}/${AUTHORED_NAME}`));
    });

    // go: Test_FileStore_Append_minimal_gap
    it("writes a minimal gap", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        const gap = {
            ...emptyGap(),
            kind: "wrong",
            topic: "¿¡!?",
            demand: "d",
            detail: "x",
        };

        // --- When ---
        await fst.append(gap);

        // --- Then ---
        expect(mfs.readFile(`${DIR}/gap-0001-gap.md`)).toBe(
            "---\n" +
                "id: gap-0001\n" +
                "status: open\n" +
                "kind: wrong\n" +
                'answer: ""\n' +
                "ask: []\n" +
                'asked: ""\n' +
                'srd_ref: ""\n' +
                'doc_id: ""\n' +
                "heading_path: []\n" +
                "search_terms: []\n" +
                "hits: 1\n" +
                "created: 2026-07-14T10:00:00Z\n" +
                "filled_by: []\n" +
                "---\n" +
                "# ¿¡!?\n" +
                "\n" +
                "## Demand\n" +
                "\n" +
                "d\n" +
                "\n" +
                "## Detail\n" +
                "\n" +
                "x\n" +
                "\n" +
                "## Target claim\n",
        );
    });

    // go: Test_FileStore_Append_ignores_store_owned_fields
    it("ignores the store-owned fields", async () => {
        // --- Given ---
        const { fst } = newStore();
        const gap = {
            ...AUTHORED,
            id: "gap-9999",
            status: "filled",
            hits: 7,
            filledBy: [{ ref: "kb/stale.md", hash: "" }],
            file: "stale.md",
        };

        // --- When ---
        const have = await fst.append(gap);

        // --- Then ---
        expect(have).toBe("gap-0001");
        const [stored] = (await fst.readAll()).list;
        expect(stored?.status).toBe("open");
        expect(stored?.hits).toBe(1);
        expect(stored?.filledBy).toEqual([]);
        expect(stored?.file).toBe(AUTHORED_NAME);
    });

    // go: Test_FileStore_Append_assigns_sequential_ids
    it("assigns sequential IDs", async () => {
        // --- Given ---
        const { fst } = newStore();
        const first = await fst.append(AUTHORED);

        // --- When ---
        const have = await fst.append(AUTHORED);

        // --- Then ---
        expect(first).toBe("gap-0001");
        expect(have).toBe("gap-0002");
    });

    // go: Test_FileStore_Append_counts_invalid_files
    it("counts invalid files", async () => {
        // --- Given --- a broken file still holds its number.
        const { fst, mfs } = newStore();
        mfs.writeFile(`${DIR}/gap-0041-broken.md`, "junk");
        mfs.writeFile(`${DIR}/notes.md`, "not a gap");

        // --- When ---
        const have = await fst.append(AUTHORED);

        // --- Then ---
        expect(have).toBe("gap-0042");
    });

    // go: Test_FileStore_Append_counts_closed_files
    it("counts closed files", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        writeGap(mfs, CLOSED, IMPORTED);

        // --- When ---
        const have = await fst.append(AUTHORED);

        // --- Then ---
        expect(have).toBe("gap-0008");
        expect(mfs.paths().filter((p) => /^\/gaps\/[^/]+$/.test(p))).toEqual([
            CLOSED,
            `${DIR}/gap-0008-epub-download-token-ttl.md`,
        ]);
    });

    // go: Test_FileStore_Append_cuts_long_slug
    it("cuts a long slug", async () => {
        // --- Given ---
        const { fst } = newStore();
        const gap = {
            ...AUTHORED,
            topic:
                "The quick brown fox jumps over the lazy dog and keeps " +
                "running far away",
        };

        // --- When ---
        await fst.append(gap);

        // --- Then ---
        const [stored] = (await fst.readAll()).list;
        expect(stored?.file).toBe(
            "gap-0001-" +
                "the-quick-brown-fox-jumps-over-the-lazy-dog-and-keeps-runnin.md",
        );
    });

    // go: Test_FileStore_Append_error_tabular
    it.each([
        [
            "unknown kind",
            { kind: "odd" },
            'invalid gap input: unknown kind "odd"',
        ],
        [
            "unknown doc",
            { docID: "kb/nope.md" },
            'invalid gap input: unknown reference "kb/nope.md"',
        ],
        [
            "doc id names section",
            { docID: "epub#delivery" },
            'doc_id "epub#delivery" must name a document, not a section',
        ],
    ])("refuses an %s", async (_name, edit, want) => {
        // --- Given ---
        const { fst, mfs } = newStore();

        // --- When ---
        const err = await caught(() => fst.append({ ...AUTHORED, ...edit }));

        // --- Then ---
        expect(isGapError(err, EC_INVALID)).toBe(true);
        expect(err.message).toContain(want);
        expect(mfs.paths().filter((p) => p.startsWith(`${DIR}/`))).toEqual([]);
    });

    // go: Test_FileStore_Append_error_canceled_context
    it("stops on a canceled signal", async () => {
        // --- When ---
        const err = await caught(() =>
            newStore().fst.append(AUTHORED, { aborted: true }),
        );

        // --- Then ---
        expect(err).toBeInstanceOf(CanceledError);
    });

    // go: Test_FileStore_Append_error_missing_folder
    it("fails on a missing folder", async () => {
        // --- When ---
        const err = await caught(() => absentStore().append(AUTHORED));

        // --- Then ---
        expect(err.message).toContain("read gap folder");
    });

    // go: Test_FileStore_Append_error_nil_resolver
    it("refuses a doc_id without a resolver", async () => {
        // --- Given ---
        const { fst } = newStore({}, null);

        // --- When ---
        const err = await caught(() => fst.append(AUTHORED));

        // --- Then ---
        expect(isGapError(err, EC_INVALID)).toBe(true);
        expect(err.message).toContain("no corpus to resolve against");
    });

    // go: Test_FileStore_Append_concurrent_ids_unique
    it("assigns unique IDs to concurrent appends", async () => {
        // --- Given ---
        const { fst } = newStore();

        // --- When ---
        const ids = await Promise.all(
            Array.from({ length: 20 }, () => fst.append(AUTHORED)),
        );

        // --- Then ---
        expect(new Set(ids).size).toBe(20);
    });

    // go: Test_FileStore_Append_ask_and_asked
    it("stores ask de-duplicated and asked", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        const gap = {
            ...emptyGap(),
            kind: "missing",
            answer: "deferred",
            ask: [" Anna M ", "Bob", "anna m"],
            asked: "2026-10-04",
            topic: "T",
            demand: "d",
            detail: "x",
        };

        // --- When ---
        const id = await fst.append(gap);

        // --- Then ---
        expect(mfs.readFile(`${DIR}/gap-0001-t.md`)).toContain(
            "---\n" +
                "id: gap-0001\n" +
                "status: open\n" +
                "kind: missing\n" +
                "answer: deferred\n" +
                "ask:\n" +
                "  - Anna M\n" +
                "  - Bob\n" +
                "asked: 2026-10-04\n" +
                'srd_ref: ""\n',
        );
        const [stored] = (await fst.readAll()).list;
        expect(stored?.id).toBe(id);
        expect(stored?.ask).toEqual(["Anna M", "Bob"]);
        expect(stored?.asked).toBe("2026-10-04");
    });

    // go: Test_FileStore_afterWrite_without_index
    it("builds no index", async () => {
        // --- Given ---
        const { fst } = newStore();

        // --- When ---
        await fst.append(AUTHORED);

        // --- Then ---
        expect(fst.idx).toBeUndefined();
    });

    it("rebuilds an existing index", async () => {
        // --- Given ---
        const { fst } = newStore();
        await fst.reindex();

        // --- When ---
        await fst.append(AUTHORED);

        // --- Then ---
        expect(fst.idx?.count).toBe(1);
    });
});

describe("FileStore.appendDraft", () => {
    // go: Test_FileStore_AppendDraft
    it("writes a draft", async () => {
        // --- Given ---
        const { fst } = newStore();

        // --- When ---
        const have = await fst.appendDraft(AUTHORED);

        // --- Then ---
        expect(have).toBe("gap-0001");
        const [stored] = (await fst.readAll()).list;
        expect(stored?.status).toBe("draft");
    });
});

describe("FileStore.import", () => {
    // go: Test_FileStore_Import
    it("writes the gap as given into its folder", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();

        // --- When ---
        const have = await fst.import(IMPORTED);

        // --- Then ---
        expect(have.file).toBe(`closed/${IMPORTED_NAME}`);
        expect(have.docID).toBe("epub");
        expect(mfs.readFile(`${CLOSED}/${IMPORTED_NAME}`)).toBe(
            "---\n" +
                "id: gap-0007\n" +
                "status: filled\n" +
                "kind: incomplete\n" +
                'answer: ""\n' +
                "ask: []\n" +
                'asked: ""\n' +
                'srd_ref: ""\n' +
                "doc_id: epub\n" +
                "heading_path: []\n" +
                "search_terms: []\n" +
                "hits: 3\n" +
                "created: 2026-05-02T08:30:00Z\n" +
                "filled_by:\n" +
                "  - ref: epub#tokens\n" +
                "    hash: ab\n" +
                "---\n" +
                "# EPUB token lifetime\n" +
                "\n" +
                "## Demand\n" +
                "\n" +
                "SRD-7 needs it.\n" +
                "\n" +
                "## Detail\n" +
                "\n" +
                "Stated now.\n" +
                "\n" +
                "## Target claim\n",
        );
        const { list } = await fst.readAll();
        expect(list).toEqual([have]);
    });

    // go: Test_FileStore_Import_open_gap
    it("writes an open gap at the top", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();

        // --- When ---
        const have = await fst.import({ ...IMPORTED, status: "open" });

        // --- Then ---
        expect(have.file).toBe(IMPORTED_NAME);
        expect(mfs.exists(CLOSED)).toBe(false);
        expect(mfs.exists(`${DIR}/${IMPORTED_NAME}`)).toBe(true);
    });

    // go: Test_FileStore_Import_hashes_unhashed_refs
    it("hashes unhashed refs", async () => {
        // --- Given ---
        const { fst } = newStore();
        const gap = {
            ...IMPORTED,
            filledBy: [{ ref: "docs/catalog/epub.md#tokens", hash: "" }],
        };

        // --- When ---
        const have = await fst.import(gap);

        // --- Then ---
        expect(have.filledBy).toEqual([
            { ref: "epub#tokens", hash: hash("epub#tokens") },
        ]);
    });

    // go: Test_FileStore_Import_error_tabular
    it.each([
        ["check", { hits: 0 }, "hits must be at least 1"],
        ["doc_id", { docID: "kb/nope.md" }, 'unknown reference "kb/nope.md"'],
        [
            "filled_by",
            { filledBy: [{ ref: "epub#nope", hash: "" }] },
            'unknown reference "epub#nope"',
        ],
        [
            "filled_by under initiatives",
            { filledBy: [{ ref: "initiatives/int7.md#scope", hash: "" }] },
            '"initiatives/int7.md#scope" is under the initiatives folder',
        ],
    ])("refuses a bad %s", async (_name, edit, want) => {
        // --- Given ---
        const { fst, mfs } = newStore();

        // --- When ---
        const err = await caught(() => fst.import({ ...IMPORTED, ...edit }));

        // --- Then ---
        expect(isGapError(err, EC_INVALID)).toBe(true);
        expect(err.message).toMatch(/^import gap-0007: invalid gap input: /);
        expect(err.message).toContain(want);
        expect(mfs.paths().filter((p) => p.startsWith(`${DIR}/`))).toEqual([]);
    });

    // go: Test_FileStore_Import_error_number_taken
    it("refuses a number a file holds", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        mfs.writeFile(`${DIR}/gap-0007-other.md`, "x");

        // --- When ---
        const err = await caught(() => fst.import(IMPORTED));

        // --- Then ---
        expect(isGapError(err, EC_INVALID)).toBe(true);
        expect(err.message).toBe(
            "import gap-0007: invalid gap input: file gap-0007-other.md " +
                "holds its number",
        );
    });

    // go: Test_FileStore_Import_error_number_taken_in_closed
    it("refuses a number a closed file holds", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        mfs.writeFile(`${CLOSED}/gap-0007-x.md`, "x");

        // --- When ---
        const err = await caught(() => fst.import(IMPORTED));

        // --- Then ---
        expect(err.message).toContain(
            "file closed/gap-0007-x.md holds its number",
        );
    });

    // go: Test_FileStore_Import_error_canceled_context
    it("stops on a canceled signal", async () => {
        // --- When ---
        const err = await caught(() =>
            newStore().fst.import(IMPORTED, { aborted: true }),
        );

        // --- Then ---
        expect(err).toBeInstanceOf(CanceledError);
    });
});

describe("FileStore references", () => {
    it("hashes a reference's current text", async () => {
        // --- When ---
        const have = await newStore().fst.currentHash("epub#tokens");

        // --- Then ---
        expect(have).toBe(hash("epub#tokens"));
    });

    it.each([
        ["currentHash", (fst: FileStore) => fst.currentHash("epub#tokens")],
        ["resolveFill", (fst: FileStore) => fst.resolveFill("epub#tokens")],
    ])("%s refuses without a resolver", async (_name, call) => {
        // --- Given ---
        const { fst } = newStore({}, null);

        // --- When ---
        const err = await caught(() => call(fst));

        // --- Then ---
        expect(err.message).toBe(
            'invalid gap input: cannot resolve "epub#tokens": no corpus to ' +
                "resolve against",
        );
    });
});

/** stored returns the store's valid gaps, by number. */
async function stored(fst: FileStore): Promise<Gap[]> {
    return (await fst.readAll()).list;
}

/** topNames lists the entries of the gap folder's top. */
function topNames(mfs: MemDocFs): string[] {
    return mfs
        .paths()
        .filter((p) => /^\/gaps\/[^/]+$/.test(p))
        .map((p) => p.slice(DIR.length + 1));
}

/** closedNames lists the entries of the closed folder. */
function closedNames(mfs: MemDocFs): string[] {
    return mfs
        .paths()
        .filter((p) => p.startsWith(`${CLOSED}/`))
        .map((p) => p.slice(CLOSED.length + 1));
}

/** moveToClosed moves name into the closed folder as a person would. */
async function moveToClosed(mfs: MemDocFs, name: string): Promise<void> {
    mfs.mkdirp(CLOSED);
    await mfs.rename(`${DIR}/${name}`, `${CLOSED}/${name}`);
}

describe("FileStore.update", () => {
    // go: Test_FileStore_Update
    it("applies every patch field", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        const id = await fst.append(AUTHORED);
        const pch: Patch = {
            kind: "wrong",
            answer: "",
            srdRef: "SRD-8",
            docID: "kb/shipping.md",
            headingPath: ["Express"],
            searchTerms: [],
            topic: "Express shipping",
            demand: "SRD-8 needs it.",
            detail: "Never stated.",
            targetClaim: "",
            addHit: true,
        };

        // --- When ---
        await fst.update(id, pch);

        // --- Then ---
        expect(mfs.readFile(`${DIR}/${AUTHORED_NAME}`)).toBe(
            "---\n" +
                "id: gap-0001\n" +
                "status: open\n" +
                "kind: wrong\n" +
                'answer: ""\n' +
                "ask: []\n" +
                'asked: ""\n' +
                "srd_ref: SRD-8\n" +
                "doc_id: kb/shipping.md\n" +
                "heading_path:\n" +
                "  - Express\n" +
                "search_terms: []\n" +
                "hits: 2\n" +
                "created: 2026-07-14T10:00:00Z\n" +
                "filled_by: []\n" +
                "---\n" +
                "# Express shipping\n" +
                "\n" +
                "## Demand\n" +
                "\n" +
                "SRD-8 needs it.\n" +
                "\n" +
                "## Detail\n" +
                "\n" +
                "Never stated.\n" +
                "\n" +
                "## Target claim\n",
        );
    });

    // go: Test_FileStore_Update_keeps_edits_made_on_disk
    it("keeps edits made on disk", async () => {
        // --- Given --- a gap edited by hand as Obsidian would.
        const { fst, mfs } = newStore();
        const id = await fst.append(AUTHORED);
        const head =
            "---\n" +
            "id: gap-0001\n" +
            "tags: [srd, epub]   # Obsidian tags.\n" +
            "status: open\n" +
            "kind: missing\n" +
            "answer: deferred\n" +
            "srd_ref: 'SRD-7 §4.3'\n" +
            "doc_id: epub\n" +
            "heading_path: [Catalog, Delivery]\n" +
            "search_terms:\n" +
            "    - token\n" +
            "    - ttl\n" +
            "\n" +
            "# Counted by the server.\n";
        const mid =
            "created: 2026-07-14T10:00:00Z\n" +
            "---\n" +
            "# EPUB download token TTL\n" +
            "\n" +
            "## Demand\n" +
            "\n" +
            "SRD-7 needs the token TTL.\n" +
            "\n" +
            "## Detail\n" +
            "\n" +
            "The FAQ hints at 24h; asked the support lead.\n" +
            "\n" +
            "```text\n" +
            "## Target claim\n" +
            "```\n" +
            "\n" +
            "## Target claim\n" +
            "\n";
        const tail = "\n## Notes\n\n- call on Monday\n";
        mfs.writeFile(
            `${DIR}/${AUTHORED_NAME}`,
            `${head}hits: 1\n${mid}Token valid 24h.\n${tail}`,
        );

        // --- When ---
        await fst.update(id, { targetClaim: "Token valid 48h.", addHit: true });

        // --- Then ---
        expect(mfs.readFile(`${DIR}/${AUTHORED_NAME}`)).toBe(
            `${head}hits: 2\n${mid}Token valid 48h.\n${tail}`,
        );
    });

    // go: Test_FileStore_Update_adds_ask_and_asked
    it("adds ask and asked after their predecessors", async () => {
        // --- Given --- a gap file written before ask and asked existed.
        const { fst, mfs } = newStore();
        const body = "# T\n## Demand\n## Detail\n## Target claim\n";
        mfs.writeFile(
            `${DIR}/gap-0001-t.md`,
            "---\n" +
                "id: gap-0001\n" +
                "status: open\n" +
                "kind: missing\n" +
                "answer: deferred\n" +
                "srd_ref: SRD-7\n" +
                "hits: 1\n" +
                "created: 2026-07-14T10:00:00Z\n" +
                `---\n${body}`,
        );

        // --- When ---
        await fst.update("gap-0001", {
            ask: ["Anna M", "ANNA M", "Carl"],
            asked: "2026-10-04",
        });

        // --- Then ---
        expect(mfs.readFile(`${DIR}/gap-0001-t.md`)).toBe(
            "---\n" +
                "id: gap-0001\n" +
                "status: open\n" +
                "kind: missing\n" +
                "answer: deferred\n" +
                "ask:\n" +
                "  - Anna M\n" +
                "  - Carl\n" +
                "asked: 2026-10-04\n" +
                "srd_ref: SRD-7\n" +
                "hits: 1\n" +
                "created: 2026-07-14T10:00:00Z\n" +
                `---\n${body}`,
        );
    });

    // go: Test_FileStore_Update_clears_ask_and_asked
    it("clears ask and asked", async () => {
        // --- Given ---
        const { fst } = newStore();
        const id = await fst.append({
            ...AUTHORED,
            ask: ["Anna M"],
            asked: "2026-10-04",
        });

        // --- When ---
        await fst.update(id, { ask: [], asked: "" });

        // --- Then ---
        const [gap] = await stored(fst);
        expect(gap?.ask).toEqual([]);
        expect(gap?.asked).toBe("");
    });

    // go: Test_FileStore_Update_ask_keeps_asked
    it("keeps asked when ask changes", async () => {
        // --- Given ---
        const { fst } = newStore();
        const id = await fst.appendDraft({
            ...AUTHORED,
            ask: ["Anna M"],
            asked: "2026-10-04",
        });

        // --- When ---
        await fst.update(id, { ask: ["Anna M", "Bob"] });

        // --- Then ---
        const [gap] = await stored(fst);
        expect(gap?.ask).toEqual(["Anna M", "Bob"]);
        expect(gap?.asked).toBe("2026-10-04");
    });

    // go: Test_FileStore_Update_draft
    it("renames the topic of a draft keeping the file name", async () => {
        // --- Given ---
        const { fst } = newStore();
        const id = await fst.appendDraft(AUTHORED);

        // --- When ---
        await fst.update(id, { topic: "Renamed" });

        // --- Then ---
        const [gap] = await stored(fst);
        expect(gap?.topic).toBe("Renamed");
        expect(gap?.file).toBe(AUTHORED_NAME);
    });

    // go: Test_FileStore_Update_error_tabular
    it.each([
        ["empty patch", "gap-0001", {}, EC_INVALID],
        ["blank topic", "gap-0001", { topic: " " }, EC_INVALID],
        ["unknown doc", "gap-0001", { docID: "x" }, EC_INVALID],
        ["bad asked", "gap-0001", { asked: "4.10.26" }, EC_INVALID],
        ["blank ask", "gap-0001", { ask: [" "] }, EC_INVALID],
        ["filled", "gap-0002", { addHit: true }, EC_STATUS],
        ["filled ask", "gap-0002", { ask: ["A"] }, EC_STATUS],
        ["unknown id", "gap-0404", { addHit: true }, EC_NOT_FOUND],
        ["malformed id", "gap-1", { addHit: true }, EC_NOT_FOUND],
    ] as [string, string, Patch, string][])(
        "refuses %s",
        async (_name, id, pch, want) => {
            // --- Given --- an open gap-0001 and a filled gap-0002.
            const { fst } = newStore();
            await fst.append(AUTHORED);
            const done = await fst.append(AUTHORED);
            await fst.fill(done, { refs: ["epub"], complete: true });

            // --- When ---
            const err = await caught(() => fst.update(id, pch));

            // --- Then ---
            expect(isGapError(err, want)).toBe(true);
        },
    );

    it("stops on a canceled signal", async () => {
        // --- Given ---
        const { fst } = newStore();
        const id = await fst.append(AUTHORED);

        // --- When ---
        const err = await caught(() =>
            fst.update(id, { addHit: true }, { aborted: true }),
        );

        // --- Then ---
        expect(err).toBeInstanceOf(CanceledError);
    });
});

describe("FileStore.submit", () => {
    // go: Test_FileStore_Submit
    it("opens a draft", async () => {
        // --- Given ---
        const { fst } = newStore();
        const id = await fst.appendDraft(AUTHORED);

        // --- When ---
        await fst.submit(id);

        // --- Then ---
        const [gap] = await stored(fst);
        expect(gap?.status).toBe("open");
    });

    // go: Test_FileStore_Submit_error_not_draft
    it("refuses an open gap", async () => {
        // --- Given ---
        const { fst } = newStore();
        const id = await fst.append(AUTHORED);

        // --- When ---
        const err = await caught(() => fst.submit(id));

        // --- Then ---
        expect(isGapError(err, EC_STATUS)).toBe(true);
        expect(err.message).toBe(
            "submit gap-0001: gap status does not allow the operation: " +
                "it is open, the operation needs draft",
        );
    });
});

describe("FileStore.discard", () => {
    // go: Test_FileStore_Discard
    it("deletes a draft and frees its number", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        await fst.append(AUTHORED);
        const id = await fst.appendDraft(AUTHORED);

        // --- When ---
        await fst.discard(id);

        // --- Then ---
        expect(topNames(mfs)).toEqual([AUTHORED_NAME]);
        expect(await fst.append(AUTHORED)).toBe("gap-0002");
    });

    // go: Test_FileStore_Discard_draft_in_closed_folder
    it("deletes a draft from the closed folder", async () => {
        // --- Given --- a draft moved into the closed folder by hand.
        const { fst, mfs } = newStore();
        const id = await fst.appendDraft(AUTHORED);
        await moveToClosed(mfs, AUTHORED_NAME);

        // --- When ---
        await fst.discard(id);

        // --- Then ---
        expect(topNames(mfs)).toEqual(["closed"]);
        expect(closedNames(mfs)).toEqual([]);
        expect(mfs.synced.at(-1)).toBe(CLOSED);
    });

    // go: Test_FileStore_Discard_error_tabular
    it.each([
        ["open", "gap-0001", EC_STATUS],
        ["unknown id", "gap-0404", EC_NOT_FOUND],
    ])("refuses an %s gap", async (_name, id, want) => {
        // --- Given ---
        const { fst, mfs } = newStore();
        await fst.append(AUTHORED);

        // --- When ---
        const err = await caught(() => fst.discard(id));

        // --- Then ---
        expect(isGapError(err, want)).toBe(true);
        expect(topNames(mfs)).toEqual([AUTHORED_NAME]);
    });

    // go: Test_FileStore_Discard_error_canceled_context
    it("stops on a canceled signal", async () => {
        // --- Given ---
        const { fst } = newStore();
        const id = await fst.appendDraft(AUTHORED);

        // --- When ---
        const err = await caught(() => fst.discard(id, { aborted: true }));

        // --- Then ---
        expect(err).toBeInstanceOf(CanceledError);
    });

    it("fails when the file cannot be removed", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        const id = await fst.appendDraft(AUTHORED);
        mfs.failOn("remove", `${DIR}/${AUTHORED_NAME}`);

        // --- When ---
        const err = await caught(() => fst.discard(id));

        // --- Then ---
        expect(err.message).toMatch(/^discard gap-0001: remove /);
    });

    it("fails when the folder cannot be synced", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        const id = await fst.appendDraft(AUTHORED);
        mfs.failOn("syncDir", DIR);

        // --- When ---
        const err = await caught(() => fst.discard(id));

        // --- Then ---
        expect(err.message).toMatch(/^sync gap folder: /);
    });
});

describe("FileStore.fill", () => {
    // go: Test_FileStore_Fill
    it("fills and closes a gap", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        const id = await fst.append(AUTHORED);

        // --- When ---
        await fst.fill(id, {
            refs: ["docs/catalog/epub.md#tokens", "epub#tokens", "epub"],
            complete: true,
        });

        // --- Then ---
        expect(mfs.exists(`${DIR}/${AUTHORED_NAME}`)).toBe(false);
        const have = mfs.readFile(`${CLOSED}/${AUTHORED_NAME}`);
        expect(have).toContain("status: filled\n");
        expect(have).toContain(
            "filled_by:\n" +
                "  - ref: epub#tokens\n" +
                `    hash: ${hash("epub#tokens")}\n` +
                "  - ref: epub\n" +
                `    hash: ${hash("epub")}\n` +
                "---\n",
        );
    });

    // go: Test_FileStore_Fill_keeps_ask_and_asked
    it("keeps ask and asked", async () => {
        // --- Given ---
        const { fst } = newStore();
        const id = await fst.append({
            ...AUTHORED,
            ask: ["Anna M"],
            asked: "2026-10-04",
        });

        // --- When ---
        await fst.fill(id, { refs: ["epub"], complete: true });

        // --- Then ---
        const [gap] = await stored(fst);
        expect(gap?.status).toBe("filled");
        expect(gap?.ask).toEqual(["Anna M"]);
        expect(gap?.asked).toBe("2026-10-04");
    });

    // go: Test_FileStore_Fill_partial
    it("fills partly, keeping the gap open", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        const id = await fst.append(AUTHORED);

        // --- When ---
        await fst.fill(id, {
            refs: ["epub#delivery"],
            complete: false,
            remaining: "TTL unit.",
        });

        // --- Then ---
        const [gap] = await stored(fst);
        expect(gap?.status).toBe("open");
        expect(gap?.filledBy).toEqual([
            { ref: "epub#delivery", hash: hash("epub#delivery") },
        ]);
        expect(gap?.detail).toBe("TTL unit.");
        expect(gap?.file).toBe(AUTHORED_NAME);
        expect(topNames(mfs)).toEqual([AUTHORED_NAME]);
    });

    // go: Test_FileStore_Fill_partial_moves_misplaced_gap
    it("moves a misplaced open gap back to the top", async () => {
        // --- Given --- an open gap moved into the closed folder by hand.
        const { fst, mfs } = newStore();
        const id = await fst.append(AUTHORED);
        await moveToClosed(mfs, AUTHORED_NAME);

        // --- When ---
        await fst.fill(id, { refs: ["epub#delivery"], complete: false });

        // --- Then ---
        expect(topNames(mfs)).toEqual(["closed", AUTHORED_NAME]);
        expect(closedNames(mfs)).toEqual([]);
        expect(mfs.readFile(`${DIR}/${AUTHORED_NAME}`)).toContain(
            "  - ref: epub#delivery\n",
        );
    });

    // go: Test_FileStore_Fill_refreshes_filled_gap
    it("refreshes a filled gap's hashes", async () => {
        // --- Given --- a filled gap whose recorded hash no longer matches.
        const { fst, mfs } = newStore();
        await fst.import(IMPORTED);

        // --- When ---
        await fst.fill(IMPORTED.id, { refs: ["epub#tokens"], complete: true });

        // --- Then ---
        const have = mfs.readFile(`${CLOSED}/${IMPORTED_NAME}`);
        expect(have).toContain("status: filled\n");
        expect(have).toContain(
            `  - ref: epub#tokens\n    hash: ${hash("epub#tokens")}\n`,
        );
        const [gap] = await stored(fst);
        expect(gap?.file).toBe(`closed/${IMPORTED_NAME}`);
        expect(topNames(mfs)).toEqual(["closed"]);
    });

    // go: Test_FileStore_Fill_error_partial_on_filled
    it("refuses a partial fill of a filled gap", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        await fst.import(IMPORTED);

        // --- When ---
        const err = await caught(() =>
            fst.fill(IMPORTED.id, { refs: ["epub#tokens"], complete: false }),
        );

        // --- Then ---
        expect(isGapError(err, EC_STATUS)).toBe(true);
        expect(err.message).toContain("it is filled, the operation needs open");
        expect(mfs.readFile(`${CLOSED}/${IMPORTED_NAME}`)).toContain(
            "    hash: ab\n",
        );
    });

    // go: Test_FileStore_Fill_error_tabular
    it.each([
        [
            "empty filled_by",
            "gap-0001",
            { refs: [], complete: true },
            "invalid gap input: filled_by is required",
        ],
        [
            "unknown doc",
            "gap-0001",
            { refs: ["epub", "kb/nope.md"], complete: true },
            'invalid gap input: unknown reference "kb/nope.md"',
        ],
        [
            "unknown anchor",
            "gap-0001",
            { refs: ["epub#nope"], complete: true },
            'invalid gap input: unknown reference "epub#nope"',
        ],
        [
            "under initiatives",
            "gap-0001",
            { refs: ["initiatives/int7.md#scope"], complete: true },
            '"initiatives/int7.md#scope" is under the initiatives folder',
        ],
        [
            "draft",
            "gap-0002",
            { refs: ["epub"], complete: true },
            "it is draft, the operation needs open",
        ],
    ] as [string, string, Fill, string][])(
        "refuses %s",
        async (_name, id, fll, want) => {
            // --- Given --- an open gap-0001 and a draft gap-0002.
            const { fst } = newStore();
            await fst.append(AUTHORED);
            await fst.appendDraft(AUTHORED);

            // --- When ---
            const err = await caught(() => fst.fill(id, fll));

            // --- Then ---
            expect(err.message).toContain(want);
            const list = await stored(fst);
            expect(list.map((g) => g.filledBy)).toEqual([[], []]);
        },
    );
});

describe("FileStore.reopen", () => {
    // go: Test_FileStore_Reopen
    it("reopens a filled gap with a dated note", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        const id = await fst.append(AUTHORED);
        await fst.fill(id, { refs: ["epub"], complete: true });

        // --- When ---
        await fst.reopen(id, "The section moved.");

        // --- Then ---
        const [gap] = await stored(fst);
        expect(gap?.status).toBe("open");
        expect(gap?.filledBy).toEqual([{ ref: "epub", hash: hash("epub") }]);
        expect(gap?.detail).toBe(
            "TTL never stated.\n\nReopened 2026-07-14: The section moved.",
        );
        expect(gap?.file).toBe(AUTHORED_NAME);
        expect(closedNames(mfs)).toEqual([]);
    });

    // go: Test_FileStore_Reopen_error_tabular
    it.each([
        ["blank reason", " ", EC_INVALID],
        ["open", "why", EC_STATUS],
    ])("refuses %s", async (_name, reason, want) => {
        // --- Given ---
        const { fst } = newStore();
        const id = await fst.append(AUTHORED);

        // --- When ---
        const err = await caught(() => fst.reopen(id, reason));

        // --- Then ---
        expect(isGapError(err, want)).toBe(true);
    });
});

describe("FileStore.wontfix", () => {
    // go: Test_FileStore_Wontfix
    it("closes an open gap with a dated note", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        const id = await fst.append(AUTHORED);

        // --- When ---
        await fst.wontfix(id, "Internal detail.");

        // --- Then ---
        const [gap] = await stored(fst);
        expect(gap?.status).toBe("wontfix");
        expect(gap?.detail).toBe(
            "TTL never stated.\n\nWon't fix 2026-07-14: Internal detail.",
        );
        expect(gap?.file).toBe(`closed/${AUTHORED_NAME}`);
        expect(topNames(mfs)).toEqual(["closed"]);
    });

    // go: Test_FileStore_Wontfix_after_interrupted_move
    it("finishes an interrupted move", async () => {
        // --- Given --- the unchanged file in the closed folder, as a crash
        // between the move and the rewrite leaves it.
        const { fst, mfs } = newStore();
        const id = await fst.append(AUTHORED);
        await moveToClosed(mfs, AUTHORED_NAME);

        // --- When ---
        await fst.wontfix(id, "Internal detail.");

        // --- Then ---
        const list = await stored(fst);
        expect(list).toHaveLength(1);
        expect(list[0]?.status).toBe("wontfix");
        expect(list[0]?.file).toBe(`closed/${AUTHORED_NAME}`);
        expect(topNames(mfs)).toEqual(["closed"]);
    });

    // go: Test_FileStore_Wontfix_error_move_keeps_file
    it("keeps the file when the move fails", async () => {
        // --- Given --- a closed folder the store cannot write to.
        const { fst, mfs } = newStore();
        const id = await fst.append(AUTHORED);
        mfs.mkdirp(CLOSED, 0o555);

        // --- When ---
        const err = await caught(() => fst.wontfix(id, "why"));

        // --- Then ---
        expect(err.message).toContain("wontfix gap-0001: move gap file: ");
        expect(mfs.readFile(`${DIR}/${AUTHORED_NAME}`)).toBe(AUTHORED_FILE);
        expect(closedNames(mfs)).toEqual([]);
    });

    it("moves the file back when the rewrite fails", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        const id = await fst.append(AUTHORED);
        mfs.failOn("writeAtomic", `${CLOSED}/${AUTHORED_NAME}`);

        // --- When ---
        const err = await caught(() => fst.wontfix(id, "why"));

        // --- Then ---
        expect(err.message).toMatch(/^create temp gap file: /);
        expect(mfs.readFile(`${DIR}/${AUTHORED_NAME}`)).toBe(AUTHORED_FILE);
        expect(closedNames(mfs)).toEqual([]);
    });
});

describe("FileStore transitions", () => {
    type Op = (fst: FileStore, id: string) => Promise<void>;
    const ops: Record<string, Op> = {
        update: (fst, id) => fst.update(id, { addHit: true }),
        submit: (fst, id) => fst.submit(id),
        discard: (fst, id) => fst.discard(id),
        fill: (fst, id) => fst.fill(id, { refs: ["epub"], complete: true }),
        reopen: (fst, id) => fst.reopen(id, "why"),
        wontfix: (fst, id) => fst.wontfix(id, "why"),
    };
    const allowed: Record<Status, string[]> = {
        draft: ["update", "submit", "discard"],
        open: ["update", "fill", "wontfix"],
        filled: ["fill", "reopen"],
        wontfix: [],
    };
    const setup: Record<Status, (fst: FileStore) => Promise<string>> = {
        draft: (fst) => fst.appendDraft(AUTHORED),
        open: (fst) => fst.append(AUTHORED),
        filled: async (fst) => {
            const id = await fst.append(AUTHORED);
            await fst.fill(id, { refs: ["epub"], complete: true });
            return id;
        },
        wontfix: async (fst) => {
            const id = await fst.append(AUTHORED);
            await fst.wontfix(id, "why");
            return id;
        },
    };
    const rows = (Object.keys(setup) as Status[]).flatMap((sts) =>
        Object.keys(ops).map((name) => [sts, name] as const),
    );

    // go: Test_FileStore_transitions_tabular
    it.each(rows)("%s %s", async (sts, name) => {
        // --- Given ---
        const { fst } = newStore();
        const id = await setup[sts](fst);
        const ok = allowed[sts].includes(name);

        // --- When ---
        const run = (ops[name] as Op)(fst, id);

        // --- Then ---
        if (ok) {
            await expect(run).resolves.toBeUndefined();
        } else {
            const err = await caught(() => run);
            expect(isGapError(err, EC_STATUS)).toBe(true);
        }
    });
});

describe("FileStore after a write", () => {
    // go: Test_FileStore_afterWrite_rebuilds_index
    it("rebuilds an existing index", async () => {
        // --- Given ---
        const { fst } = newStore();
        await fst.reindex();

        // --- When ---
        await fst.append(AUTHORED);

        // --- Then ---
        expect(fst.idx?.count).toBe(1);
        await fst.update("gap-0001", { topic: "Parcel weight" });
        expect(fst.idx?.search("parcel")).toHaveLength(1);
        await fst.appendDraft(AUTHORED);
        await fst.discard("gap-0002");
        expect(fst.idx?.count).toBe(1);
    });
});

describe("FileStore operations on invalid files", () => {
    // go: Test_FileStore_operation_on_invalid_file
    it("refuses a file whose number disagrees with its id", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        await fst.append(AUTHORED);
        await mfs.rename(`${DIR}/${AUTHORED_NAME}`, `${DIR}/gap-0007-moved.md`);

        // --- When ---
        const err = await caught(() => fst.wontfix("gap-0007", "why"));

        // --- Then ---
        expect(isGapError(err, EC_BAD_FILE)).toBe(true);
        expect(err.message).toContain(
            'gap-0007-moved.md: file name does not match id "gap-0001"',
        );
    });

    // go: Test_FileStore_operation_on_shared_number
    it("refuses a shared number", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        await fst.append(AUTHORED);
        mfs.writeFile(`${DIR}/gap-0001-copy.md`, AUTHORED_FILE);

        // --- When ---
        const err = await caught(() => fst.submit("gap-0001"));

        // --- Then ---
        expect(isGapError(err, EC_BAD_FILE)).toBe(true);
        expect(err.message).toBe(
            "submit gap-0001: invalid gap file gap-0001-copy.md: " +
                `duplicate id gap-0001, also in ${AUTHORED_NAME}`,
        );
    });

    // go: Test_FileStore_operation_on_claimed_id
    it("refuses an id a renamed file still claims", async () => {
        // --- Given --- no file carries number 1, but one renamed to 7
        // still states gap-0001.
        const { fst, mfs } = newStore();
        await fst.append(AUTHORED);
        await fst.append(AUTHORED);
        await mfs.rename(`${DIR}/${AUTHORED_NAME}`, `${DIR}/gap-0007-moved.md`);

        // --- When ---
        const err = await caught(() => fst.submit("gap-0001"));

        // --- Then ---
        expect(isGapError(err, EC_BAD_FILE)).toBe(true);
        expect(err.message).toBe(
            "submit gap-0001: invalid gap file gap-0007-moved.md: " +
                'file name does not match id "gap-0001"',
        );
    });

    // go: Test_FileStore_operation_on_unclaimed_id
    it("reports an unclaimed id as not found", async () => {
        // --- Given --- broken files, none stating gap-0005.
        const { fst, mfs } = newStore();
        await fst.append(AUTHORED);
        mfs.writeFile(`${DIR}/gap-0002-broken.md`, "junk");

        // --- When ---
        const err = await caught(() => fst.submit("gap-0005"));

        // --- Then ---
        expect(isGapError(err, EC_NOT_FOUND)).toBe(true);
    });

    // go: Test_FileStore_operations_leave_invalid_file_tabular
    it.each([
        [
            "update",
            (fst: FileStore) => fst.update("gap-0001", { addHit: true }),
        ],
        ["submit", (fst: FileStore) => fst.submit("gap-0001")],
        ["discard", (fst: FileStore) => fst.discard("gap-0001")],
        [
            "fill",
            (fst: FileStore) =>
                fst.fill("gap-0001", { refs: ["epub#tokens"], complete: true }),
        ],
        ["reopen", (fst: FileStore) => fst.reopen("gap-0001", "why")],
        ["wontfix", (fst: FileStore) => fst.wontfix("gap-0001", "why")],
    ])("%s leaves an invalid file alone", async (_name, op) => {
        // --- Given ---
        const broken = "---\nid: gap-0001\nstatus: [open\n---\n# T\n";
        const { fst, mfs } = newStore();
        mfs.writeFile(`${DIR}/gap-0001-broken.md`, broken);

        // --- When ---
        const err = await caught(() => op(fst));

        // --- Then ---
        expect(isGapError(err, EC_BAD_FILE)).toBe(true);
        expect(err.message).toContain(
            "invalid gap file gap-0001-broken.md: front matter: yaml",
        );
        expect(mfs.readFile(`${DIR}/gap-0001-broken.md`)).toBe(broken);
        expect(topNames(mfs)).toEqual(["gap-0001-broken.md"]);
    });
});

/** storeWith returns a store over DIR holding gaps, checked with res. */
function storeWith(gaps: Gap[], res: Resolver | null = TEST_RESOLVER) {
    const st = newStore({}, res);
    for (const gap of gaps) writeGap(st.mfs, DIR, gap);
    return st;
}

describe("FileStore.list", () => {
    // go: Test_FileStore_List
    it("lists the stored gaps", async () => {
        // --- Given ---
        const { fst } = newStore();
        await fst.append(AUTHORED);

        // --- When ---
        const have = await fst.list({});

        // --- Then ---
        expect(have).toEqual([{ ...AUTHORED_STORED, file: AUTHORED_NAME }]);
    });

    // go: Test_FileStore_List_covers_closed_folder
    it("covers the closed folder", async () => {
        // --- Given --- three open gaps, the second filled, the third moved
        // into the closed folder by hand.
        const { fst, mfs } = withRanked();
        await fst.fill("gap-0002", { refs: ["epub"], complete: true });
        await moveToClosed(mfs, "gap-0003-gift-card-expiry.md");

        // --- When ---
        const have = await fst.list({ query: "download token" });

        // --- Then ---
        expect(have.map((g) => [g.file, g.status])).toEqual([
            ["closed/gap-0002-epub-download-token-lifetime.md", "filled"],
            ["closed/gap-0003-gift-card-expiry.md", "open"],
        ]);
        expect(await fst.badFiles()).toEqual([]);
    });

    // go: Test_FileStore_List_filters
    it("filters by status and SRD reference", async () => {
        // --- Given ---
        const { fst } = newStore();
        await fst.append(AUTHORED);
        const id = await fst.appendDraft({
            ...AUTHORED,
            srdRef: "initiatives/checkout/srd.md",
        });
        await fst.appendDraft(AUTHORED);

        // --- When ---
        const have = await fst.list({ status: "draft", srdRef: "checkout" });

        // --- Then ---
        expect(have.map((g) => g.id)).toEqual([id]);
    });

    // go: Test_FileStore_List_filters_ask_and_asked
    it("filters by ask and asked", async () => {
        // --- Given --- gap-0001 to ask Anna, sent; gap-0002 to ask Anna and
        // Bob, not sent; gap-0003 naming nobody.
        const { fst } = newStore();
        await fst.append({ ...AUTHORED, ask: ["Anna M"], asked: "2026-10-04" });
        await fst.append({ ...AUTHORED, ask: ["anna m", "Bob"] });
        await fst.append(AUTHORED);

        // --- When ---
        const have = await fst.list({
            status: "open",
            ask: "ANNA",
            asked: false,
        });

        // --- Then ---
        expect(have.map((g) => g.id)).toEqual(["gap-0002"]);
    });

    // go: Test_FileStore_List_skips_invalid_files
    it("skips invalid files", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        await fst.append(AUTHORED);
        mfs.writeFile(`${DIR}/gap-0002-broken.md`, "junk");

        // --- When ---
        const have = await fst.list({});

        // --- Then ---
        expect(have).toHaveLength(1);
    });

    // go: Test_FileStore_List_marks_stale
    it("marks stale entries by reason", async () => {
        // --- Given --- a filled gap with one current entry and one per
        // stale reason.
        const gap = {
            ...IMPORTED,
            filledBy: [
                { ref: "epub#tokens", hash: hash("epub#tokens") },
                { ref: "epub#delivery", hash: hash("epub#delivery") },
                { ref: "kb/shipping.md", hash: hash("kb/shipping.md") },
                { ref: "epub", hash: "" },
            ],
        };
        const res = new DriftedResolver({
            "epub#delivery": "edited",
            "kb/shipping.md": "",
        });
        const { fst } = storeWith([gap], res);

        // --- When ---
        const have = await fst.list({});

        // --- Then ---
        expect(have).toHaveLength(1);
        expect(have[0]?.status).toBe("filled");
        expect(have[0]?.stale).toBe(true);
        expect(have[0]?.staleRefs).toEqual([
            { ref: "epub#delivery", reason: "changed" },
            { ref: "kb/shipping.md", reason: "vanished" },
            { ref: "epub", reason: "unhashed" },
        ]);
    });

    // go: Test_FileStore_List_stale_by_status_tabular
    it.each([
        ["filled", true],
        ["open", true],
        ["draft", false],
        ["wontfix", false],
    ] as [Status, boolean][])(
        "checks staleness of a %s gap",
        async (sts, want) => {
            // --- Given --- a gap whose one entry records no hash.
            const gap = {
                ...IMPORTED,
                status: sts,
                filledBy: [{ ref: "epub", hash: "" }],
            };
            const { fst } = storeWith([gap]);

            // --- When ---
            const have = await fst.list({});

            // --- Then ---
            expect(have[0]?.stale).toBe(want);
            expect((have[0]?.staleRefs.length ?? 0) > 0).toBe(want);
        },
    );

    // go: Test_FileStore_List_filter_stale
    it("filters stale gaps", async () => {
        // --- Given --- gap-0007 current, gap-0008 changed.
        const changed = {
            ...IMPORTED,
            id: "gap-0008",
            filledBy: [{ ref: "epub", hash: hash("epub") }],
        };
        const res = new DriftedResolver({
            "docs/catalog/epub.md#tokens": "ab",
            epub: "edited",
        });
        const { fst } = storeWith([IMPORTED, changed], res);

        // --- When ---
        const have = await fst.list({ stale: true });

        // --- Then ---
        expect(have.map((g) => g.id)).toEqual(["gap-0008"]);
    });

    // go: Test_FileStore_List_nil_resolver_marks_vanished
    it("marks every entry vanished without a resolver", async () => {
        // --- Given ---
        const { fst } = storeWith([IMPORTED], null);

        // --- When ---
        const have = await fst.list({});

        // --- Then ---
        expect(have[0]?.staleRefs).toEqual([
            { ref: "docs/catalog/epub.md#tokens", reason: "vanished" },
        ]);
    });

    // go: Test_FileStore_List_error_resolver
    it("fails on a resolver failure", async () => {
        // --- Given ---
        const { fst } = storeWith([IMPORTED], new BrokenResolver());

        // --- When ---
        const err = await caught(() => fst.list({}));

        // --- Then ---
        expect(err.message).toBe("check gap-0007: disk on fire");
    });

    // go: Test_FileStore_List_error_unknown_status
    it("refuses an unknown status", async () => {
        // --- When ---
        const err = await caught(() => newStore().fst.list({ status: "kb" }));

        // --- Then ---
        expect(isGapError(err, EC_INVALID)).toBe(true);
        expect(err.message).toBe('invalid gap input: unknown status "kb"');
    });

    // go: Test_FileStore_List_query_ranks_by_relevance
    it("ranks a query by relevance", async () => {
        // --- Given ---
        const { fst } = withRanked();

        // --- When ---
        const have = await fst.list({ query: "download token" });

        // --- Then ---
        expect(have.map((g) => g.id)).toEqual(["gap-0002", "gap-0003"]);
        expect(have[0]?.topic).toBe("EPUB download token lifetime");
        expect(have[0]?.score).toBeGreaterThan(have[1]?.score as number);
        expect(have[1]?.score).toBeGreaterThan(0);
    });

    // go: Test_FileStore_List_query_with_filters
    it("filters a ranked query", async () => {
        // --- Given ---
        const { fst } = withRanked();
        await fst.wontfix("gap-0002", "out of scope");

        // --- When ---
        const have = await fst.list({
            status: "open",
            srdRef: "SRD-",
            query: "download token",
        });

        // --- Then ---
        expect(have.map((g) => g.id)).toEqual(["gap-0003"]);
    });

    // go: Test_FileStore_List_blank_query_lists_by_id
    it("lists by id for a blank query", async () => {
        // --- Given ---
        const { fst } = withRanked();

        // --- When ---
        const have = await fst.list({ query: " \t" });

        // --- Then ---
        expect(have.map((g) => g.id)).toEqual([
            "gap-0001",
            "gap-0002",
            "gap-0003",
        ]);
        expect(have[0]?.score).toBe(0);
        expect(fst.idx).toBeUndefined();
    });

    // go: Test_FileStore_List_query_sees_edit_on_disk
    it("sees an edit made on disk", async () => {
        // --- Given --- the best match's topic rewritten by hand.
        const { fst, mfs } = withRanked();
        await fst.list({ query: "download token" });
        const path = `${DIR}/gap-0002-epub-download-token-lifetime.md`;
        mfs.writeFile(
            path,
            mfs
                .readFile(path)
                .replace("# EPUB download token lifetime", "# EPUB file size"),
        );

        // --- When ---
        const have = await fst.list({ query: "download token" });

        // --- Then ---
        expect(have.map((g) => g.id)).toEqual(["gap-0003", "gap-0002"]);
        expect(have[1]?.topic).toBe("EPUB file size");
    });

    it("leaves out a hit the filters dropped", async () => {
        // --- Given ---
        const { fst } = withRanked();

        // --- When ---
        const have = await fst.list({ query: "download", srdRef: "SRD-9" });

        // --- Then ---
        expect(have.map((g) => g.id)).toEqual(["gap-0003"]);
    });

    it("stops on a canceled signal", async () => {
        // --- When ---
        const err = await caught(() =>
            newStore().fst.list({}, { aborted: true }),
        );

        // --- Then ---
        expect(err).toBeInstanceOf(CanceledError);
    });

    it("reports a stale imported entry", async () => {
        // --- Given ---
        const { fst } = newStore();
        const have = await fst.import(IMPORTED);

        // --- When ---
        const [gap] = await fst.list({});

        // --- Then ---
        expect(gap?.staleRefs).toEqual([
            { ref: "epub#tokens", reason: "changed" },
        ]);
        expect({ ...gap, stale: false, staleRefs: [] }).toEqual(have);
    });
});

describe("FileStore.badFiles", () => {
    // go: Test_FileStore_BadFiles
    it("lists the invalid files and why", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        await fst.append(AUTHORED);
        mfs.writeFile(
            `${DIR}/gap-0003-no-kind.md`,
            "---\nid: gap-0003\nstatus: open\nhits: 1\n" +
                "created: 2026-07-14T10:00:00Z\n" +
                "---\n# T\n## Demand\n## Detail\n## Target claim\n",
        );
        mfs.writeFile(`${DIR}/gap-0002-broken.md`, "junk");

        // --- When ---
        const have = await fst.badFiles();

        // --- Then ---
        expect(have).toEqual([
            { file: "gap-0002-broken.md", reason: "no front matter" },
            {
                file: "gap-0003-no-kind.md",
                reason: 'missing required key "kind"',
            },
        ]);
    });

    // go: Test_FileStore_BadFiles_invalid_asked
    it("refuses an asked date edited by hand", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        mfs.writeFile(
            `${DIR}/gap-0001-t.md`,
            "---\n" +
                "id: gap-0001\n" +
                "status: open\n" +
                "kind: wrong\n" +
                "ask: [Anna M]\n" +
                "asked: 4 Oct\n" +
                "hits: 1\n" +
                "created: 2026-07-14T10:00:00Z\n" +
                "---\n" +
                "# T\n## Demand\n## Detail\n## Target claim\n",
        );

        // --- When ---
        const have = await fst.badFiles();

        // --- Then ---
        expect(have).toEqual([
            {
                file: "gap-0001-t.md",
                reason: 'key "asked": want a YYYY-MM-DD date, have "4 Oct"',
            },
        ]);
        expect(await fst.list({})).toEqual([]);
    });

    // go: Test_FileStore_BadFiles_none
    it("lists none", async () => {
        // --- Given ---
        const { fst } = newStore();
        await fst.append(AUTHORED);

        // --- When ---
        const have = await fst.badFiles();

        // --- Then ---
        expect(have).toEqual([]);
    });

    // go: Test_FileStore_BadFiles_fixed_file_is_valid_again
    it("takes a fixed file as valid again", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        await fst.append(AUTHORED);
        mfs.writeFile(`${DIR}/${AUTHORED_NAME}`, "junk");
        await fst.badFiles();
        mfs.writeFile(`${DIR}/${AUTHORED_NAME}`, AUTHORED_FILE);

        // --- When ---
        const have = await fst.badFiles();

        // --- Then ---
        expect(have).toEqual([]);
        expect(await fst.list({})).toHaveLength(1);
    });

    // go: Test_FileStore_BadFiles_error_canceled_context
    it("stops on a canceled signal", async () => {
        // --- When ---
        const err = await caught(() =>
            newStore().fst.badFiles({ aborted: true }),
        );

        // --- Then ---
        expect(err).toBeInstanceOf(CanceledError);
    });

    // go: Test_FileStore_BadFiles_error_missing_folder
    it("fails on a missing folder", async () => {
        // --- When ---
        const err = await caught(() => absentStore().badFiles());

        // --- Then ---
        expect(err.message).toContain("read gap folder");
    });
});

describe("FileStore.tidy", () => {
    // go: Test_FileStore_Tidy
    it("moves misplaced valid files", async () => {
        // --- Given --- an open gap in the closed folder, a filled gap at
        // the top, and an invalid file in each folder.
        const { fst, mfs } = newStore();
        await fst.append(AUTHORED);
        await moveToClosed(mfs, AUTHORED_NAME);
        writeGap(mfs, DIR, IMPORTED);
        mfs.writeFile(`${DIR}/gap-0008-x.md`, "junk");
        mfs.writeFile(`${CLOSED}/gap-0009-y.md`, "junk");
        await fst.reindex();

        // --- When ---
        const have = await fst.tidy();

        // --- Then ---
        expect(have).toEqual([
            { from: `closed/${AUTHORED_NAME}`, to: AUTHORED_NAME },
            { from: IMPORTED_NAME, to: `closed/${IMPORTED_NAME}` },
        ]);
        expect(topNames(mfs)).toEqual([
            "closed",
            AUTHORED_NAME,
            "gap-0008-x.md",
        ]);
        expect(closedNames(mfs)).toEqual([IMPORTED_NAME, "gap-0009-y.md"]);
        expect(fst.idx?.state).toBe(await fst.state());
    });

    // go: Test_FileStore_Tidy_nothing_to_move
    it("moves nothing", async () => {
        // --- Given ---
        const { fst, mfs } = newStore();
        await fst.append(AUTHORED);

        // --- When ---
        const have = await fst.tidy();

        // --- Then ---
        expect(have).toEqual([]);
        expect(topNames(mfs)).toEqual([AUTHORED_NAME]);
    });

    // go: Test_FileStore_Tidy_error_returns_moves_made
    it("reports the moves made before a failure", async () => {
        // --- Given --- an open gap in the closed folder, then a filled gap
        // at the top whose name a directory in the closed folder takes.
        const { fst, mfs } = newStore();
        await fst.append(AUTHORED);
        await moveToClosed(mfs, AUTHORED_NAME);
        writeGap(mfs, DIR, IMPORTED);
        mfs.mkdirp(`${CLOSED}/${IMPORTED_NAME}`);

        // --- When ---
        const err = await caught(() => fst.tidy());

        // --- Then ---
        expect(err).toBeInstanceOf(TidyError);
        expect(err.message).toContain(`closed/${IMPORTED_NAME} exists`);
        expect((err as TidyError).moves).toEqual([
            { from: `closed/${AUTHORED_NAME}`, to: AUTHORED_NAME },
        ]);
    });

    // go: Test_FileStore_Tidy_error_canceled_context
    it("stops on a canceled signal", async () => {
        // --- When ---
        const err = await caught(() => newStore().fst.tidy({ aborted: true }));

        // --- Then ---
        expect(err).toBeInstanceOf(CanceledError);
    });

    // go: Test_FileStore_Tidy_error_missing_folder
    it("fails on a missing folder", async () => {
        // --- When ---
        const err = await caught(() => absentStore().tidy());

        // --- Then ---
        expect(err.message).toContain("read gap folder");
    });
});

describe("FileStore staleness after a fill", () => {
    // Completes Test_FileStore_Fill_partial and
    // Test_FileStore_Fill_refreshes_filled_gap, which check List's verdict.
    it("leaves a partly filled gap current", async () => {
        // --- Given ---
        const { fst } = newStore();
        const id = await fst.append(AUTHORED);

        // --- When ---
        await fst.fill(id, { refs: ["epub#delivery"], complete: false });

        // --- Then ---
        const [gap] = await fst.list({});
        expect(gap?.stale).toBe(false);
    });

    it("refreshes a filled gap to current", async () => {
        // --- Given ---
        const { fst } = newStore();
        await fst.import(IMPORTED);

        // --- When ---
        await fst.fill(IMPORTED.id, { refs: ["epub#tokens"], complete: true });

        // --- Then ---
        const [gap] = await fst.list({});
        expect(gap?.stale).toBe(false);
        expect(gap?.staleRefs).toEqual([]);
    });
});
