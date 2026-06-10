---
id: k-hjc2eo08
title: PR-19: Lean symbol extraction en el code inventory (Banyan P2)
slug: pr-19-lean-symbol-extraction-en-el-code-inventory-banyan-p2
category: solution
tags: [banyan, code-intelligence, lean, inventory, consumer-driven]
codeRefs: [src/code-intelligence/inventory/lean-extractor.ts, src/code-intelligence/inventory/default-extractor.ts, src/code-intelligence/inventory/language-map.ts, src/code-intelligence/inventory/extractor.ts, tests/unit/code-intelligence/inventory/lean-extractor.test.ts]
references: [k-3zo9w9dg, k-7j6lirme]
createdAt: 2026-06-10T10:43:04.210Z
updatedAt: 2026-06-10T10:43:04.210Z
---

Cuarto fix consumer-driven Banyan. Rama `feat/banyan-p2-lean-inventory`. `code reindex` sobre el corpus Lean daba 0 archivos útiles — `.lean` sin soporte.

## Decisión de ruta: regex line-scan dedicado (NO TextMate)

Aunque `@shikijs/langs` trae gramáticas lean/lean4, se eligió un extractor regex (`lean-extractor.ts`, espeja `leanparse.py` del consumidor): la composición de FQNs necesita un stack `namespace … end` de todos modos (TextMate tokeniza, no anida), así que la gramática solo compraba tokenización a cambio de carga WASM y tuning de scopes sin vetar. Filosofía ADR-017 explícita: "lightweight inventory, regex is fine". Paridad semántica con el parser de referencia: decls ancladas a columna 0, comentarios de bloque con depth, `--` líneas, `end <name>` solo popea si matchea, identificadores primed/dotted, namespace dotted push.

## Mapeo de kinds (enum NO ampliado)

theorem/lemma/def/instance(named) → `function` · abbrev → `type` · structure → `record` · inductive → `enum` · namespace → `namespace`. Instances anónimas se saltan (paridad leanparse). El `name` lleva el FQN (`HB038.bc_sound`) y `scope` el prefijo — queries bare y qualified pegan ambas.

## Arquitectura

`default-extractor.ts` nuevo: dispatch `.lean` → Lean extractor, resto → TextMate, preservando el seam `SymbolExtractor` de ADR-017 D2 sin ciclos de import. `supports()` del TextMate ahora exige descriptor de gramática (ya no reclama `.lean` falsamente).

## Aceptación cross-repo (clon, branch line-d, verbatim en PR #149)

`code reindex` exit 0 → codeInventory built, **442 files / 409 symbols**, languages `[javascript, json, lean, markdown, python, toml, yaml]`. `code query "bc_sound"` → `aristotle/responses/HB-038/RequestProject/HB_038.lean` **línea 125** (== grep exacto), symbol `HB038.bc_sound`. Probes FQN: `HB038.bc_sound` score 12; `HB038.BCTree --kinds namespace` línea 35. Python confirmado ya-soportado (16 .py indexados).

## Verificación

typecheck 0 · eslint 0 · coverage EXIT 0 — **2294 passed** (+14), lines 73.04 / branches 61.90 / functions 81.94 (todas SUBIENDO sobre los floors) · corpus lint exit 0 · TDD 14/14 green tras red de módulo-ausente · lean-extractor 97% lines / 100% functions.