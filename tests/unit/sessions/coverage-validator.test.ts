import { describe, it, expect } from "vitest";
import {
  evaluateHandoffCoverage,
  renderCoverageSection,
  COVERAGE_DIMENSIONS,
  type CoverageGap,
} from "../../../src/sessions/coverage-validator.js";

const RICH_BODY = `> **Session** \`ses-x\` · agent \`claude-code\` · 10 min
> Quality 5/5 (gemma4:latest)
> Intent: ship phase X

## TL;DR

Shipped phase X.

## What happened

Did the thing.

### Decisions

- Bundle 3d + 3e because the call site in \`src/sessions/facts-extractor.ts:108\` overlaps.

### Blockers

- Ollama unreachable during test run — workaround: re-run with \`MONSTHERA_SESSIONS_LLM_ENABLED=false\`.

### Deferred

- Mtime short-circuit optimisation for \`findUpdatedSince\` — only worth it above ~1K articles.

## What's next

### First action

**Run \`pnpm test\` and edit \`src/foo.ts:42\` to add the missing branch.**

- evidence: [commit:abcdef12]
- why: regression test caught a corner case.

### Verification

Run \`pnpm test tests/unit/foo.test.ts\` and check \`monsthera doctor\` is green.

## Hypergraph

**Commits** (1 of 1):
- \`abcdef12\` feat: add the thing

Events in window: 0
`;

const THIN_BODY = `> **Session** \`ses-y\` · agent \`claude-code\` · 0 min

## TL;DR

Did some work.

## What happened

The agent completed several changes.

## What's next

### First action

**Review the changes.**

## Hypergraph

Events in window: 0
`;

