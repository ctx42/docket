// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
    fields,
    trimLeft,
    trimRight,
    trimSpace,
} from "../../src/gocompat/strings.ts";

describe("Go strings helpers", () => {
    it("split and trim on Go whitespace only", () => {
        expect(fields(" a\tb\u0085c　 ")).toEqual(["a", "b", "c"]);
        expect(fields("a﻿b")).toEqual(["a﻿b"]);
        expect(fields("")).toEqual([]);
        expect(trimSpace("\u0085 x  ")).toBe("x");
        expect(trimSpace("﻿x")).toBe("﻿x");
    });

    it("trim by cutset", () => {
        expect(trimRight("a).,]>", ").,]>")).toBe("a");
        expect(trimRight("))", ")")).toBe("");
        expect(trimLeft("###x#", "#")).toBe("x#");
        expect(trimLeft("##", "#")).toBe("");
    });
});
