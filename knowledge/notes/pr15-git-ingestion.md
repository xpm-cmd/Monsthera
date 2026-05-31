---
id: k-gu0h02zt
title: PR-15: Git/PR history ingestion (M3 close)
slug: pr15-git-ingestion
category: solution
tags: [m3, pr-15, ingest, git, provenance, cli, mcp]
codeRefs: [src/ingest/service.ts, src/sessions/facts-extractor-git.ts, src/ingest/schemas.ts, src/cli/ingest-commands.ts, src/tools/ingest-tools.ts]
references: [pr14-custom-frontmatter-lint, pr13-provenance]
createdAt: 2026-05-31T11:15:29.737Z
updatedAt: 2026-05-31T11:15:29.737Z
---

Final PR of **M3**. Ingests git history into knowledge — one article per commit with provenance `origin: ingested` ([[pr13-provenance]]) and `sourcePath: git:<sha>`, so commits become searchable / `build_context_pack`-able.

## What shipped (main @ e3ce2dc, PR #140)
- **`src/sessions/facts-extractor-git.ts`**: `listCommitsInRange` — range-based sibling of the date-windowed `listCommitsInWindow` (shared `parseCommitLines` extracted, behavior preserved). A git failure returns `err` so a **bad range surfaces** (vs the window helper's non-fatal `ok([])`, which suits session facts but not user-driven ingestion).
- **`IngestService.importGitHistory(range)` + `importPr(prNumber)`**:
  - One article per commit. **Slug `git-<sha>`** (the commit hash) guarantees uniqueness — identical commit subjects would otherwise collide on the title→slug path.
  - **Idempotent** via the `sourcePath` dedup reused from `importLocal`: re-ingesting a range updates rather than duplicates.
  - `importPr` resolves the GitHub merge commit (`git log --grep="Merge pull request #N "`) then ingests `<merge>^1..<merge>^2`. Pure git, no GitHub API. **Limitation:** merge-committed PRs only (squash/rebase leave no marker).
  - A `CommandRunner` is injected into `IngestServiceDeps` (default `realCommandRunner`) so git is stubbable in tests — the same pattern `facts-extractor-git` uses.
- **CLI** `monsthera ingest git --range <r> | --pr <n>`; **MCP tool** `ingest_git_history` (`range` XOR `prNumber`, agent-native parity).

## Gotcha / design
- Frontmatter scalar coercion: irrelevant here (we author content), but the article carries `category: git-history`, `tags: [ingested, git]`, `codeRefs: []` (v1 — per-commit file grounding is a follow-up).
- `--pr` tags articles `pr-<n>` so a PR's commits are findable as a group.

## Verification
`pnpm test` 2202 → 2213 (+11). `typecheck`/`eslint`/`monsthera lint` corpus 0. **Acceptance smoke** (throwaway temp repo, zero real-corpus pollution): a real `git log` range produced an `origin: ingested` article that `monsthera search` found (score 1.695).

## M3 COMPLETE
PR-13a provenance · PR-14a/b custom-frontmatter query+lint (**ADR-020 fully closed**) · PR-15 git ingestion. `monsthera eval` held at NDCG@5 1.0 / MRR 1.0 / P@5 0.2 throughout. Deferred with rationale: salience (PR-13b, saturated eval), custom-frontmatter search-term emission (tokenizer constraint). Continues [[pr14-custom-frontmatter-lint]].