describe("evaluateHandoffCoverage", () => {
  it("reports zero gaps for a body that answers all five questions", () => {
    const gaps = evaluateHandoffCoverage(RICH_BODY);
    expect(gaps).toEqual([]);
  });

  it("flags a thin body that does not name file:line or any concrete command in the first action", () => {
    const gaps = evaluateHandoffCoverage(THIN_BODY);
    const dimensions = gaps.map((g) => g.dimension);
    expect(dimensions).toContain("executable-action");
  });

  it("flags a body with no verification command anywhere", () => {
    const gaps = evaluateHandoffCoverage(THIN_BODY);
    const dimensions = gaps.map((g) => g.dimension);
    expect(dimensions).toContain("verification");
  });

  it("flags a body without any explicit constraint, blocker, or deferred item", () => {
    const gaps = evaluateHandoffCoverage(THIN_BODY);
    const dimensions = gaps.map((g) => g.dimension);
    expect(dimensions).toContain("constraints");
  });

  it("does NOT flag intent when the preamble has a non-empty `> Intent:` line", () => {
    const gaps = evaluateHandoffCoverage(RICH_BODY);
    const dimensions = gaps.map((g) => g.dimension);
    expect(dimensions).not.toContain("intent");
  });

  it("does flag intent when the preamble has no intent line", () => {
    const noIntent = THIN_BODY.replace(/\n> Intent:.*\n/, "\n");
    const gaps = evaluateHandoffCoverage(noIntent);
    const dimensions = gaps.map((g) => g.dimension);
    expect(dimensions).toContain("intent");
  });

  it("credits constraints when the body mentions regression as a watchout (not just explicit sections)", () => {
    const body = THIN_BODY.replace(
      "## What happened\n\nThe agent completed several changes.",
      "## What happened\n\nThe regex changes risk a regression in detection; the agent must verify.",
    );
    const gaps = evaluateHandoffCoverage(body);
    const dimensions = gaps.map((g) => g.dimension);
    expect(dimensions).not.toContain("constraints");
  });

  it("exposes all five coverage dimensions as a stable, lint-able list", () => {
    expect(COVERAGE_DIMENSIONS).toEqual(
      expect.arrayContaining([
        "state",
        "intent",
        "executable-action",
        "constraints",
        "verification",
      ]),
    );
    expect(COVERAGE_DIMENSIONS).toHaveLength(5);
  });

  it("each gap carries dimension + question + suggestion fields for surfacing", () => {
    const gaps = evaluateHandoffCoverage(THIN_BODY);
    expect(gaps.length).toBeGreaterThan(0);
    for (const gap of gaps) {
      expect(gap).toMatchObject({
        dimension: expect.any(String),
        question: expect.any(String),
        suggestion: expect.any(String),
      });
    }
  });

  // ─── Bare-prose recognition (round 4 calibration) ───────────────────────────
  // The LLM doesn't always wrap file paths or commands in backticks even when
  // the agent's --note had them. These tests pin the bare-prose acceptance
  // paths added in commit `feat(sessions): broaden coverage validator regex`.

  it("credits executable-action when the body has a bare file:line in prose (no backticks)", () => {
    const body =
      THIN_BODY +
      "\n\nThe next step is to edit src/foo.ts:42 and add the missing branch.";
    const gaps = evaluateHandoffCoverage(body);
    expect(gaps.map((g) => g.dimension)).not.toContain("executable-action");
  });

  it("credits verification when the body has a bare `pnpm test <path>` in prose (no backticks)", () => {
    const body =
      THIN_BODY +
      "\n\nVerify by running pnpm test tests/unit/sessions/foo.test.ts.";
    const gaps = evaluateHandoffCoverage(body);
    expect(gaps.map((g) => g.dimension)).not.toContain("verification");
  });

  it("does NOT credit executable-action for a bare file mention without `:line` suffix", () => {
    const body = THIN_BODY + "\n\nSee src/foo.ts for context on the auth flow.";
    const gaps = evaluateHandoffCoverage(body);
    // The file is mentioned but with no specificity — that's prose, not action.
    expect(gaps.map((g) => g.dimension)).toContain("executable-action");
  });

  it("does NOT credit verification for vague 'run the tests' prose without an argv-shaped target", () => {
    const body =
      THIN_BODY +
      "\n\nRun the tests and check the doctor command before merging.";
    const gaps = evaluateHandoffCoverage(body);
    // "Run the tests" mentions no specific test path or doctor invocation;
    // hasVerification should not credit it.
    expect(gaps.map((g) => g.dimension)).toContain("verification");
  });

  it("credits constraints for every inflection of `regress` (regression, regressions, regressing, regressive)", () => {
    const variants = [
      "regress",
      "regressed",
      "regresses",
      "regressing",
      "regression",
      "regressions",
      "regressive",
    ];
    for (const variant of variants) {
      const body = THIN_BODY.replace(
        "## What happened\n\nThe agent completed several changes.",
        `## What happened\n\nThe change may cause a ${variant} in some edge cases.`,
      );
      const gaps = evaluateHandoffCoverage(body);
      expect(
        gaps.map((g) => g.dimension),
        `variant "${variant}" should not flag constraints`,
      ).not.toContain("constraints");
    }
  });

  it("pins behavior on the degraded T1-only fixture: state + intent pass; the other three fail", () => {
    // The degraded fixture (ses-20260513-003933-claude-code) is the canonical
    // shape for an Ollama-unavailable handoff: header, Hypergraph, Commits,
    // Events count, Facts pointer — but no narrative, no nextSteps, no
    // blockers. It must continue to flag executable-action / constraints /
    // verification so the next agent knows the LLM stage didn't run.
    const degraded = [
      "> **Session** `ses-20260513-003933-claude-code` · agent `claude-code` · 1 min",
      "> Quality (no eval) (qwen2.5-coder:7b) · degraded (Ollama unavailable)",
      "> Intent: phase 3c dogfood verification",
      "",
      "## TL;DR",
      "",
      "_Handoff is degraded — LLM pipeline did not run._",
      "",
      "## What's next",
      "",
      "(no concrete next steps — review the Hypergraph below for context.)",
      "",
      "## Hypergraph",
      "",
      "**Commits** (1 of 1):",
      "- `9fb97a45` feat(sessions): Phase 3c — DefaultFactsExtractor",
      "",
      "Events in window: 0",
    ].join("\n");

    const gaps = evaluateHandoffCoverage(degraded);
    const dimensions = gaps.map((g) => g.dimension);
    expect(dimensions).not.toContain("state"); // Hypergraph + commit:<sha> in backticks
    expect(dimensions).not.toContain("intent"); // explicit Intent line
    expect(dimensions).toContain("executable-action");
    expect(dimensions).toContain("constraints");
    expect(dimensions).toContain("verification");
  });
});

describe("renderCoverageSection", () => {
  it("renders nothing for a zero-gap report", () => {
    expect(renderCoverageSection([])).toBe("");
  });

  it("renders a `## Coverage` section enumerating each gap when there are gaps", () => {
    const gaps: CoverageGap[] = [
      { dimension: "verification", question: "How do I verify?", suggestion: "Name a test command or doctor check." },
      { dimension: "constraints", question: "What must I not break?", suggestion: "List blockers, deferred items, or invariants." },
    ];
    const rendered = renderCoverageSection(gaps);
    expect(rendered).toContain("## Coverage");
    expect(rendered).toContain("How do I verify?");
    expect(rendered).toContain("What must I not break?");
    expect(rendered).toContain("Name a test command");
  });

  it("includes the dimension as a slug-style marker so consumers can grep", () => {
    const gaps: CoverageGap[] = [
      { dimension: "executable-action", question: "What do I do?", suggestion: "Cite file:line." },
    ];
    expect(renderCoverageSection(gaps)).toMatch(/`executable-action`/);
  });
});
