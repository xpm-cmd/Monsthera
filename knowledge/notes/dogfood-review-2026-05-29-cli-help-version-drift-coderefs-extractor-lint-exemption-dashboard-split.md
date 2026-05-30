---
id: k-yu5can16
title: Dogfood review (2026-05-29): CLI --help, version drift, codeRefs extractor, lint exemption, dashboard split
slug: dogfood-review-2026-05-29-cli-help-version-drift-coderefs-extractor-lint-exemption-dashboard-split
category: solution
tags: [dogfood, cli, lint, dashboard, code-review, version-drift]
codeRefs: []
references: []
createdAt: 2026-05-29T12:53:51.587Z
updatedAt: 2026-05-29T12:53:51.587Z
---

A dogfood review of Monsthera using its own CLI (`monsthera doctor|lint|code|status`) against the repo itself surfaced and fixed five issues. Branch `fix/cli-dogfood-review`, 5 commits on top of `eb1755c`.

## Shipped (all verified: typecheck 0, eslint 0, full suite 1989 passed / 146 files)

1. **F1 — `--help` ignored by 8 top-level CLI commands** (commit 09aad8e). `serve, dashboard, status, search, reindex, migrate, doctor, pack` ran their action on `--help` instead of printing usage (serve/dashboard would *start a server*; reindex actually reindexed). The command GROUPS already used `wantsHelp()` from `src/cli/help.ts`; these 8 handlers in `src/cli/main.ts` + `doctor-commands.ts` + `context-commands.ts` just never called it. Added the guard + a `printSubcommandHelp` block to each, plus a regression test (`tests/unit/cli/main.test.ts`) asserting every top-level command prints USAGE + exits 0 on `--help`/`-h`.

2. **F3 — version drift across FOUR sources of truth** (commit 687968e). `src/core/constants.ts` = `3.0.0-alpha.7`, `src/server.ts` MCP identity = `3.0.0-alpha.4`, `tsup.config.ts` dead `__MONSTHERA_VERSION__` define = `3.0.0-alpha.4`, `package.json` = `3.0.0`. `VERSION` now imports from package.json (tsc via resolveJsonModule, esbuild inlines at build — plain `import pkg from "../../package.json"` WITHOUT an import attribute, because `module: Node16` rejects `with { type: "json" }` at typecheck). server.ts uses VERSION; dead define removed. Verified `node dist/bin.js --version` → 3.0.0 and 0 alpha literals in the bundle.

3. **F7 — typecheck error hidden by transpile-only tests** (commit 687968e). `tests/unit/sessions/service.test.ts` used `Parameters<typeof SessionService>` on a CLASS; correct utility is `ConstructorParameters`. `tsc --noEmit` failed (exit 2) but `vitest run` stayed green because esbuild transpiles without type-checking. Lesson: CI must run `tsc --noEmit` as a separate gate; a green vitest run does NOT imply types check.

4. **F6 — transient/artifact paths persisted as codeRefs** (commit 5a4ed4a). `collectCodeRefs()` in `src/sessions/handoff-extractors.ts` kept any path-shaped token, so `/tmp/handoff-test.md`, `facts.json`, `*.facts.json`, and `handoff-ses-*.md` leaked into handoff `codeRefs[]`. Added `isTransientOrArtifactRef()` (prefix + basename patterns) after `isPathShaped()`. Pruned existing junk from the markdown via `doctor --fix-stale-code-refs`. Verified resolved: `doctor` reads markdown directly (`knowledgeRepo` is a `FileSystemKnowledgeArticleRepository`, container.ts:169), so once the markdown was pruned `monsthera doctor` reports `Total stale refs: 0`. (A suspected `findMany` vs `getArticle` read-path divergence was investigated and ruled out — both read the same markdown source; the apparent mismatch was a grep matching a `pnpm test …` command in article body prose, not a codeRef.)

5. **F5 — lint could never exit 0 on its own corpus** (commit ea4e4f9). Two articles legitimately embed wrong-form strings (the demo fixture + the drift design doc whose table documents each drift class). `scanCorpus()` in `src/work/lint.ts` now skips the content-drift rules (canonical-value + anti-example token/phrase) for articles tagged `lint-exempt` or `drift-sample`; planning-hash tamper detection still runs. `monsthera lint` now exits 0, making `install-hook` usable as a pre-commit gate.

6. **F9 — dashboard/index.ts 1613→1433 lines** (commit 9da4c98). Extracted self-contained HTTP plumbing (static serving, CORS, response/body helpers, error mapping) to `src/dashboard/http.ts` (210 lines), re-exporting `isAllowedDashboardOrigin` to preserve the public surface. Pure extraction; the 1260-line router split was deliberately left for a separate pass.

## Process lessons (recorded because they cost real time this session)
- The harness intermittently buffered/dropped Bash stdout; a background task's completion notification reliably flushed it. Prefer single non-hanging Bash calls; write results to a file and read scalar summaries.
- Several `Edit`/`Write` calls silently failed when the `old_string` was assumed rather than read from the actual file (e.g. a test file path that didn't exist, a `looksLikeCodeRef` function that wasn't the real shape). ALWAYS read the exact current bytes before editing; a vacuous test run against a nonexistent path looks like a pass. Verify the REAL artifact (real linter exit code, committed file contents), not a proxy.