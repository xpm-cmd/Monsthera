---
id: k-qti3v876
title: Work phase history and skipped-guard audit trail
slug: work-phase-history-and-skipped-guard-audit-trail
category: context
tags: [work, phase-history, audit-trail, guards, lifecycle]
codeRefs: [src/work/phase-history.ts, src/work/repository.ts, src/work/service.ts, src/work/lifecycle.ts, src/orchestration/service.ts, src/work/in-memory-repository.ts]
references: [adr-002-work-article-model, monsthera-work-article-design, work-article-guard-system, wave-planning-and-execution-system]
createdAt: 2026-04-18T07:40:31.085Z
updatedAt: 2026-04-18T07:40:31.085Z
---

## Overview

Work articles are not just stored with a current phase; they also carry an audit trail of how they got there. `phaseHistory` is the durable record of each phase entry, optional exit, and any justification attached to a bypassed guard or cancellation.

This article connects the work model from [[adr-002-work-article-model]] with the operational checks in [[work-article-guard-system]] and [[wave-planning-and-execution-system]].

## The data shape

Each phase-history entry records at least:

- `phase`
- `enteredAt`
- optionally `exitedAt`
- optionally `reason`
- optionally `skippedGuards`

The latest open entry is closed when a work article advances, and a new entry is appended for the destination phase.

## Dedicated history builders

`src/work/phase-history.ts` exists to keep reason formatting deterministic.

- `buildAdvanceHistoryEntry()` records a reason only when a guard was explicitly skipped
- `buildCancellationHistoryEntry()` merges cancellation reasons with skip-guard reasons when both exist

That means downstream tooling can recover whether a phase change was normal, force-advanced, or cancelled with a justification trail.

## Where history is written

The write path is shared across repository/service implementations:

- lifecycle validation comes from `checkTransition()` in `src/work/lifecycle.ts`
- repositories update the current open history entry and append a new one
- services/orchestration wrap that transition with higher-level behavior such as event logging and readiness planning

The important nuance is that phase history is not a reporting afterthought. It is written at the same moment the phase changes, which makes it trustworthy as an audit trail.

## Why skipped-guard reasons matter

A skipped guard is an operational exception. Recording it directly in phase history gives three benefits:

- reviewers can see that a move was exceptional
- orchestration/debugging tools can explain how an article reached its current phase
- postmortems can distinguish valid fast-tracks from silent state corruption

## Documentation guidance

When you document lifecycle behavior, avoid describing only the happy path. The real model includes exception metadata, and that is part of what makes Monsthera's work contracts auditable rather than merely stateful.