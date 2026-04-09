# Monsthera Dashboard UX and Operations Plan

## Purpose

This document defines the operational intent of the v3 dashboard:

- make the dashboard usable for real end-to-end workflows
- connect the UI to the backend capabilities that already exist
- explain how Monsthera should be used by a human or agent team
- expose safe automation instead of hiding it behind implicit runtime behavior

## Audit: gaps that existed before this pass

### UI to backend connection gaps

1. Work creation only exposed a minimal subset of the work model.
   Missing in the UI or blocked by validation:
   - assignee
   - references
   - code refs
   - practical lead and ownership setup

2. Work review flow depended on a hardcoded reviewer identity.
   - not usable beyond demo data
   - not aligned with the derived agent directory

3. The dashboard could not see or trigger orchestration waves.
   - backend had orchestration planning and execution services
   - UI had no concept of ready-to-advance work beyond manual inspection

4. Section purpose was implicit rather than taught.
   - a new user could navigate the dashboard
   - a new user could not easily understand what each area was for

### Product experience gaps

1. Overview was descriptive but not operational.
2. Flow showed activity but not coordinated next steps.
3. Work supported CRUD but not realistic operational triage.
4. There was no first-class "how to use Monsthera" surface.
5. Automation posture was not visible enough for safe autonomous use.

## Target operating model

Monsthera should guide the user through five motions:

1. Capture or import knowledge.
2. Shape work as a canonical work article.
3. Assign agents, owners, and review roles.
4. Advance safe waves deliberately.
5. Preserve the outcome as reusable knowledge.

The dashboard should teach this model while supporting it.

## Section intent model

### Overview

Intent:
- tell the operator what matters now
- surface ready wave items, blockers, and next actions
- give new users a clear starting path

### Guide

Intent:
- explain how Monsthera works
- document the user journey
- document agent orchestration and supervised automation rules

### Flow

Intent:
- operate waves
- coordinate owners and handoffs
- inspect agent activity by phase

### Work

Intent:
- create and update the canonical work artifact
- keep context, owners, dependencies, review, and lifecycle attached

### Knowledge

Intent:
- maintain the shared brain
- import source material and connect it to code and work

### Search

Intent:
- retrieve context before planning, implementing, or reviewing

### System

Intent:
- inspect runtime health, storage mode, integrations, indexing, and security posture

## Agent orchestration guidance

### Recommended role shape

- planner or lead: frames the article and decomposes the work
- enrichment specialists: architecture, security, testing, UX, domain
- implementer: owns implementation phase
- reviewer: approves or requests changes during review

### Orchestration rules

1. The work article is the contract between agents.
2. Automation should only advance work when guards already pass.
3. If a human cannot explain why an article is ready, automation should not advance it.
4. Review is a gate, not an afterthought.
5. Done work should feed knowledge, not disappear.

## Agent efficiency model

Monsthera should make agents better by default in four ways:

1. Reduce token waste.
   - retrieval should beat rediscovery
   - references and code refs should shrink the reading set

2. Reduce handoff drift.
   - ownership, acceptance criteria, blockers, and reviewers should stay attached to the same work article

3. Accelerate safe automation.
   - ready waves should expose safe advances without hiding blocked work

4. Compound learning.
   - reusable outcomes should become knowledge so later agents start from a stronger baseline

The runtime now exposes an `agentExperience` diagnostic snapshot so the UI can show:

- contract coverage
- context coverage
- ownership coverage
- review coverage
- automation posture
- actionable recommendations for improvement

Monsthera now also exposes ranked `context packs` for two high-value agent tasks:

- `code` mode: favor code-linked, fresher, higher-signal context for implementation work
- `research` mode: favor source-linked, richer, investigation-friendly context

This applies the same core idea used by tools with repository maps and long-term memory layers:
reduce blind reading, retrieve better context first, and make the context layer improve over time.

## Autonomous process model

### Guided Manual

- humans inspect the queue and decide each handoff
- best when the workspace is still being learned

### Coordinated Multi-Agent

- roles are explicit
- work articles carry the coordination state
- Flow is the control surface

### Supervised Autonomous

- use ready waves
- execute only safe advances
- keep blockers and review status visible

## Implemented changes in this pass

### Backend

- added orchestration wave read endpoint
- added orchestration wave execution endpoint
- exposed wave planning and wave execution capabilities in runtime metadata
- exposed search auto-sync and agent-experience diagnostics in runtime metadata
- expanded work creation validation to accept assignee, references, and code refs
- corrected MCP tool descriptions so agents are not told to do redundant per-article reindex calls after normal CRUD

### Frontend

- added Guide page as a first-class route
- upgraded Overview into an operational cockpit
- upgraded Flow into an orchestration control surface
- extended Guide and Agent Profiles with explicit agent operating guidance, optimization diagnostics, and continuous-improvement coaching
- upgraded Search into a context-pack builder with code and investigation modes, ranked by freshness, quality, and code linkage
- upgraded Knowledge with freshness and quality diagnostics so stored context can be reviewed as a real asset
- upgraded Work with:
  - richer create and edit forms
  - real agent suggestions from the derived agent directory
  - reviewer assignment without hardcoded demo identities
  - filters for phase, priority, search, and operational state
  - better visibility of readiness, blockers, enrichment, and review state

### Runtime transparency

- surfaced wave planning and execution in System capability views
- surfaced search auto-sync in System capability views
- surfaced agent-efficiency recommendations based on current workspace state

## Follow-up opportunities

1. Add per-article readiness diagnostics directly in Work.
2. Add dedicated UI for enrichment role assignment at article creation time.
3. Add richer wave grouping and historical orchestration analytics.
4. Persist historical agent-experience snapshots for trend analysis over time.
