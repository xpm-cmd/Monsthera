---
id: k-5o4nk93g
title: Monsthera usage guide for humans and agents
slug: monsthera-usage-guide-for-humans-and-agents
category: guide
tags: [agents, workflow, best-practices, onboarding, knowledge-management, search, work-articles]
codeRefs: [src/tools/search-tools.ts, src/tools/knowledge-tools.ts, src/tools/work-tools.ts, src/knowledge/wiki-bookkeeper.ts, src/search/service.ts, src/work/lifecycle.ts, src/core/article-trust.ts]
references: [k-uuz80fga]
createdAt: 2026-04-11T02:10:26.109Z
updatedAt: 2026-04-11T02:10:26.109Z
---

## Mental model

Monsthera is a shared brain with an integrated backlog. It has two halves:

- **Knowledge** = what the team knows (decisions, guides, patterns, imported context)
- **Work** = what the team is doing (execution contracts with a 5-phase lifecycle)

An agent that starts by reading Monsthera starts 10x faster than one that re-discovers the repo from scratch.

## For humans: 3 main flows

### Before coding (mode=code)

1. `build_context_pack("what I'm about to work on", mode="code")`
2. Read the top 2-3 items
3. Create or update a work article with objective + acceptance criteria
4. Execute from that contract

### Before investigating (mode=research)

1. `build_context_pack("what I'm investigating", mode="research")`
2. Prefer fresh and source-linked context
3. If the investigation has scope, create a spike work article
4. Save the conclusion into Knowledge so it survives

### After learning something reusable

1. `create_article(title, category, content, codeRefs)`
2. Always include codeRefs when code is involved
3. Always include tags for future discoverability

## For agents: recommended tool sequence

```
1. SEARCH before acting
   search("topic") or build_context_pack(query)
   → Does knowledge about this already exist?
   → Is there an open work article?

2. READ what was found
   get_article(id) / get_work(id)
   → Don't re-read files already summarized in knowledge

3. CREATE/UPDATE the work contract
   create_work() or update_work()
   → Objective, acceptance criteria, codeRefs
   → Assignee, references to knowledge

4. EXECUTE from the contract
   → The work article IS the handoff document
   → advance_phase() when guards pass

5. SAVE what was learned
   create_article() or update_article()
   → Decisions, patterns, gotchas
   → What another agent would need to know
```

## CLAUDE.md agent instructions (recommended)

```
1. ALWAYS search Monsthera before exploring the repo manually
   - build_context_pack(query, mode="code") before coding
   - search(query, type="knowledge") before deciding

2. NEVER re-discover what is already in Knowledge
   - If search returns a relevant article, read it with get_article
   - Trust stored decisions and guides

3. ALWAYS save reusable knowledge
   - Architectural decisions → category="decision"
   - Non-obvious bugs and root causes → category="solution"
   - How a system works → category="context"
   - Codebase patterns → category="pattern"
   - Language/framework traps → category="gotcha"

4. ALWAYS include codeRefs when knowledge touches code
   - Enables doctor to validate freshness
   - Enables build_context_pack to rank better

5. Work articles are contracts, not tickets
   - Objective + acceptance criteria before implementing
   - advance_phase() only when guards pass
   - Review is a real gate, not a rubber stamp
```

## Knowledge categories

| Category | When to use | Example |
|---|---|---|
| decision | Chose between approaches | "ADR-001: Storage Model" |
| solution | Found a non-obvious bug or fix | "SQLite lock timeout on concurrent writes" |
| context | Understood how a system works | "How search ranking combines BM25 + embeddings" |
| pattern | Discovered a codebase convention | "All repos return Result types, never throw" |
| gotcha | Hit a language/framework trap | "Zod v4 enum doesn't accept arrays" |
| guide | Wrote operational instructions | "Monsthera Agent Operating Guide" |

## Anti-patterns to avoid

| Anti-pattern | Why it hurts | What to do instead |
|---|---|---|
| Agent reads 20 files without searching first | Burns tokens re-discovering context | `build_context_pack` first |
| Knowledge without codeRefs | Doctor can't validate freshness, context pack ranks it low | Always include relevant paths |
| Work article without acceptance criteria | Guards for planning→enrichment fail | Define criteria before advancing |
| Saving results only in chat | Lost after context compaction | `create_article` immediately |
| `reindex_all` after every CRUD | Waste — sync is automatic | Only for bulk imports or recovery |
| Creating knowledge for everything | Noise drowns signal | Only save what another agent would need |

## The continuous improvement loop

1. Observe friction: missing sections, missing refs, weak ownership, review gaps, blocked work
2. Standardize the contract: improve the work article first
3. Promote reusable decisions into knowledge
4. Automate the proven path with guarded waves

Better contracts → faster agents → better knowledge → lower future cost → (loop)

## What makes Monsthera different from a static wiki

- **Quality scores**: `build_context_pack` with `verbose=true` shows how reliable each piece of context is
- **Freshness tracking**: articles linked to source files know when they're stale
- **Code ref validation**: `doctor` checks that referenced paths still exist in the repo
- **Trust signals**: legacy-tagged vs source-linked articles are ranked differently in search
- **Semantic search**: BM25 + embeddings find conceptually related content, not just keyword matches
- **Work lifecycle**: 5-phase state machine with guard-driven transitions, not free-form status labels