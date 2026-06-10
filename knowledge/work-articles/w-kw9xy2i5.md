---
id: w-kw9xy2i5
title: PR P0 — audit hardening: README status, dashboard auth GET, SDK bump, coverage ratchet
template: bugfix
phase: done
priority: high
author: claude-code
tags: []
references: []
codeRefs: []
dependencies: []
blockedBy: []
createdAt: 2026-06-10T08:15:27.894Z
updatedAt: 2026-06-10T11:11:36.219Z
enrichmentRolesJson: {"items":[{"role":"testing","agentId":"claude-code","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-06-10T08:15:27.894Z","exitedAt":"2026-06-10T11:10:59.868Z"},{"phase":"enrichment","enteredAt":"2026-06-10T11:10:59.868Z","exitedAt":"2026-06-10T11:11:11.722Z","reason":"single-session audit wave; PR #143 merged to main 2026-06-10","skippedGuards":["has_objective","has_acceptance_criteria"]},{"phase":"implementation","enteredAt":"2026-06-10T11:11:11.722Z","exitedAt":"2026-06-10T11:11:21.888Z","reason":"solo-agent session; testing enrichment unstaffed — TDD evidence in PR #143 (merged)","skippedGuards":["min_enrichment_met"]},{"phase":"review","enteredAt":"2026-06-10T11:11:21.888Z","reason":"review ocurrió en GitHub PR #143 (CI verde + owner merge)","skippedGuards":["implementation_linked"],"exitedAt":"2026-06-10T11:11:36.219Z"},{"phase":"done","enteredAt":"2026-06-10T11:11:36.219Z","reason":"merged a main como PR #143 el 2026-06-10; gate completo verde (2222 tests, 0 high vulns) — cierre dogfood","skippedGuards":["all_reviewers_approved"]}]}
completedAt: 2026-06-10T11:11:36.219Z
---

Wave 1 de la auditoría 2026-06-10 (ver k-3zo9w9dg). Rama `fix/p0-audit-hardening`. Cuatro fixes:

1. README sección Status: dice v3.0.0-alpha.4 + "convoy not implemented" — falso desde abril; corregir a v3.0.0 estable y reflejar dispatch/convoys shippeados (ADR-008/009/013).
2. Dashboard auth: quitar GET de AUTH_EXEMPT_METHODS (src/dashboard/auth.ts:8) — todo /api/* requiere Bearer token salvo health/status; OPTIONS sigue exento (preflight). Validar MONSTHERA_HOST loopback-only salvo override explícito MONSTHERA_ALLOW_NONLOCAL_HOST=true.
3. Bump @modelcontextprotocol/sdk ^1.27.1 → ^1.29.0 (+overrides mínimos si quedan highs transitivos): 23 vulns (3 high) en pnpm audit.
4. Coverage ratchet: thresholds vitest a la realidad (lines 72, branches 61, functions 80), CI coverage deja de ser report-only; añadir gate `pnpm audit --prod --audit-level high` al CI.

Gate de verificación: typecheck 0 · eslint 0 · pnpm coverage exit 0 · tsx src/bin.ts lint exit 0 · audit high exit 0. TDD en el fix de auth.