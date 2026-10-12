// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The plugin's HttpClient adapter over Obsidian's `requestUrl`, which issues
// requests from the desktop app and so sidesteps the CORS restrictions a
// browser `fetch` to Atlassian would hit. `requestUrl` is injected as a
// function (not imported as a value here) so this module carries no Obsidian
// runtime dependency and unit-tests with a fake. General retry/backoff and
// concurrency are a later concern of a wrapped client.
//
// Chromium aborts every in-flight request with `net::ERR_NETWORK_CHANGED`
// whenever an interface comes or goes — on a Linux host running containers that
// is every container start or stop, as each adds a `veth` device. The request
// is retried a few times with a short backoff, except a POST: Chromium may abort
// it after Confluence applied it, so a retry could create a duplicate page,
// comment, or attachment.
//
// `requestUrl` otherwise sends Electron's browser User-Agent, and Atlassian's
// XSRF guard rejects a browser-agent multipart POST (attachment upload) with
// 403 "XSRF check failed" even when it carries `X-Atlassian-Token: no-check`.
// A non-browser agent passes, as the CLI's does.

import type { HttpClient, HttpRequest, HttpResponse } from "@docket/core";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";

/** USER_AGENT is the agent sent when the request does not name its own. */
const USER_AGENT = "docket";

/** NETWORK_CHANGED is the Chromium error a network-change abort carries. */
const NETWORK_CHANGED = "ERR_NETWORK_CHANGED";

/** RETRY_DELAYS_MS are the waits before each retry of an aborted request. */
const RETRY_DELAYS_MS = [250, 1000];

/** RequestUrlFn is Obsidian's `requestUrl`, narrowed to what this adapter uses. */
export type RequestUrlFn = (
    param: RequestUrlParam,
) => Promise<RequestUrlResponse>;

/** SleepFn waits `ms` milliseconds. */
export type SleepFn = (ms: number) => Promise<void>;

/**
 * RequestUrlHttpClient implements the core's {@link HttpClient} port over an
 * injected `requestUrl`. It forwards method, url, headers, and body, forces
 * `throw: false` so a non-2xx status returns a response the core can inspect
 * (matching the CLI's fetch adapter), sends a non-browser `User-Agent` unless
 * the request sets one, retries a non-POST request Chromium aborted on a
 * network change, and normalises the reply into an {@link HttpResponse} with
 * lower-cased header keys and a `Uint8Array` body. `sleep` is injectable so
 * tests skip the backoff.
 */
export class RequestUrlHttpClient implements HttpClient {
    constructor(
        private readonly request: RequestUrlFn,
        private readonly sleep: SleepFn = defaultSleep,
    ) {}

    async do(req: HttpRequest): Promise<HttpResponse> {
        const bodyVal = toBody(req.body);
        const param: RequestUrlParam = {
            url: req.url,
            method: req.method,
            headers: withUserAgent(req.headers),
            ...(bodyVal !== undefined && { body: bodyVal }),
            throw: false,
        };
        const resp = await this.send(param);
        return {
            status: resp.status,
            headers: lowerCaseKeys(resp.headers),
            body: new Uint8Array(resp.arrayBuffer),
        };
    }

    /**
     * send issues param, retrying after each of {@link RETRY_DELAYS_MS} while
     * Chromium aborts it on a network change. A POST is sent once.
     */
    private async send(param: RequestUrlParam): Promise<RequestUrlResponse> {
        const post = param.method?.toUpperCase() === "POST";
        const delays = post ? [] : RETRY_DELAYS_MS;
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.request(param);
            } catch (err) {
                const wait = delays[attempt];
                if (wait === undefined || !isNetworkChanged(err)) {
                    throw err;
                }
                await this.sleep(wait);
            }
        }
    }
}

/** defaultSleep waits `ms` milliseconds on a timer. */
function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** isNetworkChanged reports whether err is Chromium's network-change abort. */
function isNetworkChanged(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes(NETWORK_CHANGED);
}

/**
 * withUserAgent returns headers with {@link USER_AGENT} added, unless they
 * already carry a `User-Agent` (in any case).
 */
function withUserAgent(
    headers: Record<string, string> | undefined,
): Record<string, string> {
    const out = { ...headers };
    if (!Object.keys(out).some((k) => k.toLowerCase() === "user-agent")) {
        out["User-Agent"] = USER_AGENT;
    }
    return out;
}

/** toBody adapts the port's `Uint8Array | string` body to `requestUrl`'s type. */
function toBody(
    body: Uint8Array | string | undefined,
): string | ArrayBuffer | undefined {
    if (body === undefined || typeof body === "string") {
        return body;
    }
    return body.buffer.slice(
        body.byteOffset,
        body.byteOffset + body.byteLength,
    ) as ArrayBuffer;
}

/** lowerCaseKeys returns headers with every key lower-cased. */
function lowerCaseKeys(
    headers: Record<string, string>,
): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        out[key.toLowerCase()] = value;
    }
    return out;
}
