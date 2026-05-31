import { describe, it, expect } from "vitest";
import { scoreContextPackItem } from "../../../src/search/service.js";

// ─── Characterization: scoreContextPackItem (PR-7) ──────────────────────────
//
// These tests PIN the current context-pack ranking formula
// (`scoreContextPackItem` in src/search/service.ts). They are deliberately
// brittle: any change to a default weight, freshness delta, or mode bonus
// must update these expectations on purpose. PR-10 (config-driven knobs) and
// PR-11 (reranker) will touch this surface — when they do, a broken fixture is
// the intended signal, not a surprise.
//
// Formula captured here (defaults, no config):
//   total  = baseScore
//          + qualityScore / 40
//          + freshness  { fresh:+0.5, attention:+0.2, unknown:+0.1, stale:-0.25 }
//   code mode adds:
//          + min(1.2, codeRefCount * 0.35)
//          + 0.4  if knowledge && category∈{architecture,engineering,solution,runbook}
//          + 0.35 if work      && template∈{feature,bugfix,refactor}
//          + 0.2  if phase∈{implementation,review}
//   research mode adds:
//          + min(0.8, referenceCount * 0.2)
//          + 0.5  if sourcePath
//          + 0.4  if knowledge && category∈{guide,context,solution,runbook,research}
//          + 0.8  if template === "spike"
//          + 0.2  if phase∈{planning,enrichment}
//   result = Number(total.toFixed(3))
//
// Mode-specific bonuses apply ONLY in their mode; general mode ignores them.

type ScoreInput = Parameters<typeof scoreContextPackItem>[0];

interface Case {
  readonly name: string;
  readonly input: ScoreInput;
  readonly expected: number;
}

const cases: readonly Case[] = [
  // ── general mode: base + quality/40 + freshness only ──
  {
    name: "general · knowledge · fresh · high quality",
    input: { baseScore: 1, qualityScore: 80, freshness: "fresh", mode: "general", type: "knowledge", codeRefCount: 0, referenceCount: 0 },
    expected: 3.5, // 1 + 2.0 + 0.5
  },
  {
    name: "general · knowledge · stale (negative freshness)",
    input: { baseScore: 1, qualityScore: 40, freshness: "stale", mode: "general", type: "knowledge", codeRefCount: 0, referenceCount: 0 },
    expected: 1.75, // 1 + 1.0 - 0.25
  },
  {
    name: "general · work · unknown freshness · zero quality",
    input: { baseScore: 0.5, qualityScore: 0, freshness: "unknown", mode: "general", type: "work", codeRefCount: 0, referenceCount: 0 },
    expected: 0.6, // 0.5 + 0 + 0.1
  },
  {
    name: "general · attention freshness",
    input: { baseScore: 2, qualityScore: 20, freshness: "attention", mode: "general", type: "knowledge", codeRefCount: 0, referenceCount: 0 },
    expected: 2.7, // 2 + 0.5 + 0.2
  },

  // ── code mode ──
  {
    name: "code · knowledge · architecture · 2 code refs",
    input: { baseScore: 1, qualityScore: 40, freshness: "fresh", mode: "code", type: "knowledge", codeRefCount: 2, referenceCount: 0, category: "architecture" },
    expected: 3.6, // 1 + 1.0 + 0.5 + 0.7 + 0.4
  },
  {
    name: "code · code-ref bonus caps at 1.2 (10 refs) · non-code category",
    input: { baseScore: 1, qualityScore: 40, freshness: "fresh", mode: "code", type: "knowledge", codeRefCount: 10, referenceCount: 0, category: "context" },
    expected: 3.7, // 1 + 1.0 + 0.5 + 1.2 + 0
  },
  {
    name: "code · work · feature · implementation phase",
    input: { baseScore: 0.8, qualityScore: 60, freshness: "attention", mode: "code", type: "work", codeRefCount: 1, referenceCount: 0, template: "feature", phase: "implementation" },
    expected: 3.4, // 0.8 + 1.5 + 0.2 + 0.35 + 0.35 + 0.2
  },
  {
    name: "code · work · refactor · review phase · no code refs",
    input: { baseScore: 1, qualityScore: 0, freshness: "unknown", mode: "code", type: "work", codeRefCount: 0, referenceCount: 0, template: "refactor", phase: "review" },
    expected: 1.65, // 1 + 0 + 0.1 + 0 + 0.35 + 0.2
  },
  {
    name: "code · category match is case-insensitive (Architecture)",
    input: { baseScore: 1, qualityScore: 40, freshness: "fresh", mode: "code", type: "knowledge", codeRefCount: 1, referenceCount: 0, category: "Architecture" },
    expected: 3.25, // 1 + 1.0 + 0.5 + 0.35 + 0.4
  },
  {
    name: "code · work · spike template earns NO code-mode template bonus",
    input: { baseScore: 1, qualityScore: 40, freshness: "fresh", mode: "code", type: "work", codeRefCount: 0, referenceCount: 0, template: "spike", phase: "planning" },
    expected: 2.5, // 1 + 1.0 + 0.5 + 0 + 0
  },
  {
    name: "code · knowledge · solution category",
    input: { baseScore: 1, qualityScore: 40, freshness: "fresh", mode: "code", type: "knowledge", codeRefCount: 0, referenceCount: 0, category: "solution" },
    expected: 2.9, // 1 + 1.0 + 0.5 + 0 + 0.4
  },

  // ── research mode ──
  {
    name: "research · knowledge · guide · sourced · 2 references",
    input: { baseScore: 1, qualityScore: 40, freshness: "fresh", mode: "research", type: "knowledge", codeRefCount: 0, referenceCount: 2, sourcePath: "sources/x.md", category: "guide" },
    expected: 3.8, // 1 + 1.0 + 0.5 + 0.4 + 0.5 + 0.4
  },
  {
    name: "research · reference bonus caps at 0.8 (10 refs) · spike · enrichment",
    input: { baseScore: 0.5, qualityScore: 0, freshness: "unknown", mode: "research", type: "work", codeRefCount: 0, referenceCount: 10, template: "spike", phase: "enrichment" },
    expected: 2.4, // 0.5 + 0 + 0.1 + 0.8 + 0.8 + 0.2
  },
  {
    name: "research · knowledge · architecture earns NO research category bonus",
    input: { baseScore: 1, qualityScore: 40, freshness: "stale", mode: "research", type: "knowledge", codeRefCount: 0, referenceCount: 0, category: "architecture" },
    expected: 1.75, // 1 + 1.0 - 0.25 + 0 + 0
  },
  {
    name: "research · sourcePath bonus · non-research category",
    input: { baseScore: 1, qualityScore: 0, freshness: "unknown", mode: "research", type: "knowledge", codeRefCount: 0, referenceCount: 0, sourcePath: "sources/y.md", category: "decision" },
    expected: 1.6, // 1 + 0 + 0.1 + 0.5 + 0
  },
  {
    name: "research · work · spike template · planning phase",
    input: { baseScore: 1, qualityScore: 0, freshness: "unknown", mode: "research", type: "work", codeRefCount: 0, referenceCount: 0, template: "spike", phase: "planning" },
    expected: 2.1, // 1 + 0 + 0.1 + 0.8 + 0.2
  },
  {
    name: "research · knowledge · context category",
    input: { baseScore: 1, qualityScore: 40, freshness: "fresh", mode: "research", type: "knowledge", codeRefCount: 0, referenceCount: 0, category: "context" },
    expected: 2.9, // 1 + 1.0 + 0.5 + 0 + 0.4
  },

  // ── rounding ──
  {
    name: "rounds to 3 decimals (1.9567 → 1.957)",
    input: { baseScore: 1.4567, qualityScore: 0, freshness: "fresh", mode: "general", type: "knowledge", codeRefCount: 0, referenceCount: 0 },
    expected: 1.957,
  },
];

