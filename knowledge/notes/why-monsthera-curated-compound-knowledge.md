---
id: k-why-monsthera-compound-knowledge
title: "Why Monsthera: Curated Compound Knowledge, Not Code Indexing"
slug: why-monsthera-curated-compound-knowledge
category: guide
tags: [vision, rationale, retrieval, hybrid-search, code-intelligence, multi-agent, sessions, compound-knowledge, positioning]
codeRefs:
  - src/search/service.ts
  - src/search/embedding.ts
  - src/code-intelligence/inventory/service.ts
  - src/code-intelligence/inventory/persistence.ts
  - src/structure/service.ts
  - src/sessions/repository.ts
  - src/agents/service.ts
  - src/core/container.ts
references:
  - k-acodv9lb
  - k-x8umv6et
  - k-0bz1r6n0
  - k-klbt2h37
  - k-code-intel-m3-impl
  - k-quo5tdc1
  - k-vo0fhcxl
createdAt: 2026-05-22T00:00:00.000Z
updatedAt: 2026-05-22T00:00:00.000Z
---

# Why Monsthera: Curated Compound Knowledge, Not Code Indexing

There is a popular and correct argument that coding agents should not index
the codebase. Claude Code does not build a vector database of your code; it
greps, globs, and reads on demand. Monsthera agrees with that argument. This
note explains why Monsthera still builds an index, what kind it builds, and
the value it actually targets: not faster code search, but durable knowledge
that compounds across sessions and across agents.

## The debate this resolves

The "no indexing" argument is right about one specific thing: indexing *code*
to *retrieve code*. For "where is this defined / where is it used," exact-match
search wins on every axis that matters. Grep returns exact matches instead of
fuzzy false positives. It never drifts, so there is no stale index to babysit
while you edit. It needs zero setup and works on any repo. And nothing leaves
the machine. Embeddings of code buy you little here and cost a lot.

The word "indexing" is doing two jobs, though. That argument answers "should
you index code to find code." It does not answer a different question: "should
you retain the reasoning, decisions, and gotchas that never live in the code
at all." Those are opposite kinds of content, and the conclusion flips with
them.

Every reason grep wins is a property of *code specifically*. Code is
exact-match-friendly, it changes constantly, its relationships are explicit
(imports, calls, types), and it is already present in the repo. The *why*
behind a decision has the inverse properties. You search it by concept, not by
identifier. It decays slowly. It lives in no import graph. And critically, it
is not written in any file grep can read. Grep cannot find knowledge that was
never written where it searches.

## The real axis: match storage to decay rate

Monsthera's organizing principle is that "knowing your codebase" is not one
problem but three, each matched to how fast its content goes stale.

1. **Code text** decays fast (it changes every edit). Treatment: agentic grep,
   no durable index.
2. **Code structure and symbols** decay at a medium rate. Treatment: a
   *lightweight* index that is lexical, ephemeral, and local.
3. **Decisions and knowledge** decay slowly. Treatment: a durable, semantic,
   cross-session index. This is the only layer worth letting compound.

The design follows from this directly. The high-decay content gets the
disposable treatment; the low-decay content gets the durable, expensive
treatment. You do not invest in compounding something that drifts in a week,
and you do not throw away something that stays true for months.

## How the layers actually work

**Source of truth is always Markdown** (see ADR-001, k-acodv9lb). Knowledge and
work articles are `.md` files with YAML frontmatter. Everything else is a
derived index that can be rebuilt from these files. This is true even when the
optional Dolt backend is enabled: Dolt never replaces the Markdown, it only
stores derived data.

**Hybrid article search** runs BM25 keyword search on every query, and adds a
semantic pass when embeddings are available (`src/search/service.ts`). The two
are merged by a weighted score (`alpha * normBM25 + (1 - alpha) * cosine`) and
then re-ranked for trust. The semantic half is what closes the vocabulary gap:
a query for "auth" can surface an article that only ever says "OAuth, session,
token." See k-x8umv6et for the context-pack scoring and k-0bz1r6n0 for the
BM25 details.

**Embeddings run locally on Ollama** (`src/search/embedding.ts`). This matters
for the same reason the "no indexing" post likes grep: nothing leaves the
machine, and the cost is zero. The privacy and cost objections to a semantic
index do not apply when the model is local.

**Code intelligence is the lightweight middle tier** (`src/code-intelligence/
inventory/service.ts`, k-code-intel-m3-impl, ADR-015 at k-quo5tdc1). It extracts
symbols (functions, classes, methods) and keeps them in a JSON cache at
`.monsthera/cache/code-index.json`. It is lexical (it matches symbol names, not
meaning), ephemeral (the cache is rebuildable and lives in the disposable cache
zone), and local. It keeps every property the "no indexing" argument cares about
and adds exactly one thing grep cannot: it knows a *declaration* from a *mention*
(kind, scope, line). It is a structured accelerator for agentic search, not a
replacement for it. An optional Dolt mirror exists but is write-only; the JSON
stays the read surface (`src/code-intelligence/inventory/persistence.ts`).

