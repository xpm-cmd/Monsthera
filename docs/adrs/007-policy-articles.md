# ADR-007: Knowledge-Driven Policy Articles

**Status:** Accepted
**Date:** 2026-04-24
**Decision makers:** Architecture team

## Context

Through ADR-006 the guard layer is still pure TypeScript: adding a new rule — for example "features that touch authentication require a security contribution before implementation" — means editing `src/work/guards.ts`, writing a migration if the rule is template-specific, and cutting a new release. The knowledge base, by contrast, is purely descriptive: articles capture "how things work" but cannot dictate what must happen next. The orchestrator plans and executes waves based only on hard-coded guards.

The 4-session orchestration plan calls this out as Gap B ("guards are code, not knowledge") and Gap C ("knowledge is purely descriptive"). Session 1 addresses both by letting a knowledge article *gate* work article transitions — turning the knowledge base into a prescriptive control plane that teams can author without shipping code.

## Decision

Introduce a reserved knowledge category `policy`. A policy article declares, via flat frontmatter fields, which templates and transitions it applies to, what content in the work article triggers it, and what must be satisfied before the transition is allowed. A new `PolicyLoader` service reads and validates these articles; a new `policy_requirements_met` guard composes the `requires` checks into the existing guard evaluation pipeline. No schema change, no TypeScript edit, no redeploy is needed to add or change a policy.

### Shape

A policy is a knowledge article with `category: policy` and the following flat frontmatter fields (all optional):

```yaml
---
id: k-xxx
category: policy
slug: policy-feature-auth-requires-security
title: "Policy: features touching auth require security enrichment"
tags: [policy, security]
policy_applies_templates: [feature]
policy_phase_transition: enrichment->implementation
policy_content_matches: ["(?i)auth|oauth|session|token"]
policy_requires_roles: [security]
policy_requires_articles: []
policy_rationale: "Compliance requires a security signoff on auth surfaces."
createdAt: 2026-04-24T00:00:00Z
updatedAt: 2026-04-24T00:00:00Z
---
(Prose expanding on the rationale — audit trail for future readers.)
```

Semantics:

- `policy_applies_templates` — array of `WorkTemplate` values. Omitted = applies to every template.
- `policy_phase_transition` — `"<from>-><to>"`. Omitted = applies to every non-`planning->enrichment` transition the guard set evaluates.
- `policy_content_matches` — array of regex patterns tested against `WorkArticle.content`. `(?i)` prefix is accepted as a POSIX-style case-insensitive flag and translated to the JavaScript `i` flag. Omitted = content is not inspected.
- `policy_requires_roles` — enrichment roles that must reach `contributed` or `skipped` status. Empty/omitted = no role required.
- `policy_requires_articles` — article IDs that must appear in the work article's `references`. Empty/omitted = no reference required.
- `policy_rationale` — one-line summary for the wiki index. Richer context goes in the article body.

The rest of the frontmatter follows the standard knowledge-article schema.

### Wiring

- `src/work/policy-loader.ts` (new) — `PolicyLoader` caches policies, refreshes on demand, and exposes a pure `getApplicablePolicies(policies, article, transition)` filter. Malformed policies are logged and skipped — one bad article cannot disable the orchestrator.
- `src/work/guards.ts` — adds `policy_requirements_met(article, { policies })` and a sibling `getPolicyViolations` that returns a structured per-policy breakdown for readiness reports.
- `src/work/lifecycle.ts` — `getGuardSet(article, from, to, deps?)` gains an optional `deps: { policies, applicablePolicyFilter }`. When present, policies filter down to those that apply and get appended as a `policy_requirements_met` guard. `planning->enrichment` is excluded by design — there is not enough content to match against.
- `src/orchestration/service.ts` — optionally takes a `PolicyLoader`. When wired, it loads policies once per readiness check and passes them into `getGuardSet` for every call site (`evaluateReadiness`, `planWave`).
- `src/core/container.ts` — instantiates `PolicyLoader` and injects it into `OrchestrationService` as part of the default wiring.
- `src/knowledge/wiki-bookkeeper.ts` — renders the `policy` category as a Markdown table in `knowledge/index.md` so auditors can scan the active control plane at a glance.

### Frontmatter carrier: `extraFrontmatter`

The plan's draft shape uses nested YAML (`applies_to: { template: [feature] }`). The current markdown parser (`src/knowledge/markdown.ts`) supports only flat key/value and top-level arrays — nested objects silently collapse. Rather than expand the parser (and risk behavioral drift for existing articles), this ADR adopts a **flat `policy_*` prefix** convention. The semantics are identical; only the notation changes.

To carry these extra fields through the repo without modifying `ArticleFrontmatterSchema`, `KnowledgeArticle` gains an optional `extraFrontmatter?: Readonly<Record<string, unknown>>` passthrough. The file repository collects any non-standard frontmatter keys on read and re-serialises them on write. This unlocks future category-specific extensions (provenance, per-article versioning) without further schema churn.

### Enforcement boundary

Policy guards fire at the orchestration-service layer: `evaluateReadiness`, `planWave`, and by extension `tryAdvance`. Direct use of `WorkArticleRepository.advancePhase` — an explicit escape hatch for internal flows — does not enforce policies, because the repo has no reason to depend on the knowledge layer. Treat direct repo advance the same way you treat `skipGuard`: allowed, auditable, but not the common path.

## Alternatives considered

- **A DSL file under `policies/*.yaml`.** Separate from knowledge, with its own loader. Rejected: policies *are* knowledge — "why does this rule exist" belongs next to "what is this domain" in the same searchable, embedded, cross-referenced corpus. Two stores diverge.
- **Make `category` an enum in Zod and hard-code `policy` as a special case.** Rejected: the plan explicitly chose to keep `category` free-form. Prescriptiveness belongs in the loader, not the transport.
- **Expand the markdown parser to support nested YAML.** Tempting but out of scope for Session 1 and risky for existing articles that may rely on the current flat behaviour. A future session can lift this restriction without invalidating any policies authored today.

## Consequences

Positive:

- Teams can declare orchestration rules by writing a Markdown file. Review is a PR on a `.md`, not on TypeScript.
- Policies live in the same wiki as the prose that motivates them. `knowledge/index.md` now doubles as an audit table of the active control plane.
- The same mechanism can be reused for future extensions: a `provenance: human|agent` frontmatter field, per-article version stamps, or other category-scoped metadata pass through `extraFrontmatter` unchanged.
- Migration path: the existing hard-coded guards (`min_enrichment_met`, `all_reviewers_approved`, etc.) can be moved into template-scoped policies over time. This ADR does not schedule that work — out of scope for Session 1.

Negative:

- Two layers of validation (Zod for standard frontmatter; `PolicyFrontmatterSchema` inside `PolicyLoader`) instead of one. A malformed policy article loads as a vacuous policy (never applies) with a log warning. This is intentional to keep single bad articles from disabling the orchestrator, but it means silent misconfiguration is possible — authors rely on reading the logs.
- The flat `policy_*` notation deviates from the plan's nested-YAML sketch. Anyone copy-pasting the plan example will need to translate it. Counterbalance: the flat form is easier for the existing parser to round-trip and for authors to write without worrying about indentation.
- Enforcement is orchestrator-scoped, not repo-scoped. Agents calling `advancePhase` directly bypass policy — an audit trail limitation that mirrors `skipGuard`.
