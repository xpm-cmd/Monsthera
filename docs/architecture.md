# Agora v1.0.0 — Architecture

## System Overview

```mermaid
flowchart TB
    CLI["CLI: init · index · status · serve · export"]
    SERVE["agora serve"]
    DASH["Dashboard server (:3141)"]
    MCP["MCP server (stdio or HTTP)"]
    CTX["AgoraContext\nconfig + repo DB + search router + coordination bus"]
    TOOLS["34 MCP tools\nread · agents · coordination · patches · notes · knowledge · tickets · index"]
    SEARCH["SearchRouter\nFTS5 / Zoekt + optional semantic reranking"]
    TICKETS["Ticket service\nlifecycle + comments + dependencies + patch links"]
    DASHRT["Dashboard runtime\nREST + SSE + ticket actions + timeline + search debug"]
    REPO["Repo DB (.agora/agora.db)"]
    GLOBAL["Global knowledge DB (~/.agora/knowledge.db)"]

    CLI --> SERVE
    SERVE --> MCP
    SERVE --> DASH
    MCP --> CTX
    CTX --> TOOLS
    TOOLS --> SEARCH
    TOOLS --> TICKETS
    TOOLS --> REPO
    SEARCH --> REPO
    TICKETS --> REPO
    DASH --> DASHRT
    DASHRT --> REPO
    DASHRT --> GLOBAL
```

## Runtime Shape

Agora runs as a local CLI with two main long-lived surfaces:

- MCP server for agent tools, over `stdio` or HTTP (`/mcp`)
- dashboard server for human visibility and local ticket actions

When `agora serve --transport http` starts, it creates:

- a repo-local SQLite database in `.agora/agora.db`
- a `SearchRouter` with FTS5 always available, Zoekt optional, semantic reranking optional
- a DB-backed `CoordinationBus`
- a dashboard server with REST routes and `/api/events` SSE

The dashboard is not a separate product tier. It is another local runtime surface over the same repo database.

## Tool Surface

The current tool surface is organized as:

- Read: `status`, `capabilities`, `schema`, `get_code_pack`, `get_change_pack`, `get_issue_pack`, `lookup_dependencies`
- Agents and coordination: `register_agent`, `agent_status`, `broadcast`, `send_coordination`, `poll_coordination`, `claim_files`, `end_session`
- Patches and notes: `propose_patch`, `list_patches`, `propose_note`, `list_notes`
- Knowledge: `store_knowledge`, `search_knowledge`, `query_knowledge`, `archive_knowledge`, `delete_knowledge`
- Tickets: `create_ticket`, `assign_ticket`, `update_ticket_status`, `update_ticket`, `list_tickets`, `search_tickets`, `get_ticket`, `comment_ticket`, `link_tickets`, `unlink_tickets`
- Index: `request_reindex`

Role access and session requirements are policy-driven. Some tools are public, some require an active session, and some require both session ownership and role access.

## Data Model

### Repo DB

The repo database holds operational state for the current repository:

- source index: `files`, `imports`, `files_fts`
- agents and sessions: `agents`, `sessions`
- collaboration: `coordination_messages`, `event_logs`, `debug_payloads`
- notes and patches: `notes`, `patches`
- knowledge: `knowledge`, `knowledge_fts`
- tickets: `tickets`, `ticket_history`, `ticket_comments`, `ticket_dependencies`, `tickets_fts`
- dashboard event stream: `dashboard_events`

### Global DB

The global database is narrower:

- cross-project `knowledge`
- `knowledge_fts`

It is used for global decisions, patterns, and other reusable knowledge outside a single repo.

## Search Architecture

```mermaid
flowchart LR
    QUERY["Query"]
    ROUTER["SearchRouter"]
    FTS5["FTS5 lexical search"]
    ZOEKT["Zoekt lexical search\noptional"]
    SEM["Semantic reranker\noptional"]
    MERGE["Hybrid merge"]
    BUNDLE["Evidence bundle / result payload"]
    TICKETFTS["Ticket FTS"]
    KNOWFTS["Knowledge FTS"]

    QUERY --> ROUTER
    ROUTER --> FTS5
    ROUTER --> ZOEKT
    ROUTER --> SEM
    FTS5 --> MERGE
    ZOEKT --> MERGE
    SEM --> MERGE
    MERGE --> BUNDLE
    QUERY --> TICKETFTS
    QUERY --> KNOWFTS
```