describe("scoreContextPackItem — ranking formula characterization", () => {
  it.each(cases)("$name → $expected", ({ input, expected }) => {
    expect(scoreContextPackItem(input)).toBe(expected);
  });
});

describe("scoreContextPackItem — mode isolation", () => {
  it("general mode ignores code/research-specific fields", () => {
    const rich: ScoreInput = {
      baseScore: 1,
      qualityScore: 40,
      freshness: "fresh",
      mode: "general",
      type: "knowledge",
      codeRefCount: 5,
      referenceCount: 5,
      sourcePath: "sources/z.md",
      category: "architecture",
      template: "feature",
      phase: "implementation",
    };
    const bare: ScoreInput = {
      baseScore: 1,
      qualityScore: 40,
      freshness: "fresh",
      mode: "general",
      type: "knowledge",
      codeRefCount: 0,
      referenceCount: 0,
    };
    // None of the extra fields move the score in general mode.
    expect(scoreContextPackItem(rich)).toBe(scoreContextPackItem(bare));
    expect(scoreContextPackItem(rich)).toBe(2.5); // 1 + 1.0 + 0.5
  });
});

describe("scoreContextPackItem — ordering", () => {
  it("ranks items by descending score in code mode", () => {
    const items = [
      // capped code-ref bonus, no category bonus → 3.7
      { id: "caps", input: { baseScore: 1, qualityScore: 40, freshness: "fresh", mode: "code", type: "knowledge", codeRefCount: 10, referenceCount: 0, category: "context" } satisfies ScoreInput },
      // architecture + 2 refs → 3.6
      { id: "arch", input: { baseScore: 1, qualityScore: 40, freshness: "fresh", mode: "code", type: "knowledge", codeRefCount: 2, referenceCount: 0, category: "architecture" } satisfies ScoreInput },
      // work feature in implementation → 3.4
      { id: "work-feature", input: { baseScore: 0.8, qualityScore: 60, freshness: "attention", mode: "code", type: "work", codeRefCount: 1, referenceCount: 0, template: "feature", phase: "implementation" } satisfies ScoreInput },
      // thin work item → 1.65
      { id: "thin", input: { baseScore: 1, qualityScore: 0, freshness: "unknown", mode: "code", type: "work", codeRefCount: 0, referenceCount: 0, template: "refactor", phase: "review" } satisfies ScoreInput },
    ];

    const ranked = [...items]
      .sort((a, b) => scoreContextPackItem(b.input) - scoreContextPackItem(a.input))
      .map((i) => i.id);

    expect(ranked).toEqual(["caps", "arch", "work-feature", "thin"]);
  });
});
