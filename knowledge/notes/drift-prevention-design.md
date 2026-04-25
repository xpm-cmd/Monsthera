---
id: k-drift-prevention-design
title: "Drift Prevention — Design"
slug: drift-prevention-design
category: guide
tags: [drift, lint, design, hedera-retrospective, s5-closure]
codeRefs:
  - src/work/lint.ts
  - src/work/planning-hash.ts
  - src/core/worktree.ts
  - src/cli/hook-commands.ts
references:
  - k-anti-example-registry
  - k-demo-drift-hedera
createdAt: 2026-04-25T00:00:00.000Z
updatedAt: 2026-04-25T00:00:00.000Z
---

# Drift Prevention — Design

Closure note for the Hedera v1 retrospective. Pairs S5 Part A
(anti-example registry, citation value-match, verify density) with
S5 Part B (planning-hash guard, worktree assert, pre-commit hook
wrapper). Together these check every drift class the retrospective
surfaced and pin them before they reach review.

## The six drift classes

Every drift entry in the Hedera v1 retrospective fits into one of
these classes. The mapping below is the design contract: any future
drift class either fits an existing slot or earns its own row.

| # | Class | What it looks like | Provenance |
|---|---|---|---|
| 1 | Numeric drift | `$0.010` becomes `$0.10` in a sibling article | Wave-2 boundary review |
| 2 | Token drift | `B1_4_kill_switch_alpha` cited but the canonical Lean theorem is `B1_4_kill_switch_alpha_v2` | Wave-2 review |
| 3 | Phrase drift | "22.4% bars" stays in prose after the canonical figure is updated to "22.35 bars" | Wave-2 boundary review |
| 4 | Citation-value drift | An article cites `k-xxx` and quotes a value that does not appear in `k-xxx` | Wave-3 audit |
| 5 | Verify-marker accumulation | An article gains so many `[verify]` markers that the review burden silently grows | Wave-3 audit |
| 6 | Planning-section tampering | The `## Planning` section of a work article is edited after enrichment without rolling phase back | Hedera v1 retrospective |

Orphan citations were also surfaced but as a warning class — they
gate nothing but live in the same lint surface so authors see them
together.

## Check matrix

| Check | Stage | Severity | Opt-in? |
|---|---|---|---|
| `canonical_value_mismatch` | lint | error | always |
| `token_drift` | lint | error | always |
| `phrase_anti_example` | lint | error | always |
| `citation_value_mismatch` | lint | error | `--with-citation-values` |
| `verify_density_exceeded` | lint | warning | always (threshold tunable) |
| `planning_section_tampered` | lint | error | always (S5 B) |
| `orphan_citation` | lint | warning | always |

The `--registry` filter selects which families run: `canonical-values`
runs row 1, `anti-examples` runs rows 2 and 3, `planning-hash` runs
row 6, and `all` (default) runs every always-on rule. Citation-value
and verify-density are governed by their own opt-in flags so the
default scan stays cheap.

## Where checks run

A check is only useful at the moments where its signal can act on the
human or agent reading it. The Hedera retrospective showed that the
same drift caught at write-time costs near zero, while the same drift
caught at review-time costs hours.

| Stage | What runs | What is gated |
|---|---|---|
| Write-time (`monsthera lint` ad-hoc) | All `--registry all` rules | Nothing — the author chooses to act |
| Advance-time (`work advance`) | Existing guards (`policy_requirements_met`, `min_enrichment_met`, etc.) | Phase transition |
| Commit-time (`monsthera install-hook` pre-commit) | All `--registry all` rules on staged `.md` files | Local commit |
| Review-time (CI `monsthera lint`) | All rules + `--with-citation-values` | PR merge |

The planning-hash check is signal-only at advance-time — the rule does
not block `work advance`. ADR-012 records the rationale: a hash
mismatch at advance time is more often the result of a deliberate
rebase than a forgotten rollback, and surfacing it as a lint error
(visible in CI) preserves the audit trail without paying the
false-positive cost of a hard gate.

## Worktree assert + hook wrapper

Two additional capabilities ship in S5 B but do not belong to the
check matrix above — they govern the *environment* in which checks
run, not what they check.

- `--assert-worktree` / `MONSTHERA_REQUIRE_WORKTREE=true` makes the
  CLI refuse to operate from a main repo when a caller demands the
  isolation of a worktree. Exit code 2. Exemptions: `install-hook`,
  `uninstall-hook`, `--help`, `--version`. The retrospective surfaced
  multiple cases where an agent edited the main repo unintentionally
  while a worktree existed; the assert is opt-in, designed to be set
  once in `.envrc` for agent sessions.
- `monsthera install-hook` writes a pre-commit script that runs
  `monsthera lint` against staged `knowledge/` `.md` files. The
  installer is husky-aware and worktree-aware: it resolves the right
  hooks dir via `core.hooksPath` > `.husky/` > `<gitDir>/hooks/` and
  uses the main repo's git dir even when invoked from a worktree.
  Removable via `uninstall-hook`; only files carrying the
  `monsthera-managed-hook` marker are touched.

## Cross-references

- ADR-010 — Orchestrator ergonomics (canonical values lint, ref graph).
- ADR-011 — CLI ergonomics (work list filters, advance output, phase metadata).
- ADR-012 — Drift prevention closure (this design's rationale).
- `knowledge/notes/anti-example-registry.md` — seed for token + phrase rules.
- `knowledge/notes/demo-drift-hedera.md` — deliberate demo; left in place to exercise the hook.
