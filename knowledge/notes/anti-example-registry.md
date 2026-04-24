---
id: k-anti-example-registry
title: "Anti-Example Registry"
slug: anti-example-registry
category: policy
tags: [policy, anti-examples]
codeRefs: []
references: []
policy_anti_example_tokens_json: '[{"pattern":"B1_4_kill_switch_\\w+","canonical_source":"docs/aristotle-briefs/results/**/*.lean","description":"Lean theorem name — verified against canonical file"}]'
policy_anti_example_phrases_json: '[{"phrase":"22.4% bars","corrected":"22.35 bars","since_commit":"8012863","rationale":"Wave-2 boundary review correction"},{"phrase":"$2,400 K_min","corrected":"$1,815 K_min","since_commit":"8012863","rationale":"Wave-2 boundary review correction"},{"phrase":"$0.10/rt c_rt","corrected":"$0.010/rt c_rt","since_commit":"8012863","rationale":"Wave-2 boundary review correction"},{"phrase":"$1,000 floor","corrected":"$923 floor","since_commit":"8012863","rationale":"Wave-2 boundary review correction"}]'
policy_rationale: "Pin wrong-form → corrected-form mappings that bled into the corpus and must not creep back. `monsthera lint` reports drift as `token_drift` / `phrase_anti_example` findings. The four phrase entries are real Hedera v1 Wave-2 drifts; each one represents hours of human-time spent catching the issue after the fact, and the registry is the forward-guard so the next reviewer does not have to."
createdAt: 2026-04-24T00:00:00.000Z
updatedAt: 2026-04-24T00:00:00.000Z
---

# Anti-example registry

Two kinds of entries live here; each is carried as a JSON-encoded array in
a flat frontmatter field (the markdown parser does not round-trip nested
YAML — see ADR-010).

## Tokens — `policy_anti_example_tokens_json`

A *token* rule says: "any prose occurrence of something matching `pattern`
must appear as a real canonical name defined in the files matched by
`canonical_source`". Use this when the corpus agrees on a naming scheme
(e.g. Lean theorem names `B1_4_kill_switch_*`) and drift is not a literal
typo but a misremembered name.

```json
{
  "pattern": "B1_4_kill_switch_\\w+",
  "canonical_source": "docs/aristotle-briefs/results/**/*.lean",
  "description": "Lean theorem name — verified against canonical file"
}
```

- `pattern` (required) — JavaScript regex source. Compiled with the `g`
  flag at scan time.
- `canonical_source` (required) — glob, relative to the repo root. Every
  `.lean` (or other extension) under the glob is parsed for canonical
  names; a match on `pattern` that is not in the parsed set surfaces as
  a `token_drift` error with a `levenshtein-closest` suggestion.
- `description` (optional) — short human hint for reviewers.

## Phrases — `policy_anti_example_phrases_json`

A *phrase* rule pins a wrong-form → corrected-form mapping. Use this
when a specific string bled into review artefacts and must not creep
back — e.g. an outdated monetary figure surfaced in one wave review and
the canonical form is pinned in a later commit.

```json
{
  "phrase": "22.4% bars",
  "corrected": "22.35 bars",
  "since_commit": "8012863",
  "rationale": "Wave-2 boundary review correction"
}
```

- `phrase` (required) — exact string. Case-insensitive match against
  prose. No normalisation — quotes, unicode dashes, and trailing
  whitespace are distinct phrases.
- `corrected` (required) — the form reviewers must use going forward.
- `since_commit` (optional) — the commit that established the
  correction; surfaced in lint findings.
- `rationale` (optional) — audit-trail note.

## Forward guards

A registry article must cite the wrong phrase verbatim in order to
document the drift. Without special handling that would cause the
registry itself to fail its own rule. Lines carrying any of these
markers are excluded from the phrase matcher:

- `do NOT` (any case)
- `anti-example` (hyphen or space, any case)
- `stale` (any case)
- `<!-- anti-example -->` (inline HTML comment)

So a reviewer can write `do NOT use "22.4% bars"` without self-flagging.

## Current registry

### Tokens

| Pattern | Canonical source | Description |
|---------|------------------|-------------|
| `B1_4_kill_switch_\w+` | `docs/aristotle-briefs/results/**/*.lean` | Lean theorem name — verified against canonical file |

### Phrases (Hedera v1 Wave-2 drifts)

| Wrong | Corrected | Since commit |
|-------|-----------|--------------|
| `22.4% bars` | `22.35 bars` | 8012863 |
| `$2,400 K_min` | `$1,815 K_min` | 8012863 |
| `$0.10/rt c_rt` | `$0.010/rt c_rt` | 8012863 |
| `$1,000 floor` | `$923 floor` | 8012863 |

Downstream repos populate this file (or create a sibling `category:
policy` article carrying its own JSON arrays). Multiple registries are
allowed; first-wins on collisions.
