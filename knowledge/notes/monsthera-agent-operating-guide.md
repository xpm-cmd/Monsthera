---
id: k-uuz80fga
title: Monsthera Agent Operating Guide
slug: monsthera-agent-operating-guide
category: guide
tags: [agents, orchestration, automation, continuous-improvement, dashboard, operations]
codeRefs: [src/dashboard/index.ts, src/tools/knowledge-tools.ts, src/tools/work-tools.ts, src/tools/search-tools.ts, public/pages/guide.js, public/lib/guide-data.js, public/pages/search.js]
createdAt: 2026-04-09T13:10:00.000Z
updatedAt: 2026-04-09T15:10:00.000Z
---

Monsthera works best when agents use it as an operational memory and coordination layer, not as a passive ticket archive.

## Why agents should use Monsthera directly

- It reduces rediscovery. A grounded agent can pull the relevant work article, knowledge article, and code refs instead of rebuilding context from scratch.
- It reduces handoff drift. Objective, acceptance criteria, ownership, blockers, reviewers, and implementation evidence stay attached to the same work article.
- It improves autonomous safety. Waves and guarded phase transitions only work well when the work contract is explicit.

## Default agent flow

1. Search for relevant knowledge and existing work before planning from memory.
2. Create or update the work article so the objective, acceptance criteria, owners, references, and code refs are explicit.
3. Add specialist enrichment or reviewers when the work crosses architecture, testing, UX, security, or domain boundaries.
4. Use Flow to inspect blockers, ready wave items, and the next safe phase transition.
5. Promote reusable lessons from completed work into Knowledge so future agents start faster.

## Tool sequence agents should follow

1. Use `search` for quick discovery and `build_context_pack` before deep coding or investigation.
2. Open the selected `get_article` and `get_work` targets instead of re-reading large raw history.
3. Use `create_work` or `update_work` to make the handoff contract explicit before execution.
4. Use lifecycle tools like `advance_phase`, `contribute_enrichment`, `assign_reviewer`, `submit_review`, and dependencies to keep risk visible.
5. Use `create_article` or `update_article` when the result is reusable beyond the current ticket.

## How Monsthera saves tokens and time

- Prefer retrieval over repeated explanation. Search and knowledge references are cheaper than rediscovering the same architecture every turn.
- Put references and code refs on the work article. This narrows the reading set for the next agent.
- Treat the work article as the handoff contract. The next agent should inherit the job definition instead of renegotiating it.
- Use the ready wave for safe transitions. This avoids spending tokens on asking whether a guard already passes.

## Search behavior agents should know

Normal knowledge and work create/update/delete flows already sync search automatically.

Use `reindex_all` only when:

- the repo was migrated in bulk
- many markdown files were imported outside the normal services
- search needs recovery after an operational incident

Agents should not spend extra tool calls on manual per-article reindexing after ordinary CRUD flows.

## Human operator quick paths

### If the goal is code generation

1. Start in Search using code mode.
2. Open the best 2 to 4 context items.
3. Create or tighten the work article with objective, acceptance criteria, owners, references, and code refs.
4. Let agents implement from that contract and keep review explicit.

### If the goal is investigation

1. Start in Search using research mode.
2. Prefer fresh or source-linked context.
3. If the investigation needs scope and ownership, create a spike work article.
4. Save the final conclusion into Knowledge so it becomes reusable.

### If the goal is durable storage

1. Create or update a knowledge article with the final guide, decision, or imported source summary.
2. Attach code refs and source paths whenever they exist.
3. Link that knowledge from relevant work so future agents inherit it naturally.

## Autonomous orchestration rules

- Automate only when the objective and acceptance criteria are explicit.
- Keep ownership clear before implementation and review handoffs.
- Keep blockers visible rather than hiding them behind optimistic automation.
- Treat review as a real gate. Done means approved, not just coded.

## Continuous improvement loop

1. Observe friction: find missing sections, missing refs, weak ownership, review gaps, and blocked work.
2. Standardize the contract: improve the work article first.
3. Promote reusable decisions into knowledge.
4. Automate the proven path with guarded waves.

This loop compounds over time. Better contracts create faster agents; faster agents produce better knowledge; better knowledge reduces future token and planning cost.
