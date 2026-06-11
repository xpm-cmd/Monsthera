---
id: k-r51xph09
title: Decisión C2: salience (PR-13b) descartado para siempre — inmedible por construcción y contraindicado por la evidencia de C1
slug: decisin-c2-salience-pr-13b-descartado-para-siempre-inmedible-por-construccin-y-contraindicado-por-la-evidencia-de-c1
category: decision
tags: [wave-c, salience, ranking, decision, deferred-closed]
codeRefs: [src/search/service.ts, src/core/runtime-state.ts, tests/eval/baseline.json]
references: [k-73ofos2z, k-3zo9w9dg]
createdAt: 2026-06-10T12:35:03.265Z
updatedAt: 2026-06-10T12:35:03.265Z
---

Cierra el deferred PR-13b (salience bonus en ranking, diferido en M3 por "eval saturado"; cero código en src — verificado `grep -rn salience src tests` vacío). El contrato era implementar-o-descartar con el golden set como juez. **Decisión: DESCARTAR, permanentemente.** No se escribió código: el resultado de la medición está determinado por la arquitectura del eval, no por la implementación — construir para medir un 0 estructural sería cargo-cult.

## Tres razones, en orden de peso

### 1. Inmedible por construcción con el juez pactado

El diseño original: contar apariciones de artículos en context packs (`core/runtime-state.ts`) y aplicar bonus log-amortiguado + cap en `scoreContextPackItem`. Pero el golden set (28 casos) corre **stateless y reproducible por diseño**: en una corrida limpia el contador de salience es vacío → el bonus es 0 para todos → **delta de NDCG/MRR/contamination = 0 por construcción**. El criterio del contrato ("mejora medible") es insatisfacible no por debilidad del mecanismo sino por incompatibilidad de categorías: salience es señal de USO acumulado; el eval mide relevancia query→documento sin historia. Simular uso que correlacione con los expected sería entrenar sobre el test set (circular). Mantener el eval stateless es correcto y no negociable (reproducibilidad del gate).

### 2. Contraindicado por la evidencia experimental de C1 (k-73ofos2z)

C1 demostró que el colapso semántico (NDCG 0.098) fue causado por **boosts aditivos query-independientes dominando la señal de búsqueda** (ADR soup: 15 artículos en 60-82% de todos los top-10). Salience es exactamente esa familia: otro término aditivo query-independiente sobre `scoreContextPackItem`. Aun log-amortiguado, capeado y default-off, es deuda de calibración en la zona donde acabamos de pagar el incidente más caro del sistema de retrieval.

### 3. Amplificaría la regresión abierta de contaminación

Salience es feedback rich-get-richer: lo que aparece en packs gana bonus → aparece más. La regresión conocida post-C1 es contamination 0.7273 (notas superseded-pero-temáticas surfaceando por similitud). Un bonus de popularidad boostearía precisamente las notas viejas más consultadas históricamente — empujando CONTRA la palanca pendiente (demotion por vigencia).

## Qué tendría que cambiar para reabrir esto

Una propuesta NUEVA (no este deferred) con: (a) evaluación offline sobre **sesiones reales loggeadas** (replay de queries de producción con juicios de utilidad), no el golden set; (b) mecanismo multiplicativo/rank-based en vez de aditivo (lección C1); (c) decay temporal explícito que no contradiga la demotion por vigencia. Mientras no exista esa infraestructura de medición, cualquier salience es un knob inmedible.

## Efecto

El deferred PR-13b sale de todas las listas de pendientes. Las menciones en `docs/handoff-m2/m3-*.md` y k-3zo9w9dg quedan como registro histórico (no se editan); esta nota es la resolución canónica.