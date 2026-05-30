---
id: k-doed4dzy
title: PR1: corpus tag-hygiene (write-path normalize + lint rule)
slug: pr1-corpus-tag-hygiene-write-path-normalize-lint-rule
category: solution
tags: [monsthera, tags, lint, data-integrity, dogfood]
codeRefs: []
references: []
createdAt: 2026-05-30T09:05:06.447Z
updatedAt: 2026-05-30T09:08:51.470Z
---

## Problem

Creating an article with `--tags "'family:kriging', family:kriging,  family:kriging "` persisted frontmatter where surrounding quotes survived AND duplicates coexisted. In the separately-audited 83-article scientific corpus this produced 78 split tag-pairs across 39 articles, silently halving `shared_tag` graph edges. (This Monsthera dev repo's own corpus happens to be tag-clean already — see Verification.)

## Root cause — two independent bugs

1. **Write path:** `parseCommaSeparated` (`src/cli/arg-helpers.ts`) did `split(",").map(trim).filter(Boolean)` — no quote-strip, no dedupe. `serializeMarkdown` (`src/knowledge/markdown.ts`) then wrote arrays verbatim as `[a, b]`.
2. **Read path:** `parseValue`'s inline-array branch (`src/knowledge/markdown.ts:19`) keeps surrounding quotes on each array item — the scalar quote-strip at `:23` only applies to a whole-value scalar, never to array items.

## Fix (PR1, branch `fix/corpus-data-hygiene`)

**T1 — normalize at the write-input boundary.** New pure module `src/knowledge/tags.ts` (`normalizeTag` / `normalizeTags`): trim, strip one surrounding quote pair, collapse internal whitespace runs, drop empties, dedupe by a case-folded key while preserving the first-seen tag's original casing. Wired via a Zod `.transform(normalizeTags)` on the `tags` field of BOTH `CreateArticleInputSchema` and `UpdateArticleInputSchema` (`src/knowledge/schemas.ts`). This is the single chokepoint — the CLI, the MCP tools, and the batch paths all flow through `validateCreateInput` / `validateUpdateInput`, so a dirty tag is impossible to persist from any entry point. Commits `9b14e40` (normalizer) and `085eb3e` (wiring).

**T2 — audit path for the existing backlog.** New lint rule `tag_near_duplicate` (severity `warning`, new `tag-hygiene` registry family) in `src/work/lint.ts`: per-article, groups the raw frontmatter `tags` by normalized key and flags any key with 2+ raw variants (quote / case / whitespace, or exact duplicates). Reuses `normalizeTag` so detection and prevention share one definition of "the same tag". Respects the existing `LINT_EXEMPT_TAGS` exemption. Formatter case + `--registry` validation added in `src/cli/lint-commands.ts`. Commit `4cd841d`.

## Key decisions

- **Layer = Zod schema transform**, not service methods and not `parseCommaSeparated`. Declarative, covers every caller, impossible to bypass; the alternatives are CLI-only (misses MCP) or churn-prone (serialize-time).
- **T1 <-> T5 precedence = normalize on write-input only.** A title-only update re-serializes every field, so normalizing at serialize-time would rewrite the tags line on unrelated edits (a T5 minimal-diff violation). Instead, new/edited tags are always clean; the historical backlog is left untouched until a deliberate `update --tags` / migrate pass — and is surfaced by the T2 lint.
- **`parseValue` (read path) deliberately untouched.** Fixing its quote-on-array-items quirk would make every read restrip quotes, so unrelated saves would change the tags line — the same churn problem.
- **Warning, not error.** `monsthera lint`'s exit code gates the pre-commit hook, so a historical-hygiene backlog must not block commits. Symmetric with `verify_density_exceeded` and `orphan_citation`.

## Why both T1 and T2

T1 prevents NEW dirty tags; T2 surfaces tags that ALREADY entered via older tool versions. Write-path and audit-path are complementary — normalizing alone leaves invisible historical debt, and linting alone lets new dirty tags keep arriving.

## Verification

- Full suite: 2006 tests pass across 147 files (+17 new for this PR). `pnpm typecheck` 0, `pnpm lint` 0, `monsthera lint` exit 0, `monsthera doctor` exit 0.
- Real artifact: CLI create with `--tags "'family:kriging', family:kriging,  family:kriging "` → on-disk frontmatter `tags: [family:kriging]`.
- Real corpus: this repo's own knowledge corpus is already tag-clean — `monsthera lint --registry tag-hygiene` reports 0 `tag_near_duplicate` findings and exits 0. The rule's firing behavior is proven by unit fixtures in `tests/unit/work/lint-anti-examples.test.ts` (dirty fixture → 1 finding; clean control → 0; lint-exempt → 0).

## Out of scope (PR1)

T3–T8 / T10 (CLI ergonomics, a separate PR), T9 (already fixed on `main` — verified no-op: `doctor` stdout starts with "Monsthera Doctor", no JSON logs), and T11 (custom-frontmatter ADR, design only). The root cause for T11 is confirmed: `ArticleFrontmatterSchema` is a plain `z.object` and strips unknown keys, so the corpus author's scientific schema fields were silently dropped (`tests/unit/knowledge/schemas.test.ts` even has a test asserting this strip behavior).