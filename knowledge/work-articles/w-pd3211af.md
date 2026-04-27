---
id: w-pd3211af
title: fix: dashboard wildcard CORS + token in <meta> enables CSRF
template: bugfix
phase: done
priority: critical
author: audit-claude
tags: [security, dashboard, cors, csrf, audit-2026-04-26]
references: []
codeRefs: []
dependencies: []
blockedBy: []
createdAt: 2026-04-26T11:31:07.099Z
updatedAt: 2026-04-27T10:25:36.383Z
enrichmentRolesJson: {"items":[{"role":"testing","agentId":"audit-claude","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-04-26T11:31:07.099Z","exitedAt":"2026-04-27T10:25:28.745Z"},{"phase":"enrichment","enteredAt":"2026-04-27T10:25:28.745Z","exitedAt":"2026-04-27T10:25:31.288Z","reason":"audit batch closure","skippedGuards":["has_objective","has_acceptance_criteria"]},{"phase":"implementation","enteredAt":"2026-04-27T10:25:31.288Z","exitedAt":"2026-04-27T10:25:33.894Z","reason":"audit batch closure","skippedGuards":["min_enrichment_met"]},{"phase":"review","enteredAt":"2026-04-27T10:25:33.894Z","reason":"audit batch closure","skippedGuards":["implementation_linked"],"exitedAt":"2026-04-27T10:25:36.383Z"},{"phase":"done","enteredAt":"2026-04-27T10:25:36.383Z","reason":"audit batch closure","skippedGuards":["all_reviewers_approved"]}]}
completedAt: 2026-04-27T10:25:36.383Z
---

## Issue

The dashboard HTTP server returns `Access-Control-Allow-Origin: *` for every response and exposes the auth bearer token in a `<meta name="monsthera-auth-token">` tag readable by any JS on the page. Combined, any other origin can mount a CSRF/XSS attack against the localhost dashboard if a hostile knowledge article (or any browser tab) is rendered.

## Scenario

1. A teammate sends a Markdown article with `<img src="http://localhost:3000/api/knowledge" onload="window.parent.postMessage(...)">` or similar.
2. The user opens the article in any preview that runs JS.
3. The wildcard CORS allows the cross-origin fetch; the token in `<meta>` is readable; mutations on the dashboard succeed.

Even without scripts, any web page the user visits can issue a CORS request to `localhost:3000` because of the wildcard.

## File / line

- `src/dashboard/index.ts:124-126` — wildcard `Access-Control-Allow-Origin: *`.
- `src/dashboard/index.ts:45-50` — auth token rendered into HTML.
- `src/dashboard/index.ts:135-139` — preflight handling.

## Impact

Any JS executed in the user's browser (compromised article, hostile dependency, malicious extension) can mutate workspace state through the dashboard API.

## Suggested fix

1. Restrict CORS: only allow `Origin: http://localhost:<configured-port>` and `null` (file://). Reject everything else.
2. Move the auth token from `<meta>` to an `HttpOnly` cookie; require both the cookie and a `X-Requested-With: monsthera-dashboard` header on mutating routes (double-submit pattern).
3. Add `SameSite=Strict` to whatever cookie is used.

## Validation

- Test: `curl -H "Origin: http://evil.example" http://localhost:3000/api/knowledge` returns no `Access-Control-Allow-Origin`.
- Test: mutating endpoints (`POST /api/knowledge`) reject when missing the header.
- Manual: dashboard still functions in a browser at `http://localhost:3000`.

## References

- Audit 2026-04-26, security finding #2.
