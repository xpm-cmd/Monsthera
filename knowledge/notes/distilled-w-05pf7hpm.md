---
id: k-thm5ixw2
title: Solution: Wave F: backlog opcional — Dolt smoke real, CLI coverage, ratchet, ADR-021, per-commit codeRefs
slug: distilled-w-05pf7hpm
category: solution
tags: [wave-f, distilled]
codeRefs: []
references: [w-05pf7hpm]
createdAt: 2026-06-11T06:10:56.010Z
updatedAt: 2026-06-11T06:10:56.010Z
origin: distilled
distilled_from: w-05pf7hpm
---

> Distilled from work [w-05pf7hpm] on completion. Origin: `distilled`.

## Objective

Los 5 items del backlog opcional de la auditoría (k-3zo9w9dg, Wave F del handoff), autorizados por el usuario el 2026-06-11 ("dale con 1 2 y 3").

## Acceptance Criteria

- F2 coverage CLI + F3 ratchet → PR #170 (lint-commands 0.97→57.3%, hook-commands 2.29→73.6%; floors 72/80/61→74/82/62). ✅
- F1 smoke Dolt real + F4 ADR-021 → PR #171 (el smoke encontró un bug real de id en su primer contacto; fix incluido). ✅
- F5 per-commit codeRefs → PR #172 (último deferred de M3 cerrado; aceptación real en clon scratch). ✅
- Notas solution por PR (k-jvccuix2, k-aua5adqn, k-p4f05mkz). ✅

## Cierre

Registrado retroactivamente al cierre (las waves A-E tuvieron registro previo; F corrió directo por el momentum del merge-as-you-go). Todo mergeado a main; eval final estable (NDCG 0.8948 / MRR 0.8929 / contamination 0.7273 — drift de centésimas por las 3 notas nuevas en el corpus, mismo orden que el baseline C1).