**The structure graph is the connective tissue** (`src/structure/service.ts`).
Wikilinks, references, dependencies, code refs, and shared tags form an explicit
graph. This is what lets the code tier point back at the knowledge tier: a
symbol can be linked to the decision that explains it, mapping the *what* to the
*why*. Neither raw grep nor code embeddings give you that link.

**Dolt is an optional persistence backend** for the derived indexes,
orchestration events, and snapshots (k-klbt2h37). By default the search index is
in-memory and rebuilt from Markdown on boot (`src/core/container.ts`). Dolt earns
its place when you want the index to persist across restarts, or you want
git-like versioning, branching, and diffing of structured data.

## Curated compound knowledge

The phrase that captures the value: **curated compound knowledge**. Each
session's output (a handoff, a decision, a captured gotcha) becomes input to
future retrieval. Knowledge accretes instead of resetting every session, and
because the graph adds edges (not just nodes) and embeddings keep old knowledge
reachable by future unanticipated queries, the value compounds rather than just
accumulates.

The "curated" half is not optional decoration. Compound knowledge amplifies what
you put in, including the errors. Left alone, an accreting knowledge base rots:
old decisions get retrieved as if current, two articles disagree on the same
figure, low-quality content dilutes the top results. Most of Monsthera's
machinery exists to fight that entropy, not to add content:

- Trust re-ranking penalizes legacy articles and rewards fresh, source-linked
  ones (`src/search/service.ts`).
- Freshness diagnostics flag stale items instead of trusting them silently.
- Canonical values plus `monsthera lint` catch numeric drift across articles.
- Citation-value verification and orphan detection catch "you cited X saying Y,
  but X does not say Y" and broken edges.
- Markdown plus git make every addition diffable and reversible, so bad
  knowledge can be pruned.

A useful way to hold it: `benefit = reuse x durability - decay - curation cost`.
Knowledge that is reused often and decays slowly compounds strongly. Write-only
knowledge nobody reads again is pure cost.

## Multi-agent and cross-session

The compounding pays off most across agents and across time, which is the
territory grep structurally cannot enter because grep is stateless.

Across **concurrent agents**, the work article is the coordination unit. It
carries explicit ownership (author, lead, assignee, reviewers, enrichment roles)
plus dependencies and a phase lifecycle, all queryable. The agent directory
derives a live view of who is doing what, what is blocked, and what needs review
(`src/agents/service.ts`). Deterministic guards gate phase transitions, so an
agent cannot push past a review gate another agent owns.

Across **sessions**, the cognitive handoff (k-vo0fhcxl, `src/sessions/
repository.ts`) turns the *why* of a finished session into a durable artifact:
deterministic facts plus an agent-authored narrative of decisions, blockers, and
next steps. The token economics are the point. A new session that re-derives
context from scratch costs roughly 10,000 to 30,000 tokens. A handoff is read as
a short teaser. Paying about 1,500 tokens at close to save about 15,000 at the
next open is a net win across the conversation chain, and it preserves the
narrative that a compacted context window would otherwise destroy.

## Advantages, in short

- Closes the vocabulary gap that exact-match search cannot (semantic recall).
- Ranked, trust-weighted, freshness-aware results instead of raw match lists.
- Explicit relationships (references, dependencies, code-to-decision links).
- Durable memory that survives context compaction and agent handoffs.
- Local and free: embeddings run on Ollama, nothing leaves the machine.
- Self-curating: the system actively fights its own entropy.

## Scope: where it helps and where it does not

Honest boundaries matter for a positioning note.

- For exact tokens, identifiers, and unique strings in the current tree, grep is
  faster, exact, and complete. Monsthera does not replace it.
- For a tiny corpus, browsing the wiki catalog beats ranked search, and the
  whole multi-agent and session apparatus is overhead.
- The index can lag the source until a reindex; grep never lies about current
  state. The freshness and canary machinery exists because of this.
- The benefit is conditional on curation discipline. Without it, what compounds
  is debt.

The value compounds with corpus size, vocabulary diversity, number of agents,
and how much the *why* will matter later.

## Opportunities

- Richer code graph: today the inventory emits only `contains` edges
  (file to symbol). Cross-file `imports` and `references` edges would let the
  code tier carry real structural navigation while staying lexical and local.
- Tighter code-to-knowledge linking: surface, at code-query time, the decisions
  and gotchas attached to a symbol, so the *what* always offers a path to the
  *why*.
- Cross-handoff coherence checks: verify a new handoff against prior session
  facts to catch contradictions early.
- Decay-aware curation: use freshness and reuse signals to suggest what to prune
  or refresh, turning curation from a manual chore into a guided one.

## One-line summary

It was never "index versus no index." Pick the right point on the spectrum per
content type: grep for code text, a lightweight lexical index for symbols, and a
durable curated index for the *why*. Do not index the code. Build curated
compound knowledge.
