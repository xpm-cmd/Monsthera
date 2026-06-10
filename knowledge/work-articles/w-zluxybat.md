---
id: w-zluxybat
title: PR P1 — eval keystone: expansión del golden set + honestidad semántica
template: feature
phase: done
priority: high
author: claude-code
tags: []
references: []
codeRefs: []
dependencies: []
blockedBy: []
createdAt: 2026-06-10T08:15:34.792Z
updatedAt: 2026-06-10T11:11:23.727Z
enrichmentRolesJson: {"items":[{"role":"architecture","agentId":"claude-code","status":"pending"},{"role":"testing","agentId":"claude-code","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-06-10T08:15:34.792Z","exitedAt":"2026-06-10T11:10:36.009Z"},{"phase":"enrichment","enteredAt":"2026-06-10T11:10:36.009Z","exitedAt":"2026-06-10T11:11:00.094Z","reason":"single-session audit wave (dynamic workflow); PR #144 merged to main 2026-06-10","skippedGuards":["has_objective","has_acceptance_criteria"]},{"phase":"implementation","enteredAt":"2026-06-10T11:11:00.094Z","exitedAt":"2026-06-10T11:11:13.208Z","reason":"solo-agent session; enrichment roles not staffed — work shipped and merged (#144)","skippedGuards":["min_enrichment_met","snapshot_ready"]},{"phase":"review","enteredAt":"2026-06-10T11:11:13.208Z","reason":"review ocurrió en GitHub PR #144 (CI verde + owner merge)","skippedGuards":["implementation_linked"],"exitedAt":"2026-06-10T11:11:23.727Z"},{"phase":"done","enteredAt":"2026-06-10T11:11:23.727Z","reason":"merged a main como PR #144 el 2026-06-10; gate completo verde (2235 tests) y eval discriminando — cierre dogfood","skippedGuards":["all_reviewers_approved"]}]}
completedAt: 2026-06-10T11:11:23.727Z
---

Wave 2 de la auditoría 2026-06-10 (ver k-3zo9w9dg). Rama `feat/p1-eval-honesty` (desde main, independiente de P0).

1. Expandir golden set: de 7 casos × 1 esperado a 20-30 casos con queries multi-relevantes (3-5 expectedArticleIds), casos negativos (forbiddenArticleIds o equivalente), default k=10 en eval-commands; regenerar tests/eval/baseline.json. Hoy P@5 está clavado en 0.2 y NDCG/MRR saturados en 1.0 — el arnés no detecta ni mejoras ni regresiones.
2. Honestidad semántica: el eval del 2026-06-10 corrió 100% sobre BM25 (Ollama caído) pero reportó semanticEnabled:true con métricas perfectas. Registrar engine real por query (semantic vs bm25-fallback) en el reporte de eval; exponer degradación viva en status; check de Ollama alcanzable en doctor cuando semanticEnabled.

Desbloquea los deferred: salience implementar-o-descartar, cf search-term emission, tuning de reranker — ninguno es medible con el arnés saturado.

Follow-ups FUERA de este PR: smoke test Dolt real, coverage de CLI commands.