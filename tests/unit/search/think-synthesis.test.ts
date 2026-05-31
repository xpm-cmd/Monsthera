import { describe, it, expect } from "vitest";
import {
  buildThinkPrompt,
  mapAndPruneCitations,
  deriveDeterministicGaps,
  mapLlmGaps,
} from "../../../src/search/think-synthesis.js";
import type { ContextPackItem } from "../../../src/search/service.js";

// Loose fixture — the helpers only touch id/title/type/snippet/phase/staleCodeRefs/diagnostics.
function mkItem(id: string, over: Record<string, unknown> = {}): ContextPackItem {
  return {
    id,
    title: `Title ${id}`,
    type: "knowledge",
    score: 1,
    searchScore: 1,
    reason: "",
    snippet: `snippet ${id}`,
    updatedAt: "2026-01-01T00:00:00.000Z",
    codeRefs: [],
    staleCodeRefs: [],
    diagnostics: {
      freshness: { state: "fresh", label: "fresh", detail: "", ageDays: 1 },
      quality: { score: 80, label: "strong", summary: "" },
    },
    ...over,
  } as unknown as ContextPackItem;
}

describe("mapAndPruneCitations", () => {
  it("maps valid [n] markers to article ids and keeps them in the prose", () => {
    const items = [mkItem("k-1"), mkItem("k-2")];
    const { answer, citations, citedIds } = mapAndPruneCitations("Foo [1] and bar [2].", items);
    expect(answer).toBe("Foo [1] and bar [2].");
    expect(citations.map((c) => c.articleId)).toEqual(["k-1", "k-2"]);
    expect([...citedIds].sort()).toEqual(["k-1", "k-2"]);
  });

  it("strips out-of-range markers — the trust mechanism", () => {
    const items = [mkItem("k-1")];
    const { answer, citations } = mapAndPruneCitations("Real [1] but invented [9].", items);
    expect(answer).toBe("Real [1] but invented .");
    expect(citations.map((c) => c.articleId)).toEqual(["k-1"]);
  });

  it("dedups repeated markers into one citation", () => {
    const items = [mkItem("k-1")];
    const { citations } = mapAndPruneCitations("A [1] and again [1].", items);
    expect(citations).toHaveLength(1);
  });
});

describe("deriveDeterministicGaps", () => {
  it("flags stale sources and uncited sources", () => {
    const items = [
      mkItem("k-1", {
        diagnostics: {
          freshness: { state: "stale", label: "stale", detail: "", ageDays: 90 },
          quality: { score: 80, label: "strong", summary: "" },
        },
      }),
      mkItem("k-2"),
    ];
    const gaps = deriveDeterministicGaps(items, new Set(["k-2"]));
    expect(gaps.some((g) => g.kind === "stale" && g.articleIds.includes("k-1"))).toBe(true);
    expect(gaps.some((g) => g.kind === "uncited" && g.articleIds.includes("k-1"))).toBe(true);
  });

  it("emits no uncited gap when nothing was cited (degraded run)", () => {
    const gaps = deriveDeterministicGaps([mkItem("k-1")], new Set());
    expect(gaps.some((g) => g.kind === "uncited")).toBe(false);
  });

  it("flags sources with stale code refs", () => {
    const gaps = deriveDeterministicGaps([mkItem("k-1", { staleCodeRefs: ["src/gone.ts"] })], new Set(["k-1"]));
    expect(gaps.some((g) => g.kind === "stale" && g.detail.includes("code"))).toBe(true);
  });
});

describe("mapLlmGaps", () => {
  it("keeps only missing/contradictory and maps sourceMarkers to ids", () => {
    const items = [mkItem("k-1"), mkItem("k-2")];
    const gaps = mapLlmGaps(
      [
        { kind: "missing", detail: "no source on X", sourceMarkers: [] },
        { kind: "contradictory", detail: "1 vs 2", sourceMarkers: ["[1]", "[2]"] },
        { kind: "stale", detail: "should be ignored", sourceMarkers: ["[1]"] },
        { kind: "uncited", detail: "should be ignored", sourceMarkers: ["[2]"] },
      ],
      items,
    );
    expect(gaps.map((g) => g.kind)).toEqual(["missing", "contradictory"]);
    expect(gaps[1]!.articleIds).toEqual(["k-1", "k-2"]);
  });
});

describe("buildThinkPrompt", () => {
  it("numbers sources and includes the query + grounding rules", () => {
    const prompt = buildThinkPrompt("how does auth work", [mkItem("k-1", { title: "Auth" })], ["Full body of auth"]);
    expect(prompt).toContain('[1] (knowledge) "Auth"');
    expect(prompt).toContain("Full body of auth");
    expect(prompt).toContain("QUERY: how does auth work");
    expect(prompt).toContain("Invented markers are pruned");
  });
});
