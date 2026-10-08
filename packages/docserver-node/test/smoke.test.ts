// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { PACKAGE_NAME as DOCSERVER } from "@docket/docserver";
import { describe, expect, it } from "vitest";

import { PACKAGE_NAME } from "../src/index.ts";

describe("docserver-node skeleton", () => {
    it("exposes its package name", () => {
        expect(PACKAGE_NAME).toBe("@docket/docserver-node");
    });

    it("resolves its docserver dependency", () => {
        expect(DOCSERVER).toBe("@docket/docserver");
    });
});
