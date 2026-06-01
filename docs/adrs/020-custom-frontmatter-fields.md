# ADR-020: Typed / Custom Frontmatter Fields

**Status:** Accepted — implemented (2026-05-31; all three gaps closed)
**Date:** 2026-05-30
**Deciders:** Monsthera core
**Supersedes:** none
**Related:** ADR-001 (Storage Model), ADR-005 (Surface Boundaries), ADR-007 (Policy Articles), ADR-012 (Drift Prevention Closure)

---

## Implementation status

This ADR shipped in full across three PRs. The present-tense "gaps are open" framing in **Context** below is the historical record as written on 2026-05-30; the gaps are now closed:

- **Phase 0 — storage round-trip:** pre-existing (blessed as canonical here).
- **Phase 1 — authoring (gap 1):** PR #125 — `extraFrontmatter` accepted on the create/update input schemas; CLI `--field key=value`; MCP `extraFrontmatter` object on `create_article`/`update_article`.
- **Phase 2 — query (gap 2):** PR #138 — `--filter custom.<key><op><value>` on `knowledge list` + the `list_articles` MCP tool (`src/knowledge/custom-filter.ts`). **Deviation:** the `custom.<key>` *search-term emission* (Decision §"Query / index integration" and Implementation note P2) was deferred — the tokenizer splits on every non-alphanumeric char (`/[^a-z0-9]+/`), so a namespaced `custom.<key>` term cannot survive without a tokenizer change that risks the ranking characterization pins. The in-memory `--filter` predicate (tokenizer-independent) delivers the queryability the gap required and keeps retrieval eval-neutral.
- **Phase 3 — validation (gap 3):** PR #139 — `custom-frontmatter` lint family + per-category policy rules via `policy_custom_frontmatter_json` (`src/work/lint.ts`, `src/work/policy-loader.ts`).

Provenance (`origin`) shipped alongside in PR #137, and git ingestion sets `origin: ingested` in PR #140. Knowledge notes: `pr14-custom-frontmatter-query`, `pr14-custom-frontmatter-lint`, `pr13-provenance`.

---

## Context

A knowledge article's frontmatter is a fixed set of ten fields, validated by `ArticleFrontmatterSchema` (`src/knowledge/schemas.ts`): `id, title, slug, category, tags, codeRefs, references, sourcePath, createdAt, updatedAt`. Real domains carry more. The motivating case is a scientific knowledge corpus whose author wanted per-article fields like `replicability_score`, `input_dim`, and `accuracy_metrics` — none of which the fixed model has a home for. In a corpus audit, the author had embedded that schema as HTML comments inside `content`, where it is invisible to query, lint, and validation; three missing scores and dozens of garbage lines went undetected.

**What already works (verified empirically, 2026-05-30, against current `main`):** the *persistence* layer already preserves arbitrary custom frontmatter through the read→domain→write round-trip:

- `KnowledgeArticle.extraFrontmatter?: Readonly<Record<string, unknown>>` exists (`src/knowledge/repository.ts`), as do `extraFrontmatter` fields on `CreateKnowledgeArticleInput`, `UpdateKnowledgeArticleInput`, and `WriteWithSlugInput`.
- `file-repository.ts` `extractExtraFrontmatter()` captures every non-standard key on read; `writeArticle()` spreads `...(article.extraFrontmatter ?? {})` back on write; create/update/rename all thread it through.
- Test: a hand-authored `notes/sci.md` with `replicability_score: 0.91` / `input_dim: 12` → `knowledge update --title …` → the custom fields **survive byte-for-byte on disk**, and `knowledge get --json` returns them under an `extraFrontmatter` object.

So the "cheap passthrough so custom fields survive read-modify-write" that earlier framing imagined as step one **is already shipped**. The actual gaps are narrower and more specific:

