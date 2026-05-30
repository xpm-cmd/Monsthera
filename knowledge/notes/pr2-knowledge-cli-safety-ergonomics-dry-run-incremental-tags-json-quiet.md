---
id: k-s3o4od24
title: PR2: knowledge CLI safety + ergonomics (dry-run, incremental tags, json, quiet)
slug: pr2-knowledge-cli-safety-ergonomics-dry-run-incremental-tags-json-quiet
category: solution
tags: [monsthera, cli, ergonomics, dogfood, knowledge]
codeRefs: []
references: []
createdAt: 2026-05-30T10:55:31.629Z
updatedAt: 2026-05-30T10:55:31.629Z
---

## Summary

PR2 of the real-corpus dogfood follow-up — P1 CLI safety + ergonomics for `monsthera knowledge`. Branch `fix/cli-ergonomics`, four feature commits. PR1 (#118) shipped the P0 data-integrity fixes; this batch makes the CLI safe and scriptable. T5 (minimize update frontmatter churn) was deliberately deferred to its own PR3, and T9 was a verified no-op (already correct on main).

Commits (oldest→newest): `dfb2f2b` (T4), `7276906` (T3), `61c00a8` (T6/T7/T8), `8a74d02` (T10).

## What shipped

- **T4 — incremental tags (`dfb2f2b`).** New pure `applyTagDelta(current, add, remove)` in `src/knowledge/tags.ts`, reusing `normalizeTag` so add/remove share one definition of tag identity (dedupe, quote-strip, case-fold). CLI `knowledge update --add-tag/--remove-tag` (mutually exclusive with full-replace `--tags`). MCP parity: `update_article` gains `add_tags`/`remove_tags`, resolved into a concrete `tags` array BEFORE the service spread — else the service's Zod schema strips the unknown keys (the same mechanism as the T11 frontmatter-drop root cause). Both surfaces reject combining incremental with full-replace.
- **T3 — dry-run + confirmation (`7276906`).** New `src/cli/prompt.ts` (`isAffirmative` + `confirm`; safe-default-deny). `update --dry-run` prints a field-level diff (content shown as a char-count delta, not the body) and exits without writing. `delete --dry-run` previews; `delete` requires interactive confirmation in a TTY, `--yes`/`-y` skips it, and a non-interactive context (pipe/CI, detected via `process.stdin.isTTY`) proceeds unprompted so scripts are not blocked.
- **T6/T7/T8 — output ergonomics (`61c00a8`).** `update --quiet` prints a one-line summary instead of the full body. `get --json` emits the single article (same shape as `list --json` items), via both id and slug resolution. `list --json --no-content` drops the bulky `content` field from each item.
- **T10 — references direction (`8a74d02`).** `formatArticle` now renders a `References (outgoing):` line; `refs --help` spells out that frontmatter `references:` are outgoing, `--to` is incoming, `--from` is outgoing, `--orphans` is unresolved outgoing.

## Key decisions

- **CLI vs CLI+MCP parity:** T3/T6/T7/T8/T10 are CLI-output ergonomics — MCP already returns structured objects, so they are CLI-only by design. Only T4 adds a *capability* MCP lacked, so it got MCP parity (the repo's agent-native principle).
- **Confirm gating on `process.stdin.isTTY`:** a delete confirm must never block scripts/CI. The explicit isTTY check means interactive terminals prompt, everything else proceeds. `confirm()` itself defaults to deny on any non-affirmative answer.
- **MCP delta resolved before the service spread:** `update_article` destructures `add_tags`/`remove_tags` out, reads current tags via `getArticle`, computes `applyTagDelta`, and sets `tags` — because passing them through would let Zod silently drop them.

## Verification

- `pnpm typecheck` 0, `pnpm lint` 0, full suite **2030 tests / 149 files** green, `monsthera lint` exit 0, `monsthera doctor` exit 0 (stdout starts "Monsthera Doctor"; T9/#10 still a non-issue).
- Real-artifact CLI checklist (throwaway temp repo, current source via `tsx src/bin.ts`, run sequentially): create `--tags alpha,beta` → `update --add-tag gamma --dry-run` shows the diff and disk stays `[alpha, beta]` → `--add-tag gamma --quiet` writes `[alpha, beta, gamma]` → `--remove-tag alpha` → `[beta, gamma]` → `get --json` parses id + `['beta','gamma']` → `get` shows `References (outgoing): (none)` → `list --json --no-content` has no `content` key → `delete --dry-run` prints `would delete k-… (Verify Me)` and the file stays → real `delete` removes it. (Running many `pnpm exec` invocations concurrently against `/tmp` is flaky in this harness — exit 127 / cleaned dirs — but a clean sequential pass is green; the behavior is also covered by in-process vitest tests.)

## Out of scope / next

- **T5** (minimal-diff frontmatter write on update) → PR3. Its dramatic symptom (block→flow rewrite, quote-strip) is not reproducible on this repo's already-flow-style corpus; it needs a `patchFrontmatter` raw line-patch in `src/knowledge/file-repository.ts` with byte-level tests.
- **T11** (custom-frontmatter ADR, design only) is the next item. Root cause confirmed: `ArticleFrontmatterSchema` is a plain `z.object` that strips unknown keys.