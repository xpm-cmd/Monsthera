---
id: k-policy-example-security
title: "Policy: feature articles touching auth require security enrichment"
slug: policy-example-security-enrichment
category: policy
tags: [policy, security, example]
codeRefs: []
references: []
policy_applies_templates: [feature]
policy_phase_transition: enrichment->implementation
policy_content_matches: [(?i)auth|oauth|session|token|credential]
policy_requires_roles: [security]
policy_requires_articles: []
policy_rationale: "Auth code crosses a trust boundary; security must review before implementation."
createdAt: 2026-04-24T00:00:00.000Z
updatedAt: 2026-04-24T00:00:00.000Z
---

# Policy: auth features require security enrichment

## What this policy enforces

A work article whose template is `feature` and whose body mentions authentication terms (`auth`, `oauth`, `session`, `token`, `credential`, case-insensitive) cannot advance from `enrichment` to `implementation` until the `security` enrichment role has `contributed` or explicitly `skipped`.

## Why

Authentication code crosses a trust boundary. A regression there is the kind of bug that shows up in post-mortems with an "impact: all users" header. Before the team commits to an implementation, a security reviewer needs to sign off on the design — scope of the session cookie, revocation path, credential handling, token lifetime.

A PR review once the code is written is too late: by that point the schema is already in a migration, and the contract with the client is already in a released app. Catching the design question at `enrichment` — the phase whose whole purpose is "bring in the roles you need" — is a net win for everyone.

## Escape hatch

An orchestrator operator with justification can still advance the article using `skipGuard: { reason }` on `advancePhase`. The bypass is recorded in `phaseHistory.skippedGuards` with the reason, so the audit trail survives the shortcut. Use this for genuine emergencies (a hotfix on a dependency bump, for example), not to route around review.

## Replacing this policy

Edit this file. The `PolicyLoader` picks up changes on the next readiness check — no build, no redeploy. Broaden the regex to cover more auth-adjacent code (WebAuthn, passkeys), tighten the template list, or add `architecture` to the required roles as the domain grows.

See [`docs/adrs/007-policy-articles.md`](../../docs/adrs/007-policy-articles.md) for the full frontmatter spec.
