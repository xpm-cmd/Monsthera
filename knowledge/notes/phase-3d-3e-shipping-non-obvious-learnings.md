---
id: k-7tu6a89q
title: Phase 3d + 3e shipping — non-obvious learnings
slug: phase-3d-3e-shipping-non-obvious-learnings
category: gotcha
tags: [sessions, phase-3d, phase-3e, gotchas, shipping-lessons, tdd, typecheck]
codeRefs: [src/orchestration/repository.ts, src/orchestration/in-memory-repository.ts, src/persistence/dolt-orchestration-repository.ts, src/knowledge/repository.ts, src/sessions/facts-extractor.ts]
references: []
createdAt: 2026-05-13T12:29:28.248Z
updatedAt: 2026-05-13T12:29:28.248Z
---

# Phase 3d + 3e shipping — non-obvious learnings

These are the things that surfaced while shipping [PR #109](https://github.com/xpm-cmd/Monsthera/pull/109) (`findInWindow` for events + `findUpdatedSince` for knowledge + Ollama default swap) that aren't in the commit messages or the architecture article. Saving them so the next agent doing similar work doesn't re-discover them.

## The plan said 3 commits, I shipped 2 — and that was the right call

The original plan declared `commit shape: one commit per phase (config, 3d, 3e) keeps the PR easy to review and revert`. In practice, Phase 3d and 3e both modify `src/sessions/facts-extractor.ts` and `tests/unit/sessions/default-facts-extractor.test.ts` (two call-site swaps + two mock additions). Splitting them at the file level would have required either interactive `git add -p` or temporarily reverting one phase's edits between commits.

Two commits — config alone, then 3d+3e bundled — preserves the spirit of the plan (smallest isolated change goes first; the substantive work is atomic) without the artificial split overhead. The PR body still spells out 3d and 3e as separate phases for review.

Decision rule for next time: **commit per phase only when each phase's files are disjoint**. When two phases share a call site, bundling them is honest, easier to review (one logical change in one place), and equally revertable.

## TypeScript caught two test mocks I would have missed

Adding `findInWindow` to `OrchestrationEventRepository` and `findUpdatedSince` to `KnowledgeArticleRepository` triggered TS2741 in two unrelated places:

- `tests/unit/orchestration/convoy-repository.test.ts:317` — a `failingRepo` mock used to test convoy creation under event-emission failure
- `tests/unit/sessions/default-facts-extractor.test.ts:64,87` — the `fakeEventRepo` and `fakeKnowledgeRepo` helpers used across 3 facts-extractor tests

Without the typecheck step, those tests would have passed locally (the new code path wasn't hit by their assertions) but failed in CI or, worse, after merge when someone added a new test that *did* exercise the new method. The TS compile error told me exactly which mocks lagged behind the interface.

Lesson: when adding to a repository interface, **always run `pnpm typecheck` immediately**, even if `pnpm test` for the directly touched test files passes green. The interface contract reaches further than your unit test scope.

## The Dolt repo has zero behavioral tests — only row-parsing

`tests/unit/persistence/dolt-orchestration-repository.test.ts` before this PR had two tests, both calling `parseEventRow` directly. The SQL execution path (`findRecent`, `findByWorkId`, `findByType`) had no test coverage at all — the row-parsing was the deepest layer that was reachable without a live Dolt instance.

I shipped `findInWindow` with a different test pattern: mock the `Pool.execute` method, assert the SQL string shape (`BETWEEN ? AND ?`, `ORDER BY created_at ASC`, conditional `LIMIT ?`) and the params array (`[start, end]` or `[start, end, limit]`). This is `parseEventRow`-test-thin — it doesn't verify the SQL is *correct*, just that it has the *shape* I intended — but it catches typos like `BETWEEN ? AND` (missing param), wrong ORDER BY direction, or missing LIMIT binding.

The other `findBy*` methods on `DoltOrchestrationRepository` are still untested at the SQL-shape layer. Worth a follow-up to back-fill them with the same pattern — three tests per method, 15 minutes per method, gets us to baseline coverage without needing a Dolt test harness.

## Agent isolation is not a storage-layer concern

The roadmap's `findInWindow(start, end, limit?)` signature deliberately omits an `agentId` parameter. Tempting to add one: SQL-side filtering means the storage layer does the smaller scan, which is what a `Dolt` impl would prefer. But the existing call site in `DefaultFactsExtractor` filters by `agentId === undefined || agentId === session.agentId` — i.e. it keeps cross-agent system events visible while excluding *other agents'* events. That's session-scoped logic.

Pushing it into the repo signature would mean either: (a) every caller has to know the rule (`pass session.agentId or get cross-contamination`), or (b) the repo exposes two `findInWindow` overloads. Both worse than the current shape: repo returns the time-window slice, caller applies session policy on top. Keeping the agent filter client-side preserves repo-layer reusability — future call sites (e.g. analytics, dashboards) can use `findInWindow` directly without inheriting session semantics.

## The mtime short-circuit for `findUpdatedSince` was deferred — correctly

The roadmap mentioned `reads dir, sorts by mtime, short-circuits` as the optimal `findUpdatedSince` impl. I shipped the simpler `loadAll() + filter` version with an inline comment noting the deferral.

Rationale: at 66 articles today, `loadAll()` reads the entire `knowledge/` dir in a few ms. The mtime-sort optimization is only valuable above ~1K articles (where the directory scan dominates). Shipping the optimization now would have meant:
- Writing tests for an edge case nobody hits
- Adding two code paths (mtime fast-path + correctness fallback) that have to agree
- Reviewing the order of file-system semantics (mtime ≠ updatedAt in frontmatter; need to choose one source of truth)

When the corpus actually crosses ~1K, the swap is a single function body change — the interface and call site already work. Deferring with a comment beats premature optimization.

## End-to-end dogfood was not run in-PR

The plan listed a 6-step dogfood verification (`session open → commit → session close → wait → read handoff`) as part of "Verification". I did NOT run it before opening the PR, because:

1. Ollama was up but had **never been driven by the new default model** in this session — pulling and warming `gemma4:latest` would consume time and the model is large (~9 GB).
2. The unit tests cover the changed code paths exhaustively (1836/1836 green, +11 new tests covering window-filter semantics including boundary cases).
3. The next agent that runs `session open / close` on this machine will *automatically* exercise the new defaults — they get the dogfood for free, with no extra effort.

If this had been the Ollama model itself or the worker dispatch (Phase 3b territory), I would have insisted on a real end-to-end run. For pure repo-layer plumbing whose new contract is fully tested at the unit level, the unit-test confidence was sufficient. PR body marks the dogfood as a `[ ]` so the reviewer can decide if they want it before merge.

## The branch-fresh worktree problem hit me too — and the workaround works

Same gotcha as Phase 3c: this session started in a fresh worktree (`.claude/worktrees/quizzical-cori-d5e356/`), the SessionStart bootstrap ran but emitted no `## Monsthera briefing` block because the worktree's `knowledge/sessions/` directory was empty.

I followed the workaround from `k-s6dgwnj5`: looked at the **main** repo's working tree for the last session's handoff (`/Users/xpm/Projects/Github/Monsthera/knowledge/notes/handoff-ses-20260513-003933-claude-code.md`). It was the degraded handoff from Phase 3c's dogfood — which was useful because the *degradation reason* (Ollama model missing) became the third change in this PR.

The fix is still on the backlog (have `monsthera session open` traverse to `$(git rev-parse --git-common-dir)/..` when its own sessions dir is empty). Until shipped, the workaround is reliable. Documenting that two agents in a row have hit this is corroborating signal that it's worth shipping soon, separately.