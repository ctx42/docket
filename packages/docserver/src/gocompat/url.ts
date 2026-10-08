// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// The part of Go `net/url` the .mcp.json port check uses: `url.Parse` as far
// as scheme, host and port go, with Go's error texts
// (`parse "http://[::1": missing ']' in host`), and `URL.Port()`.

import { goQuote } from "./strconv.ts";

/** GoURL is the part of a parsed Go `*url.URL` the port check reads. */
export interface GoURL {
    /** scheme is lowercased; "" when the URL has none. */
    scheme: string;
    /** host is "host[:port]", "" for an opaque or relative URL. */
    host: string;
}

/** GoURLError is Go's `*url.Error` for a failed parse. */
export class GoURLError extends Error {
    constructor(url: string, cause: string) {
        super(`parse ${goQuote(url)}: ${cause}`);
        this.name = "GoURLError";
    }
}

/** parseGoURL parses raw as Go's `url.Parse` does, keeping scheme and host. */
export function parseGoURL(raw: string): GoURL {
    const fail = (cause: string) => new GoURLError(raw, cause);
    const hash = raw.indexOf("#");
    let rest = hash < 0 ? raw : raw.slice(0, hash);
    if (hasControl(rest))
        throw fail("net/url: invalid control character in URL");
    if (hash >= 0) checkEscapes(raw.slice(hash + 1), fail);

    // getScheme
    let scheme = "";
    for (let i = 0; i < rest.length; i++) {
        const c = rest[i] as string;
        if (/[A-Za-z]/.test(c)) continue;
        if (/[0-9+.-]/.test(c)) {
            if (i === 0) break;
            continue;
        }
        if (c === ":") {
            if (i === 0) throw fail("missing protocol scheme");
            scheme = rest.slice(0, i).toLowerCase();
            rest = rest.slice(i + 1);
        }
        break;
    }
    const q = rest.indexOf("?");
    if (q >= 0) rest = rest.slice(0, q);
    if (!rest.startsWith("/")) {
        if (scheme !== "") return { scheme, host: "" };
        const colon = rest.indexOf(":");
        const slash = rest.indexOf("/");
        if (colon >= 0 && (slash < 0 || colon < slash)) {
            throw fail("first path segment in URL cannot contain colon");
        }
    }
    let host = "";
    if (rest.startsWith("//") && !(scheme === "" && rest.startsWith("///"))) {
        const auth = rest.slice(2);
        const end = auth.indexOf("/");
        const authority = end < 0 ? auth : auth.slice(0, end);
        rest = end < 0 ? "" : auth.slice(end);
        host = parseHost(authority.slice(authority.lastIndexOf("@") + 1), fail);
    }
    checkEscapes(rest, fail);
    return { scheme, host };
}

/**
 * goURLPort returns the port of u as Go's `URL.Port()` (splitHostPort)
 * does: the digits after the host's last colon, or "".
 */
export function goURLPort(u: GoURL): string {
    const colon = u.host.lastIndexOf(":");
    if (colon < 0) return "";
    const port = u.host.slice(colon);
    return validOptionalPort(port) ? port.slice(1) : "";
}

/** parseHost validates a URL host as Go's parseHost and unescape do. */
function parseHost(host: string, fail: (cause: string) => GoURLError): string {
    let colonPort = "";
    if (host.startsWith("[")) {
        const end = host.lastIndexOf("]");
        if (end < 0) throw fail("missing ']' in host");
        colonPort = host.slice(end + 1);
    } else {
        const colon = host.lastIndexOf(":");
        if (colon >= 0) colonPort = host.slice(colon);
    }
    if (!validOptionalPort(colonPort)) {
        throw fail(`invalid port ${goQuote(colonPort)} after host`);
    }
    for (const ch of host) {
        const c = ch.codePointAt(0) as number;
        if (c < 0x80 && ch !== "%" && !HOST_OK.test(ch)) {
            throw fail(`invalid character ${goQuote(ch)} in host name`);
        }
    }
    checkEscapes(host, fail);
    return host;
}

/** HOST_OK matches the ASCII characters Go allows unescaped in a host. */
const HOST_OK = /[A-Za-z0-9\-_.~!$&'()*+,;=:[\]<>"]/;

/** validOptionalPort is Go's: "" or ":" followed by digits only. */
function validOptionalPort(port: string): boolean {
    return port === "" || /^:[0-9]*$/.test(port);
}

/** checkEscapes reports a malformed %-escape as Go's unescape does. */
function checkEscapes(s: string, fail: (cause: string) => GoURLError): void {
    for (let i = 0; i < s.length; i++) {
        if (s[i] !== "%") continue;
        const esc = s.slice(i, i + 3);
        if (!/^%[0-9A-Fa-f]{2}$/.test(esc)) {
            throw fail(`invalid URL escape ${goQuote(esc)}`);
        }
        i += 2;
    }
}

/** hasControl reports an ASCII control character (Go's stringContainsCTLByte). */
function hasControl(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x20 || c === 0x7f) return true;
    }
    return false;
}
