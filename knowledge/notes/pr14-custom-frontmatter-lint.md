---
id: k-eiv217in
title: PR-14b: Custom-frontmatter lint family (ADR-020 P3)
slug: pr14-custom-frontmatter-lint
category: solution
tags: [m3, pr-14, custom-frontmatter, lint, policy, adr-020]
codeRefs: [src/work/lint.ts, src/work/policy-loader.ts, src/cli/lint-commands.ts, tests/unit/work/lint-custom-frontmatter.test.ts, tests/unit/work/policy-loader-custom-frontmatter.test.ts]
references: [pr14-custom-frontmatter-query, pr9-contradiction-detection]
createdAt: 2026-05-31T11:11:24.284Z
updatedAt: 2026-05-31T11:11:24.284Z
---

Closes **gap 3 of ADR-020**: custom frontmatter is now *validated*. Second of the two PRs splitting the handoff's PR-14. **ADR-020 is now fully closed** (P1 authoring = PR-4, P2 query = PR-14a, P3 validation = this).

## What shipped (main @ 5ae9296, PR #139)
A `custom-frontmatter` lint family, mirroring PR-9's contradictions ("compute policy in PolicyLoader, apply per-article in scanCorpus" — see [[pr9-contradiction-detection]]).

- **`PolicyLoader`**: `CustomFrontmatterRule` type + `CustomFrontmatterRuleSchema` + `policy_custom_frontmatter_json` key + `getCustomFrontmatterRules()`. Same JSON-string detour + log-and-skip model as canonical-values (ADR-010). Rule shape: `{ category, key, required, type?, min?, max?, severity }`.
- **`src/work/lint.ts`**: `CustomFrontmatterFinding` joins the `LintFinding` union; `"custom-frontmatter"` joins `LintRegistry`; `LintScanInput.customFrontmatterRules`; a `runCustomFrontmatter` gate; per-article `scanCustomFrontmatter`. Frontmatter values arrive **pre-coerced** by the markdown parser (`markdown.ts` coerces `true`/numbers), so the type check is a direct `typeof`.
- **`lint-commands.ts`**: loads rules, passes to scanCorpus, formatter case, `VALID_REGISTRIES` + help.

## Design notes
- **Severity defaults to warning** (does not gate the pre-commit exit code, like `tag_near_duplicate`/`contradiction`); a policy rule may raise an individual check to `error`.
- **Inert until a policy declares rules** — the real corpus lints clean (0 findings); `custom-frontmatter` only activates when a `category: policy` article carries `policy_custom_frontmatter_json`.
- The exhaustive `switch (f.rule)` in the formatter forced the new case at compile time — a missing case is a `tsc` error, not a silent gap.

## Verification
`pnpm test` 2189 → 2202 (+13: scanCorpus family 7, PolicyLoader loader 5, integration acceptance 1 spawning the real CLI). `typecheck`/`eslint`/`monsthera lint` corpus 0. Lint-only — `monsthera eval` unchanged.

Continues [[pr14-custom-frontmatter-query]]. NEXT: PR-15 git/PR ingestion (last M3 item).