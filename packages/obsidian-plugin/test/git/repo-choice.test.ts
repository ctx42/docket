// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { settleChoice } from "../../src/git/repo-choice.ts";

describe("settleChoice", () => {
    it("names the first knowledge base until one is picked", () => {
        const have = settleChoice(
            { repo: "vault", kb: null },
            ["kb", "kb-team"],
            "vault",
        );

        expect(have).toEqual({ repo: "vault", kb: "kb" });
    });

    it("keeps the picked knowledge base while Vault is shown", () => {
        const have = settleChoice(
            { repo: "sync", kb: "kb-team" },
            ["kb", "kb-team"],
            "vault",
        );

        expect(have).toEqual({ repo: "sync", kb: "kb-team" });
    });

    it("shows a picked knowledge base that still exists", () => {
        const have = settleChoice(
            { repo: "kb:kb-team", kb: "kb-team" },
            ["kb", "kb-team"],
            "vault",
        );

        expect(have).toEqual({ repo: "kb:kb-team", kb: "kb-team" });
    });

    it("falls back to Vault and the first base when the shown one is gone", () => {
        const have = settleChoice(
            { repo: "kb:old", kb: "old" },
            ["kb"],
            "vault",
        );

        expect(have).toEqual({ repo: "vault", kb: "kb" });
    });

    it("has no knowledge base without any", () => {
        const have = settleChoice({ repo: "kb:kb", kb: "kb" }, [], "vault");

        expect(have).toEqual({ repo: "vault", kb: null });
    });

    it("falls back to the caller's own default", () => {
        const have = settleChoice({ repo: "kb:old", kb: "old" }, [], "note");

        expect(have).toEqual({ repo: "note", kb: null });
    });
});
