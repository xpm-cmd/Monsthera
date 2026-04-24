# ADR-012: Drift Prevention Closure (S5 PR B)

**Status:** Accepted
**Date:** 2026-04-25
**Decision makers:** Architecture team

## Context

ADR-010 and ADR-011 covered orchestrator ergonomics and CLI ergonomics — the
"first half" of what the Hedera v1 retrospective surfaced. S5 PR A then
added the anti-example registry, citation value-match, and verify density
checks (`token_drift`, `phrase_anti_example`, `citation_value_mismatch`,
`verify_density_exceeded`). The retrospective explicitly identified four
items that remained open after S5 PR A:

1. A way to detect that the `## Planning` section of a work article was
   edited silently after the article advanced past `planning`.
2. A way to refuse to run from the main repo when worktree isolation is
   required (an agent-safety issue surfaced multiple times during Hedera).
3. A managed pre-commit hook that runs `monsthera lint` against staged
   knowledge/work `.md` files, so drift is caught before it lands rather
   than in CI.
4. A design document that maps each drift class from the retrospective to
   the check that prevents it.

ADR-012 records the design choices behind those four items.

## Decision

Ship S5 PR B as four additive capabilities on top of the S5 PR A surface:

- `WorkArticle.planningHash` — captured on first exit from `planning`,
  cleared on rollback to `planning`, surfaced via the lint rule
  `planning_section_tampered` under the new `--registry planning-hash`
  filter (also runs under `--registry all`).
- `--assert-worktree` global flag and `MONSTHERA_REQUIRE_WORKTREE=true`
  env var. Exit code 2 distinguishes a worktree-policy refusal from
  a generic command failure. Exemptions: `install-hook`,
  `uninstall-hook`, `--help`, `--version`.
- `monsthera install-hook` and `uninstall-hook` subcommands. Husky-aware
  resolution order: `core.hooksPath` > `.husky/` > `<gitDir>/hooks/`.
  Worktree-aware: the hook lands in the main repo's git dir.
- `knowledge/notes/drift-prevention-design.md` — single design doc that
  maps the six drift classes from the retrospective to the seven checks
  that ship across S5 PR A and B.

### Planning-hash is signal, not gate

The hash is computed and persisted at advance time, but a mismatch does
not block subsequent advances. The reasoning:

- A hash mismatch after a deliberate rebase is the common case during
  active enrichment. Hard-gating would surface false positives and push
  authors to bypass the check entirely.
- Surfacing the mismatch via `monsthera lint` keeps the signal visible
  in CI and in the pre-commit hook without forcing a flow break at
  advance time.
- The lint rule emits an `error`-severity finding (exit 1), so the
  signal still bites where it matters: anything that runs lint as a
  gate (CI, the hook) blocks merge / commit.

Alternatives considered and rejected:

- **Auto-block `work advance` on mismatch.** Rejected because of the
  rebase false-positive rate. Authors would learn to bypass via
  `--skip-guard` and the audit trail would be noisier than helpful.
- **Auto-clear hash on every transition.** Rejected because the rule
  becomes trivial to defeat — any forward edit followed by an advance
  would silently re-pin the wrong content.

### Worktree assert is opt-in

`--assert-worktree` defaults off. The retrospective showed that agents
operating in a Cowork session benefit from the assert, while a developer
running `monsthera lint` from the main repo for a one-off check should
not be blocked. Setting the env var once in an agent session's `.envrc`
gives the agent the safety without forcing the human path through the
same gate.

### Hook installer is husky-aware

The Monsthera self-repo (and at least one downstream consumer) uses
husky 9, which sets `core.hooksPath` to `.husky/_/`. A naive installer
that writes to `.git/hooks/pre-commit` would be silently inert after
the next `pnpm install`. Resolution order chosen:

1. Respect `core.hooksPath` if set (husky 9, manual `git config`, etc.).
2. Use `.husky/pre-commit` if `.husky/` exists (matches husky 9 idiom
   even before the user's first `husky install` run).
3. Fall back to `<gitDir>/hooks/pre-commit` (classic; resolves to the
   main repo's git dir when invoked from a worktree).

The installed hook auto-detects whether the containing repo is the
Monsthera self-repo (or any consumer that lists `monsthera` as a
devDep) and writes `pnpm exec monsthera lint` instead of bare
`monsthera`, so the hook works without a globally-installed binary.

## Consequences

- The lint surface gains one new rule (`planning_section_tampered`) and
  one new `--registry` filter value (`planning-hash`). Existing
  consumers see the new rule under `--registry all` (the default).
- `WorkArticle` gains an optional field. The filesystem repository
  round-trips it as `planning_hash` in flat frontmatter; absence is
  treated as "not yet pinned" rather than "drift detected", so the
  pre-existing corpus does not flip to error on first scan.
- `src/bin.ts` grows from a 6-line wrapper to ~45 lines that handle
  the `--assert-worktree` early check before container construction.
- A new subcommand pair (`install-hook`, `uninstall-hook`) is exposed
  on the CLI surface. Both are exempt from `--assert-worktree` because
  their legitimate use case is to run from the main repo.
- ADR-012 closes the bookend started by ADR-010 and ADR-011. The next
  ADR (ADR-013, when needed) starts a new track.

## Cross-references

- ADR-010 — orchestrator ergonomics, canonical-values lint, ref graph.
- ADR-011 — CLI ergonomics, structured `phase_history` metadata.
- `knowledge/notes/drift-prevention-design.md` — six-class drift model.
- `knowledge/notes/anti-example-registry.md` — registry seed.
- `knowledge/notes/demo-drift-hedera.md` — deliberate demo article used
  to smoke-test the hook end-to-end.
