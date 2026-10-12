// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import { describe, expect, it } from "vitest";

import {
    type RequestUrlFn,
    RequestUrlHttpClient,
    type SleepFn,
} from "../../src/adapters/http.ts";

function response(
    overrides: Partial<RequestUrlResponse> = {},
): RequestUrlResponse {
    return {
        status: 200,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: null,
        text: "",
        ...overrides,
    };
}

/** flaky returns a fake that throws each of errs in turn, then succeeds. */
function flaky(errs: unknown[]): { fake: RequestUrlFn; calls: () => number } {
    let n = 0;
    const fake: RequestUrlFn = async () => {
        const err = errs[n++];
        if (err !== undefined) {
            throw err;
        }
        return response();
    };
    return { fake, calls: () => n };
}

/** recordSleep returns a no-wait sleep and the delays it was asked for. */
function recordSleep(): { sleep: SleepFn; waits: number[] } {
    const waits: number[] = [];
    const sleep: SleepFn = async (ms) => {
        waits.push(ms);
    };
    return { sleep, waits };
}

/** changed is the error Obsidian's `requestUrl` throws on a network change. */
const changed = new Error("net::ERR_NETWORK_CHANGED");

describe("RequestUrlHttpClient", () => {
    it("passes method, headers, and forces throw:false", async () => {
        let captured: RequestUrlParam | undefined;
        const fake: RequestUrlFn = async (p) => {
            captured = p;
            return response();
        };
        await new RequestUrlHttpClient(fake).do({
            method: "GET",
            url: "https://ex/a",
            headers: { Authorization: "Basic z" },
        });
        expect(captured?.method).toBe("GET");
        expect(captured?.url).toBe("https://ex/a");
        expect(captured?.headers).toEqual({
            Authorization: "Basic z",
            "User-Agent": "docket",
        });
        expect(captured?.throw).toBe(false);
    });

    it("sends a non-browser User-Agent unless the request sets one", async () => {
        const sent: (Record<string, string> | undefined)[] = [];
        const fake: RequestUrlFn = async (p) => {
            sent.push(p.headers);
            return response();
        };
        const client = new RequestUrlHttpClient(fake);

        await client.do({ method: "POST", url: "u" });
        await client.do({
            method: "POST",
            url: "u",
            headers: { "user-agent": "custom" },
        });

        expect(sent[0]).toEqual({ "User-Agent": "docket" });
        expect(sent[1]).toEqual({ "user-agent": "custom" });
    });

    it("lower-cases response header keys and decodes the body", async () => {
        const bytes = new TextEncoder().encode("hi");
        const fake: RequestUrlFn = async () =>
            response({
                status: 201,
                headers: { "Content-Type": "application/json" },
                arrayBuffer: bytes.buffer as ArrayBuffer,
            });
        const resp = await new RequestUrlHttpClient(fake).do({
            method: "GET",
            url: "https://ex",
        });
        expect(resp.status).toBe(201);
        expect(resp.headers["content-type"]).toBe("application/json");
        expect(new TextDecoder().decode(resp.body)).toBe("hi");
    });

    it("returns a non-2xx response instead of throwing", async () => {
        const fake: RequestUrlFn = async () => response({ status: 401 });
        const resp = await new RequestUrlHttpClient(fake).do({
            method: "GET",
            url: "https://ex",
        });
        expect(resp.status).toBe(401);
    });

    it("sends only a body's own bytes, as text or binary", async () => {
        const bodies: unknown[] = [];
        const fake: RequestUrlFn = async (p) => {
            bodies.push(p.body);
            return response();
        };
        const client = new RequestUrlHttpClient(fake);
        const backing = new TextEncoder().encode("xxABCxx");

        await client.do({ method: "POST", url: "u", body: "text" });
        await client.do({
            method: "POST",
            url: "u",
            body: backing.subarray(2, 5),
        });

        expect(bodies[0]).toBe("text");
        expect(new TextDecoder().decode(bodies[1] as ArrayBuffer)).toBe("ABC");
    });

    it("retries a non-POST request aborted by a network change", async () => {
        const { fake, calls } = flaky([changed, changed]);
        const { sleep, waits } = recordSleep();

        const have = await new RequestUrlHttpClient(fake, sleep).do({
            method: "PUT",
            url: "u",
            body: "b",
        });

        expect(have.status).toBe(200);
        expect(calls()).toBe(3);
        expect(waits).toEqual([250, 1000]);
    });

    it("gives up after the last retry and rethrows the abort", async () => {
        const { fake, calls } = flaky([changed, changed, changed]);
        const { sleep } = recordSleep();

        const have = new RequestUrlHttpClient(fake, sleep).do({
            method: "GET",
            url: "u",
        });

        await expect(have).rejects.toBe(changed);
        expect(calls()).toBe(3);
    });

    it("never retries a POST", async () => {
        const { fake, calls } = flaky([changed]);
        const { sleep, waits } = recordSleep();

        const have = new RequestUrlHttpClient(fake, sleep).do({
            method: "post",
            url: "u",
        });

        await expect(have).rejects.toBe(changed);
        expect(calls()).toBe(1);
        expect(waits).toEqual([]);
    });

    it("does not retry any other error", async () => {
        const want = new Error("net::ERR_NAME_NOT_RESOLVED");
        const { fake, calls } = flaky([want]);
        const { sleep } = recordSleep();

        const have = new RequestUrlHttpClient(fake, sleep).do({
            method: "GET",
            url: "u",
        });

        await expect(have).rejects.toBe(want);
        expect(calls()).toBe(1);
    });

    it("recognises a non-Error network-change rejection", async () => {
        const { fake, calls } = flaky(["net::ERR_NETWORK_CHANGED"]);
        const { sleep } = recordSleep();

        const have = await new RequestUrlHttpClient(fake, sleep).do({
            method: "DELETE",
            url: "u",
        });

        expect(have.status).toBe(200);
        expect(calls()).toBe(2);
    });
});
