---
id: k-8d85l75r
title: T5: Minimal-diff frontmatter write on knowledge update
slug: t5-minimal-diff-frontmatter-write-on-knowledge-update
category: solution
tags: [knowledge, frontmatter, serialization, minimal-diff, file-repository, dogfood, t5]
codeRefs: [src/knowledge/markdown.ts, src/knowledge/file-repository.ts, tests/unit/knowledge/markdown.test.ts, tests/unit/knowledge/file-repository-minimal-diff.test.ts]
references: [k-zj0lp1yv, k-s3o4od24]
createdAt: 2026-05-31T02:37:25.662Z
updatedAt: 2026-05-31T02:37:25.662Z
---

## Summary

Final task (T5) of the real-corpus dogfood follow-up. Shipped on branch
`fix/minimal-diff-frontmatter`, commit **ca07a6d** ("fix(knowledge): minimal-diff
frontmatter write on update (T5)"). With T5 done, the whole T1–T11 follow-up is complete.

## The bug

Editing one field via `knowledge update` rewrote the WHOLE frontmatter. A
block-style list (`tags:\n  - a`) collapsed to flow (`tags: [a]`), quotes were
stripped from colon-titles (`title: "API: Design"` → `title: API: Design`), and
custom (extra) frontmatter fields were reordered — a huge diff that reads like
data loss.

## Root cause

`serializeMarkdown` (src/knowledge/markdown.ts) always wrote arrays as flow
`[a, b]` and scalars bare, while `parseMarkdown` ALSO accepts block-style lists
and quoted values. So the first in-place `update` of any block-style / quoted /
custom-ordered file canonicalized everything. See [[markdown-frontmatter-serialization-custom-yaml-parser]].

## Fix — raw line-patch scoped to `repo.update`

1. `serializeFrontmatterValue(value)` extracted from `serializeMarkdown` (array →
   `[a, b]`, else `String(value)`) so the full-write and minimal-write paths agree
   byte-for-byte. `serializeMarkdown` behavior is unchanged.
2. `patchFrontmatter(raw, changes)` rewrites only the changed keys' lines and
   returns `null` — the signal to fall back to full serialize — UNLESS every
   frontmatter line is a simple single-line `^[A-Za-z0-9_]+:` entry AND every
   changed key is present. That `null` guard is what keeps block-style / external
   corpora safe. The body is preserved byte-identical.
3. `FileSystemKnowledgeArticleRepository.update` (via `tryMinimalDiffWrite`) takes
   the patch path only when the slug is unchanged. It writes only the frontmatter
   lines whose serialized value differs from on-disk, plus `updatedAt`. It falls
   back to full serialize when: the slug changed (rename — the filename changes
   anyway), the file is not in primary (worktree fallback), it does not parse, the
   BODY changed (the body is written verbatim, so a content edit is not a
   frontmatter diff — this is what keeps the concurrent-update races test green),
   or `patchFrontmatter` declined.

`parseMarkdown` read behavior was NOT changed. The rename path (`writeWithSlug`)
stays on full serialize.

## Reality check (important for future agents)

This repo's OWN corpus is already flow-style / canonical, so the dramatic symptom
is NOT reproducible on real data here — it only bites external corpora. Do not
expect the live corpus to show churn. The fix is proven by byte-level unit tests
on fixtures, not by the live corpus.

## Evidence

- Unit (TDD red→green): `tests/unit/knowledge/markdown.test.ts` (+11:
  `serializeFrontmatterValue`, `patchFrontmatter`) and new
  `tests/unit/knowledge/file-repository-minimal-diff.test.ts` (+3: byte-level
  single-tag edit touches only `tags`+`updatedAt` with a quoted colon-title and
  body byte-identical; block-style falls back without crashing; custom field
  survives in place). The RED run confirmed the old full-serialize churned the
  title (`[2,5,9]` vs `[5,9]`) and reordered the custom field.
- End-to-end (real CLI, external-shaped seed): `knowledge update <id> --add-tag`
  on a seeded quoted-colon-title + pre-`category` custom field → diff shows ONLY
  `tags` + `updatedAt`; title quotes and custom-field position preserved.
- Gate: `pnpm typecheck` 0, `pnpm lint` 0, `pnpm test` 2044 passed / 150 files,
  `monsthera lint` exit 0, `monsthera doctor` exit 0 (no corpus regression).