1. **Authoring is blocked at the validation boundary.** `CreateArticleInputSchema` / `UpdateArticleInputSchema` are plain `z.object` — Zod strips unknown keys. They sit in front of every service caller (CLI, MCP, batch — see ADR-005). So `createArticle({ …, replicability_score: 0.91 })` silently drops the field *before* it reaches the repo that could store it. Today the only way to get a custom field onto an article is to hand-write the markdown file; no surface can author one.
2. **Custom fields are not queryable.** Nothing in `src/search/` indexes `extraFrontmatter`. You can read a custom field on an article you already have, but you cannot find articles *by* one (e.g. "every `solution` with `replicability_score < 0.8`").
3. **Custom fields are not lintable.** `src/work/lint.ts` never sees `extraFrontmatter`. There is no way to assert "every article in this category must carry `replicability_score` ∈ [0,1]" or to flag stray/garbage keys. This is the gap that let the missing scores slip through.

This ADR decides how to close (1), (2), and (3). It was design-only when written (2026-05-30); see **Implementation status** above for the PRs that have since shipped all three.

## Decision

Adopt **`extraFrontmatter` as the canonical custom-field carrier** (it already exists and round-trips) and close the three gaps in phases, smallest blast radius first.

### Schema strategy — a typed `extraFrontmatter` bag, NOT `.passthrough()`, NOT per-category schemas (yet)

Open the authoring boundary by having the input schemas **accept and route unknown keys into `extraFrontmatter`** rather than stripping them — but keep the bag explicit rather than switching the object to `z.object(...).passthrough()`.

- **Why not `.passthrough()`:** passthrough would let any typo (`replicabilty_score`) land as a real top-level field indistinguishable from a known one, re-creating the silent-drift problem one level up. It also blurs the line between the ten first-class fields and user data.
- **Why not per-category Zod schemas now:** a registry of `category → schema` is the most powerful option but the heaviest — it needs a schema authoring/storage surface, versioning, and migration. It is the *eventual* home for validation (gap 3), delivered via policy articles (below), not a day-one requirement.
- **Chosen:** at the validation boundary, partition input keys into known (the ten) and unknown; fold the unknown set into `extraFrontmatter` (merging with any explicit `extraFrontmatter` the caller passed). Values stay `unknown`-typed (string/number/boolean/array as parsed). This is a small, reversible change to two schemas and makes authoring possible from every surface at once.

### Query / index integration (gap 2)

