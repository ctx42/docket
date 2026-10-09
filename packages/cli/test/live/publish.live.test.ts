// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Proves publish against the Site: a title-only file two new directories deep
// pushes as two folders plus a page, the test restricts all three to the
// author, and `docket publish` lifts those restrictions (reading them through the v1
// restriction endpoint with expand), leaving the pre-existing scratch folder
// untouched. Everything created lives under a scratch folder deleted
// (deepest-first) on completion.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveName, deSlugTitle } from "@docket/core";
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";
import {
    liveConfigured,
    makeRun,
    requireEnv,
    seedClient,
} from "./support/live-env.ts";
import { putAuthorRestriction, uniqueTitle } from "./support/probe.ts";

describe.skipIf(!liveConfigured())("live publish", () => {
    const env = requireEnv();
    const client = seedClient(env);
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "docket-live-"));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it("lifts the author restriction from a page and its folders", async () => {
        const run = makeRun(env, dir);
        const ref = await client.resolveSpace(env.space);
        const accountId = await client.currentAccountID();

        const rootId = await client.createFolder(
            ref.id,
            ref.homepageId,
            uniqueTitle("publish-root"),
        );
        onTestFinished(async () => {
            await client.deleteFolder(rootId).catch(() => {});
        });
        const seedId = (
            await client.createPage({
                spaceId: ref.id,
                title: uniqueTitle("publish-seed"),
                parentId: rootId,
                docJSON:
                    '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"publish seed"}]}]}',
            })
        ).id;
        onTestFinished(async () => {
            await client.deletePage(seedId).catch(() => {});
        });

        const cfgPath = join(dir, ".docket.yaml");
        await writeFile(
            cfgPath,
            `folders:\n  .: /wiki/spaces/${env.space}/folder/${rootId}\n`,
        );
        expect((await run(["pull", "--config", cfgPath])).code).toBe(0);

        const runTag = Date.now().toString(36);
        const outerDir = `pub_outer_${runTag}`;
        const innerDir = `pub_inner_${runTag}`;
        const leafTitle = uniqueTitle("publish-leaf");
        const leafRel = join(outerDir, innerDir, `${deriveName(leafTitle)}.md`);
        const leafDest = join(dir, leafRel);
        await mkdir(join(dir, outerDir, innerDir), { recursive: true });
        await writeFile(
            leafDest,
            `---\ntitle: ${leafTitle}\n---\n\npublish leaf body\n`,
        );

        const push = await run(["push", "--yes", "--config", cfgPath]);
        expect(push.code, `${push.err}${push.out}`).toBe(0);

        const outerId = await client.childFolderTitled(
            rootId,
            deSlugTitle(outerDir),
        );
        expect(outerId).not.toBe("");
        onTestFinished(async () => {
            await client.deleteFolder(outerId).catch(() => {});
        });
        const innerId = await client.childFolderTitled(
            outerId,
            deSlugTitle(innerDir),
        );
        expect(innerId).not.toBe("");
        onTestFinished(async () => {
            await client.deleteFolder(innerId).catch(() => {});
        });
        const leafMd = await readFile(leafDest, "utf8");
        const pageId = /^docket_page_id:\s*"?(\d+)"?/m.exec(leafMd)?.[1] ?? "";
        expect(pageId).not.toBe("");
        onTestFinished(async () => {
            await client.deletePage(pageId).catch(() => {});
        });

        for (const id of [outerId, innerId, pageId]) {
            expect(await client.fetchRestrictions(id), `content ${id}`).toEqual(
                [],
            );
            const put = await putAuthorRestriction(env, id, accountId);
            expect(put.status, put.body).toBe(200);
            const rs = await client.fetchRestrictions(id);
            expect(rs.length, `content ${id} restricted`).toBeGreaterThan(0);
            for (const r of rs) {
                expect(r.users).toEqual([accountId]);
                expect(r.groups).toEqual([]);
            }
        }

        const pub = await run([
            "publish",
            "--yes",
            "--config",
            cfgPath,
            leafRel,
        ]);
        expect(pub.code, `${pub.err}${pub.out}`).toBe(0);

        for (const id of [outerId, innerId, pageId]) {
            expect(await client.fetchRestrictions(id), `content ${id}`).toEqual(
                [],
            );
        }
        expect(await client.fetchRestrictions(rootId)).toEqual([]);

        const again = await run(["publish", "--config", cfgPath, leafRel]);
        expect(again.code).toBe(0);
        expect(again.out).toContain("is already published");
    });
});
