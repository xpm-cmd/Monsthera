---
id: k-pajgyr76
title: PR-13a: Knowledge provenance (origin enum + doctor breakdown)
slug: pr13-provenance
category: solution
tags: [m3, pr-13, provenance, knowledge, doctor, adr-020]
codeRefs: [src/knowledge/provenance.ts, src/work/service.ts, src/work/distillation.ts, src/cli/doctor-commands.ts, tests/unit/knowledge/provenance.test.ts]
references: [pr12-embedding-onboarding, k-8d85l75r]
createdAt: 2026-05-31T10:21:14.459Z
updatedAt: 2026-05-31T10:21:14.459Z
---

First half of **PR-13** (M3, knowledge-capability plan). Records where a knowledge article came from. The deferrable **salience** half was split out and deferred (see below).

## What shipped (main @ 68c134b, PR #137)
- **`src/knowledge/provenance.ts`** (new, dependency-free leaf): `ORIGIN` enum (`agent|human|distilled|ingested`) + named constants, `isOrigin` guard, `resolveOrigin` (missing/unrecognized → `agent`), and `summarizeProvenance` (corpus distribution; present-but-unrecognized values bucketed on their own line).
- **Distillation normalized**: `src/work/service.ts` now writes `origin: ORIGIN.DISTILLED` (was the magic string `"distilled"`); `buildDistilledBody` prose interpolates the constant too. Wire value unchanged — pinned green by `tests/integration/work-distillation.test.ts:39`.
- **`monsthera doctor`**: read-only "Provenance (knowledge origin)" breakdown. Unrecognized origins (e.g. a hand-typed `--field origin=humann`) surface on their own line so typos stay visible (active-hygiene; user-chosen behavior).

## Key design decision — read-time default, NOT written to disk
`origin` lives in the free-form `extraFrontmatter` bag (ADR-020, added by PR-4) and the `agent` default is resolved by `resolveOrigin` at read-time — never persisted. Rationale:
- Only non-default origins are written today (distillation `distilled`; PR-15 `ingested`; humans `human`). Writing `agent` to every article would bloat each frontmatter block and fight the shipped **T5 minimal-diff** principle ("extraFrontmatter stays absent on articles that don't use it").
- **Zero migration**: live `doctor` shows `agent: 90` with 0 `origin:` lines on disk — the resolver gives a correct distribution immediately. The raw value still round-trips verbatim (ADR-020).

## Salience (PR-13b) — DEFERRED by decision
The ranking-bonus half is deferrable and was deferred. The eval golden set has ~1 relevant doc/query already ranked #1, so NDCG@5/MRR/P@5 are saturated (1.0/1.0/0.2). Salience only reorders results, so on this set it can be neutral-or-worse but never *improve* eval — it cannot clear the handoff's stricter "ship only if eval improves" gate. Revisit if/when the golden set is expanded to expose ranking differences.

## Reusable downstream
- **PR-15** ingestion will set `extraFrontmatter.origin = ORIGIN.INGESTED` + `sourcePath`.
- **PR-14** custom-frontmatter query/lint can filter/validate `custom.origin` via the same enum (`isOrigin`) and `summarizeProvenance` counts.

## Verification (hermetic)
`pnpm test` 2163 → 2174 (+11, `tests/unit/knowledge/provenance.test.ts`); `typecheck`/`eslint`/`monsthera lint` corpus all 0; live `monsthera doctor` Provenance section renders.

Continues M2 [[pr12-embedding-onboarding]]. NEXT in M3: PR-14 custom-frontmatter query+lint, PR-15 git/PR ingestion.