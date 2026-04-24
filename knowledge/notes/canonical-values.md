---
id: k-canonical-values
title: "Canonical Values Registry"
slug: canonical-values
category: policy
tags: [policy, canonical-values]
codeRefs: []
references: []
policy_canonical_values_json: '[]'
policy_rationale: "Single place where numeric or monetary values the corpus agrees on are pinned. `monsthera lint` cross-checks mentions of each name against the expected value and flags drift as `canonical_value_mismatch`."
createdAt: 2026-04-24T00:00:00.000Z
updatedAt: 2026-04-24T00:00:00.000Z
---

# Canonical values

This article is the canonical registry of values the Monsthera corpus agrees on by name. Authors add entries to the JSON array in `policy_canonical_values_json` (the field is a flat YAML string because the markdown parser does not round-trip nested YAML — see ADR-010). Every entry has the shape:

```json
{
  "name": "c_rt",
  "value": "$0.010",
  "unit": "per_rt",
  "source_article": "k-aristotle-c2-cpcv",
  "valid_since_commit": "8012863",
  "rationale": "Corrected from $0.10 in Wave-2 boundary review"
}
```

- `name` (required) — the token agents look for in prose, e.g. `c_rt`, `K_min`, `ws11_bars`.
- `value` (required) — the canonical string, including `$` and commas when present. `monsthera lint` compares normalised forms (strip `$`, `,`, whitespace); a raw-string compare preserves trailing-zero precision that auditors care about.
- `unit` (optional) — human hint; not used for comparison.
- `source_article` (optional) — id of the knowledge article that argues for this value.
- `valid_since_commit` (optional) — surfaced in lint findings so a reader can walk back to when the value last changed.
- `rationale` (optional) — short audit-trail note.

Activating the guard
---

A `category: policy` article can opt into policy-time enforcement by referencing this registry — see `policy_canonical_values_check` (reserved for a future session) — but the out-of-the-box use case is `monsthera lint`, which scans the knowledge + work corpus and emits `canonical_value_mismatch` errors (exit code 1) for any drift.

## Current registry

The registry is empty by default. Downstream repos populate this file (or create a sibling `category: policy` article with its own `policy_canonical_values_json`) with the values their corpus needs to pin. Multiple registries are allowed; first-wins on name collisions.
