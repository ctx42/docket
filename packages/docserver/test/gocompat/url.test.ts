// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { goURLPort, parseGoURL } from "../../src/gocompat/url.ts";

describe("parseGoURL", () => {
    it.each([
        ["http://localhost:7777/mcp", "http", "localhost:7777", "7777"],
        ["HTTP://h/", "http", "h", ""],
        ["http://u:p@h:7777/x?q#f", "http", "h:7777", "7777"],
        ["http://[::1]:7777/mcp", "http", "[::1]:7777", "7777"],
        ["http://[::1]/mcp", "http", "[::1]", ""],
        ["http://h:/x", "http", "h:", ""],
        ["localhost:7777/mcp", "localhost", "", ""],
        ["//h:1/x", "", "h:1", "1"],
        ["/path", "", "", ""],
    ])("parses %j", (raw, scheme, host, port) => {
        const have = parseGoURL(raw);

        expect(have).toEqual({ scheme, host });
        expect(goURLPort(have)).toBe(port);
    });

    it.each([
        [":7777", 'parse ":7777": missing protocol scheme'],
        ["http://[::1", "parse \"http://[::1\": missing ']' in host"],
        [
            "http://h:abc/x",
            'parse "http://h:abc/x": invalid port ":abc" after host',
        ],
        [
            "http://[::1]x/",
            'parse "http://[::1]x/": invalid port "x" after host',
        ],
        [
            "http://h :1",
            'parse "http://h :1": invalid character " " in host name',
        ],
        ["http://h/%zz", 'parse "http://h/%zz": invalid URL escape "%zz"'],
        ["http://h/#%z", 'parse "http://h/#%z": invalid URL escape "%z"'],
        [
            "1a:b/c",
            'parse "1a:b/c": first path segment in URL cannot contain colon',
        ],
        [
            "http://h\u0001/",
            'parse "http://h\\x01/": net/url: invalid control character in URL',
        ],
    ])("refuses %j like Go", (raw, want) => {
        expect(() => parseGoURL(raw)).toThrow(want);
    });
});
