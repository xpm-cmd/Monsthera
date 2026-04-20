---
id: k-u16rujhn
title: Agent and wave MCP tools
slug: agent-and-wave-mcp-tools
category: context
tags: [mcp, agents, wave, orchestration, tooling]
codeRefs: [src/tools/agent-tools.ts, src/tools/wave-tools.ts, src/agents/service.ts, src/orchestration/service.ts, src/work/service.ts, src/dashboard/agent-experience.ts]
references: [agentservice-agent-registry-and-session-tracking, adr-004-orchestration-model, mcp-tool-catalog-complete-reference, wave-planning-and-execution-system]
createdAt: 2026-04-18T07:40:30.983Z
updatedAt: 2026-04-18T07:40:30.983Z
---

## Overview

Monsthera has a small but important slice of MCP tools dedicated to operational coordination rather than CRUD:

- agent tools describe who is doing what
- wave tools describe what can advance next

These tools sit on top of [[agentservice-agent-registry-and-session-tracking]], [[wave-planning-and-execution-system]], and the orchestration engine from [[adr-004-orchestration-model]].

## Agent tools

`src/tools/agent-tools.ts` exposes three derived-data calls:

- `list_agents`
- `get_agent`
- `get_agent_experience`

They do not manage an agent registry database. Instead, they derive agent state from work articles, reviewer assignments, enrichment roles, orchestration plans, and runtime health.

The most opinionated tool is `get_agent_experience`, which combines work coverage, knowledge count, status metrics, and wave readiness through `deriveAgentExperience()`. It turns the workspace itself into a feedback surface about handoff quality and contract hygiene.

## Wave tools

`src/tools/wave-tools.ts` exposes the phase-advancement control loop:

- `plan_wave` computes what is ready and what is blocked
- `execute_wave` applies the ready transitions in one call
- `evaluate_readiness` dry-runs guard evaluation for one work article

These are thin wrappers over `OrchestrationService`, but they enrich results with work metadata so agents can make decisions without an additional round-trip for every work item.

## Why these tools matter

Together, agent and wave tools let Monsthera answer two different operational questions:

- ownership: who is touching this work and who should review it?
- readiness: what can move right now and what is blocked?

That turns the MCP surface into an execution cockpit, not just a document store.

## Traceability pattern

When documenting agent or orchestration behavior, it helps to trace the path explicitly:

- agent-facing derived data from `AgentService`
- phase readiness from `OrchestrationService`
- work metadata from `WorkService`
- operator-facing heuristics from `dashboard/agent-experience.ts`

That chain is what allows a tool result to be traced all the way back to concrete work contracts and code.