# Ideas from Sequential Thinking MCP Server

Source: `modelcontextprotocol/servers/src/sequentialthinking`

## Overview

The Sequential Thinking MCP Server provides structured step-by-step reasoning
with support for revisions and branching. It exposes a single tool
(`sequentialthinking`) that lets LLMs break down complex problems into numbered
thoughts, revise earlier steps, and fork into alternative reasoning paths.

## Ideas for Agora

### 1. Structured Reasoning Tool

Add a `structured_reasoning` tool that lets agents document their thinking
process when evaluating complex tickets or making architectural decisions.

**Key features from Sequential Thinking to adopt:**
- Numbered, sequential thought steps
- Revision support (`isRevision` + `revisesThought`) — go back and correct
  earlier reasoning without losing the original
- Branching (`branchFromThought` + `branchId`) — explore alternative approaches
  before committing to one
- Dynamic scope (`totalThoughts` as adjustable estimate)

**Integration points:**
- Council verdicts: require structured reasoning before submitting a verdict
- Ticket transitions: capture reasoning chain on complex state changes
- Patch reviews: document step-by-step evaluation of proposed patches

### 2. Dynamic Complexity Estimation

Sequential Thinking treats `totalThoughts` as a mutable estimate. Apply this to
Agora's ticket system:

- Add a `complexity_estimate` field to tickets that agents update as they work
- Track estimate history (initial vs. final) to improve future estimates
- Feed into `analyze_complexity` for calibration over time

### 3. Simplified Tool Interface (Super-Tools)

Sequential Thinking packs all functionality into 1 tool with modal parameters.
Agora has 42 tools, which can overwhelm LLM tool selection.

**Proposal:** Offer an optional "simplified mode" with grouped super-tools:

| Super-tool | Replaces |
|------------|----------|
| `ticket` | `create_ticket`, `assign_ticket`, `update_ticket`, `update_ticket_status`, `list_tickets`, `search_tickets`, `get_ticket`, `comment_ticket`, `link_tickets`, `unlink_tickets` |
| `knowledge` | `store_knowledge`, `search_knowledge`, `query_knowledge`, `archive_knowledge`, `delete_knowledge` |
| `agent` | `register_agent`, `agent_status`, `claim_files`, `end_session` |
| `search` | `get_code_pack`, `get_change_pack`, `get_issue_pack` |

Each super-tool accepts an `action` parameter to select the sub-operation.

**Trade-offs:**
- Pro: Fewer tools for LLMs to choose from → better tool selection accuracy
- Pro: Related operations grouped logically
- Con: Larger parameter schemas per tool
- Con: Two interfaces to maintain if keeping backwards compat

### 4. Reasoning History as Knowledge Capture

Sequential Thinking accumulates a `thoughtHistory` array. Apply this pattern:

- When an agent resolves a complex ticket, automatically capture the reasoning
  chain as a knowledge entry (type: `reasoning_trace`)
- Store with metadata: ticket ID, agent, duration, branch count
- Enable searching past reasoning traces when similar problems arise
- Integrates naturally with existing knowledge store and semantic search

### 5. Decision Branch Visualization in Dashboard

Sequential Thinking uses colored box-drawing for visual output. Extend Agora's
dashboard:

- Render council deliberations as a reasoning tree (trunk + branches)
- Color-code by type: analysis (blue), revision (yellow), alternative (green)
- Show convergence points where branches merge into a consensus
- Add to agent timeline view for richer session replays

## Priority Recommendation

1. **Reasoning history → knowledge** (low effort, high reuse of existing infra)
2. **Structured reasoning tool** (medium effort, high value for decision quality)
3. **Simplified tool interface** (high effort, high value for LLM usability)
4. **Decision branch visualization** (medium effort, good for observability)
5. **Dynamic complexity estimation** (low effort, incremental improvement)