Index `extraFrontmatter` keys and scalar values into the existing search infrastructure (ADR-001's index), and expose a filter:

- Flatten `extraFrontmatter` to `custom.<key> = <scalar>` index terms during the same sync that already indexes tags/category.
- Add a `--filter custom.<key><op><value>` to `knowledge list` (and the `list_articles` MCP tool) for equality and numeric comparison on scalars. Reuse the in-memory filter layering that `list_articles` already does for `tag`/`hasCodeRefs` (ADR-005) rather than inventing a query language.
- Non-scalar custom values (objects/arrays) are stored and returned but not filterable in this phase; document the limit explicitly (no silent truncation — see ADR-012).

### Lint / validation integration (gap 3) — user rules via policy articles

Validation of custom fields is **user-supplied, not hard-coded**, delivered through the existing **policy-article** mechanism (ADR-007) and the lint registry (ADR-012, extended in PR1 with the `tag-hygiene` family):

- A policy article declares, per category, the expected custom fields: name, type, required/optional, and an optional scalar range/enum. (Same authoring path as canonical-values / anti-example registries already use.)
- A new lint family `custom-frontmatter` (joining `canonical-values`, `anti-examples`, `planning-hash`, `tag-hygiene`, `all`) scans each article's `extraFrontmatter` against the policy: a missing required field, a type mismatch, or an out-of-range scalar is a finding. Severity is **warning** by default (corpus hygiene, must not gate the pre-commit hook — consistent with `tag_near_duplicate`); a policy may opt a rule up to `error`.
- Respect the existing `LINT_EXEMPT_TAGS` exemption.

### Phased rollout

- **Phase 0 — already shipped (storage round-trip).** No work; bless `extraFrontmatter` as canonical and document it.
- **Phase 1 — authoring (gap 1).** Route unknown keys into `extraFrontmatter` at the create/update schema boundary; add a CLI surface (`--field key=value`, repeatable) and an MCP `extraFrontmatter` object on `create_article`/`update_article`. Now any surface can author custom fields. Smallest, highest-value step.
- **Phase 2 — query (gap 2).** Index + `--filter custom.<key>`.
- **Phase 3 — validation (gap 3).** Policy-driven `custom-frontmatter` lint family.

Each phase is independently shippable and useful; later phases are not prerequisites for earlier value.

## Consequences

**Positive:**
- Custom domain schemas become first-class: stored (already), authorable (P1), queryable (P2), and validated (P3) — no more HTML-comment smuggling.
- Reuses existing machinery at every step: `extraFrontmatter` (storage), the search sync (query), policy articles + the lint registry (validation). No new entity, no new storage.
- Back-compatible throughout: `extraFrontmatter` is optional; articles without custom fields are unchanged. The validation boundary change is additive (it stops stripping, starts routing).

**Negative / trade-offs:**
- Values are `unknown`-typed in the bag — no compile-time guarantees on custom fields; correctness comes from runtime lint (P3), not the type system. Acceptable: the alternative (per-category TS types) is not viable for user-defined fields.
- A typo'd key is now *stored* rather than *dropped*. That trades a silent loss for a visible-but-unvalidated field until P3's lint catches it. This is the right trade (data preserved > data lost), and P3 closes the gap.
- Two filter mechanisms after P2 (built-in fields vs `custom.<key>`), a minor surface increase.

## Alternatives considered

**A. `z.object(...).passthrough()` on the input schemas.** Rejected as the primary mechanism — it makes custom keys indistinguishable from the ten first-class fields, so a typo becomes a silent top-level field and the drift problem moves up a level. Routing into an explicit `extraFrontmatter` bag keeps the boundary legible. (Passthrough is, in effect, what P1 does *internally*, but funnelled into a named bag rather than the top level.)

**B. Per-category Zod schemas as the day-one model.** Rejected for now — most powerful (true typed validation) but needs a schema-authoring/storage/versioning/migration surface that dwarfs the immediate need. P3's policy-article rules deliver the validation value without a second schema system; per-category schemas can supersede this later if the policy DSL proves insufficient.

**C. A dedicated sidecar file (`notes/<slug>.meta.json`) for custom data.** Rejected — splits an article across two files, breaking the "Markdown file is the source of truth" invariant (ADR-001) and the round-trip guarantees. `extraFrontmatter` keeps everything in one file.

**D. Do nothing; keep custom data in `content`.** Rejected — that is the status quo that caused the audit failure (invisible to query/lint/validation).

---

## Implementation notes (for the eventual PRs — not part of this ADR)

- **Phase 1:** in `validateCreateInput`/`validateUpdateInput`, before/after `safeParse`, separate keys not in the known set and merge them into `extraFrontmatter` (preserving an explicitly-passed `extraFrontmatter`). CLI `--field key=value` (repeatable) parsed in `knowledge-commands.ts`; MCP `extraFrontmatter` object property on `create_article`/`update_article`. The repo already stores it.
- **Phase 2:** extend the search sync to emit `custom.<key>` terms for scalar values; add `--filter` parsing + an in-memory predicate layered like the existing `tag`/`hasCodeRefs` filters in `list_articles`.
- **Phase 3:** define the policy-article shape for per-category custom-field expectations (mirror `policy-loader.ts` patterns); add `custom-frontmatter` to `LintRegistry` and a `scanCustomFrontmatter` per-article check in `lint.ts`; add a `CustomFrontmatterFinding` to the `LintFinding` union and a formatter case in `lint-commands.ts`.
- Tests at each phase: round-trip authoring (P1), filter correctness incl. the non-scalar limit (P2), and policy-driven findings with a clean-corpus control (P3).
