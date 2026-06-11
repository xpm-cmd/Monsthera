---
id: w-05pf7hpm
title: Wave F: backlog opcional — Dolt smoke real, CLI coverage, ratchet, ADR-021, per-commit codeRefs
template: feature
phase: done
priority: low
author: claude-code
tags: [wave-f]
references: [k-jvccuix2, k-aua5adqn, k-p4f05mkz]
codeRefs: []
dependencies: []
blockedBy: []
createdAt: 2026-06-11T06:10:29.779Z
updatedAt: 2026-06-11T06:10:55.822Z
enrichmentRolesJson: {"items":[{"role":"architecture","agentId":"claude-code","status":"pending"},{"role":"testing","agentId":"claude-code","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-06-11T06:10:29.779Z","exitedAt":"2026-06-11T06:10:52.035Z"},{"phase":"enrichment","enteredAt":"2026-06-11T06:10:52.035Z","exitedAt":"2026-06-11T06:10:53.296Z"},{"phase":"implementation","enteredAt":"2026-06-11T06:10:53.296Z","exitedAt":"2026-06-11T06:10:54.555Z","reason":"registro retroactivo al cierre: F2+F3 en PR #170, F1+F4 en #171, F5 en #172 — todos mergeados con gate completo y nota solution","skippedGuards":["min_enrichment_met","snapshot_ready"]},{"phase":"review","enteredAt":"2026-06-11T06:10:54.555Z","reason":"registro retroactivo al cierre: F2+F3 en PR #170, F1+F4 en #171, F5 en #172 — todos mergeados con gate completo y nota solution","skippedGuards":["implementation_linked"],"exitedAt":"2026-06-11T06:10:55.822Z"},{"phase":"done","enteredAt":"2026-06-11T06:10:55.822Z","reason":"registro retroactivo al cierre: F2+F3 en PR #170, F1+F4 en #171, F5 en #172 — todos mergeados con gate completo y nota solution","skippedGuards":["all_reviewers_approved"]}]}
completedAt: 2026-06-11T06:10:55.822Z
---

## Objective

Los 5 items del backlog opcional de la auditoría (k-3zo9w9dg, Wave F del handoff), autorizados por el usuario el 2026-06-11 ("dale con 1 2 y 3").

## Acceptance Criteria

- F2 coverage CLI + F3 ratchet → PR #170 (lint-commands 0.97→57.3%, hook-commands 2.29→73.6%; floors 72/80/61→74/82/62). ✅
- F1 smoke Dolt real + F4 ADR-021 → PR #171 (el smoke encontró un bug real de id en su primer contacto; fix incluido). ✅
- F5 per-commit codeRefs → PR #172 (último deferred de M3 cerrado; aceptación real en clon scratch). ✅
- Notas solution por PR (k-jvccuix2, k-aua5adqn, k-p4f05mkz). ✅

## Cierre

Registrado retroactivamente al cierre (las waves A-E tuvieron registro previo; F corrió directo por el momentum del merge-as-you-go). Todo mergeado a main; eval final estable (NDCG 0.8948 / MRR 0.8929 / contamination 0.7273 — drift de centésimas por las 3 notas nuevas en el corpus, mismo orden que el baseline C1).