There are now three search subsystems:

- code search: lexical backend plus optional semantic merge
- knowledge search: FTS5 plus optional semantic merge
- ticket search: FTS5 over ticket metadata

The dashboard search debugger exposes the code-search runtime path and shows:

- runtime backend
- lexical backend actually used for keyword candidates
- sanitized FTS query when lexical backend is FTS5
- lexical, semantic, and merged result buckets

## Ticket Runtime

Tickets are first-class operational records, not knowledge entries.

Core records:

- `tickets`: current state and ownership
- `ticket_history`: authoritative status transition log
- `ticket_comments`: discussion and technical analysis
- `ticket_dependencies`: `blocks` and `relates_to` edges

Patch linkage is stored by `patches.ticket_id -> tickets.id`.

Current workflow states:

- `backlog`
- `technical_analysis`
- `approved`
- `in_progress`
- `in_review`
- `ready_for_commit`
- `blocked`
- `resolved`
- `closed`
- `wont_fix`

Assignment is ownership metadata, not its own workflow state.

## Dashboard Runtime

```mermaid
sequenceDiagram
    participant UI as Browser
    participant API as Dashboard HTTP server
    participant DB as Repo DB
    participant SSE as /api/events

    UI->>API: GET /api/overview, /api/tickets, /api/agents, ...
    API->>DB: Query current operational state
    DB-->>API: Rows
    API-->>UI: JSON + initial HTML

    UI->>API: POST /api/tickets/:id/comment|assign|status
    API->>DB: Write ticket mutation + dashboard_events + event_logs
    DB-->>API: Success / error
    API-->>UI: JSON result

    API->>DB: Poll dashboard_events
    DB-->>SSE: New events after last seen id
    SSE-->>UI: event: ticket_status_changed / ticket_commented / ...
```

The dashboard currently exposes:

- overview stats
- live agents
- activity charts
- indexed-file metrics
- agent timeline
- search debugger
- activity log
- patches
- notes
- knowledge
- tickets with table/board views, detail, comments, and local actions

Realtime updates are driven from persisted `dashboard_events`, not only in-memory broadcast.

### Security Model

The dashboard binds to `localhost` and assumes a **localhost trust model**: any process on the local machine can reach the HTTP API. This is intentional for the current use case (single-developer, local-first tooling).

What the dashboard does enforce:

- **Input validation**: all POST endpoints validate request bodies through Zod schemas (same constraints as the MCP tool layer) and reject malformed input with structured 400 errors.
- **Security headers**: CSP, X-Frame-Options DENY, nosniff, CORS restricted to localhost origin.
- **Body size limit**: request bodies are capped at 1 MB.
- **Role and session checks**: ticket mutations go through the same `authorizeTicketActor` path as MCP tools, requiring a valid agent session.

What the dashboard does not enforce:

- **Authentication**: no bearer token or API key is required. Localhost reachability is the trust boundary.
- **CSRF protection**: POST endpoints do not check Origin headers beyond CORS preflight.

If the dashboard is ever exposed beyond localhost (reverse proxy, tunneling), authentication and CSRF protection should be added before that change ships.

## Coordination and Audit

Coordination messages and dashboard events are persisted in the repo DB, which gives:

- cross-session visibility
- durable dashboard refresh sources
- replayable operational history

Runtime event logging is separate from ticket history:

- `event_logs` captures tool usage metadata and outcomes
- `ticket_history` captures workflow transitions
- `ticket_comments` captures analysis and human/agent discussion

## Design Boundaries

A few important product boundaries are intentional:

- ticket progression should come from explicit agent actions and review, not board drag-and-drop
- dashboard actions are local operational tools, not a replacement for MCP role semantics
- repo-local ticketing is the primary model; multi-repo and cross-instance federation remain future work
