# Knowledge Graph Edge Taxonomy

This document defines the edge model for a future Monsthera knowledge graph view.

The goal is not to visualize every possible association. The goal is to surface useful, defensible relationships between files, tickets, patches, notes, and knowledge entries without turning the graph into noise.

## Scope

The first graph iteration should only use edges that are:

- explicit in Monsthera data
- derivable from exact path overlap
- explainable to an operator in one sentence

Out of scope for v1:

- semantic similarity edges
- tag-only similarity edges
- free-text co-mention edges
- agent-to-agent social graph edges
- fuzzy basename matching across unrelated directories

## Node Types

The graph should support these node types:

- `file`
- `ticket`
- `patch`
- `note`
- `knowledge`

Optional later expansion:

- `agent`
- `session`
- `search_result_bundle`

## Edge Taxonomy

### 1. `imports`

- Source: indexed import graph
- Shape: `file -> file`
- Meaning: one file directly imports another indexed file
- Default score: `1.0`

This is the strongest file-to-file edge because it is already explicit and directional.

### 2. `blocks`

- Source: ticket dependency relation
- Shape: `ticket -> ticket`
- Meaning: one ticket must finish before the other can proceed
- Default score: `1.0`

This edge should always be visible and directional.

### 3. `relates_to`

- Source: ticket dependency relation
- Shape: `ticket <-> ticket`
- Meaning: two tickets are related but not sequentially blocking
- Default score: `0.65`

This edge is useful context but weaker than `blocks`.

### 4. `addresses_file`

- Source: ticket `affectedPaths`
- Shape: `ticket -> file`
- Meaning: the ticket explicitly claims the file as affected scope
- Default score: `0.9`

Only exact normalized repo-relative path matches should create this edge in v1.

### 5. `touches_file`

- Source: patch `touchedPaths`
- Shape: `patch -> file`
- Meaning: the patch diff modifies the file
- Default score: `1.0`

This is an explicit code-change edge and should stay strong.

### 6. `implements_ticket`

- Source: patch `ticketId`
- Shape: `patch -> ticket`
- Meaning: the patch proposal is linked to the ticket
- Default score: `0.95`

This edge explains why a patch belongs in the graph.

### 7. `annotates_file`

- Source: note `linkedPaths`
- Shape: `note -> file`
- Meaning: the note explicitly references the file
- Default score: `0.75`

This should be directional and exact-path only in v1.

### 8. `documents_file`

- Source: knowledge entry content plus exact linked path metadata when available
- Shape: `knowledge -> file`
- Meaning: the knowledge entry is explicitly about the file
- Default score: `0.7`

If a knowledge entry has no exact file linkage, do not create this edge in v1.

### 9. `supports_ticket`

- Source: comments or notes created as explicit ticket follow-up only when a direct ticket key is present
- Shape: `note -> ticket` or `knowledge -> ticket`
- Meaning: the note or knowledge item exists to support the ticket
- Default score: `0.7`

This edge should only exist when the ticket reference is explicit, not inferred from text search.

## Scoring Rules

Scores are intended for filtering and UI weighting, not for pretending the graph is mathematically precise.

Base rule:

- use the default score from the taxonomy
- subtract confidence only when the derivation is weaker than exact stored linkage

Allowed score adjustments in v1:

- exact stored relation: no penalty
- exact normalized path overlap: no penalty
- derived from direct linked metadata but not stored as a first-class relation: `-0.05`
- derived from package/module scope rather than exact file path: `-0.15`

Do not introduce additional fuzzy penalties in v1. If the edge is too weak, drop it instead of inventing a decimal.

## Visibility Thresholds

Default UI threshold:

- hide edges below `0.65`

Default edge ordering:

1. `1.0` explicit structural edges
2. `0.9-0.95` explicit work-scope edges
3. `0.7-0.75` documentation/support edges
4. `0.65` contextual relations

Implication:

- `blocks`, `imports`, and `touches_file` should dominate the graph
- `relates_to` and documentation edges should provide context, not structure the whole layout

## Derivation Rules

The graph builder should normalize all file paths to the repo-relative namespace before joining edges.

Required derivation rules:

- exact path match only
- no basename-only joins
- no substring path joins
- directional edges remain directional
- symmetric relations like `relates_to` should render once, not twice

If a source artifact references a file that is not indexed, skip the edge in v1 instead of emitting a dangling fuzzy node.

## Noise Controls

To keep the graph usable:

- collapse duplicate edges of the same type between the same nodes
- keep the highest score when duplicates exist
- cap low-priority contextual fan-out per node if needed in UI
- prefer hiding weak edges over shrinking everything into unreadability

Recommended UI defaults:

- start with explicit structural edges enabled
- allow toggling contextual edges such as `relates_to`, `annotates_file`, and `documents_file`

## Why Semantic Similarity Is Excluded

Semantic similarity may be useful later, but it is too easy to overstate.

If a graph UI shows a line, operators will assume the relationship is meaningful and stable. Text similarity and shared tags do not meet that bar yet.

For v1, the graph should answer:

- what depends on what
- what ticket affects what file
- what patch implements what ticket
- what notes or knowledge entries explicitly point at that artifact

That is enough to evaluate whether the visualization is useful without introducing misleading edges.

## Recommendation

The future graph UI should launch with:

- explicit node types
- the nine edge types above
- default threshold `0.65`
- exact-match derivation only
- semantic and text-similarity edges deferred to a later ticket
