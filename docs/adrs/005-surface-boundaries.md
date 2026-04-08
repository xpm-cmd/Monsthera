# ADR-005: Surface Boundaries

**Status:** Accepted  
**Date:** 2026-04-07  
**Decision makers:** Architecture team

## Context

v2 accumulated domain logic in tool handlers, dashboard API routes, and CLI command bodies. The same business rule was often implemented in multiple places with subtle differences. Adding a new surface (e.g., a REST API in addition to MCP tools) required duplicating logic. Testing required mounting the full transport layer.

v3 targets strict separation: transport layers are thin adapters, domain logic lives exclusively in services.

## Decision

MCP tools, CLI commands, and the dashboard are thin transport layers. Domain logic lives in application services. All surface responses are JSON-serializable.

- Transport layer responsibilities: validate and deserialize input, call the appropriate application service, serialize the result to JSON, map service errors to transport-appropriate error responses.
- Transport layers contain no business logic. Conditional behavior on article state, guard evaluation, phase transitions, and agent dispatch all live in `src/domain/` or `src/app/`.
- Application services receive all dependencies via constructor injection. Services do not import transport-layer types.
- All tool responses, CLI command outputs, and dashboard API responses are JSON-serializable plain objects. No non-serializable types (class instances with methods, Promises, Symbols) cross the transport boundary.
- The dashboard is a read/write client of the domain services. Dashboard routes call the same services as MCP tools and CLI commands — there is no parallel "dashboard domain layer."
- Error handling at the transport layer maps `DomainError` subtypes to appropriate responses: `ValidationError` → 400/invalid_params, `NotFoundError` → 404/not_found, `ConflictError` → 409/conflict, unexpected errors → 500/internal_error.
- Each surface has its own input schema validation (Zod for MCP/CLI, standard schema validation for dashboard routes). Schema validation failures are rejected before the service is called.

## Consequences

### Positive
- Domain services can be unit-tested without any transport-layer setup — inject mock repositories, call the service, assert on the result.
- Adding a new surface (e.g., REST API, gRPC) requires only a new thin adapter; no domain logic is duplicated.
- Consistent JSON output across all surfaces makes surfaces interchangeable from the caller's perspective.
- Error mapping is centralized per transport layer, not scattered through business logic.

### Negative
- Strict layering means more files and more indirection for simple operations — a one-line state query requires a service method, an interface, and a transport handler.
- Constructor injection requires a dependency injection setup or manual wiring; teams unfamiliar with the pattern need onboarding.
- Schema validation duplication across surfaces (MCP, CLI, dashboard) requires keeping three schema definitions in sync with the service method signatures.

### Neutral
- The dashboard consuming domain services means the dashboard and MCP tools share the same eventual consistency guarantees from the storage layer — there is no separate dashboard cache.
- CLI output formatting (tables, colored text) is the CLI transport layer's responsibility. Services return raw data; the CLI formats it.

## Implementation Notes

- Surface directories: `src/surfaces/mcp/`, `src/surfaces/cli/`, `src/surfaces/dashboard/`.
- Application services: `src/app/services/`. Each service class is named `<Entity>Service` (e.g., `WorkArticleService`, `OrchestrationService`).
- Service constructor signature convention: `constructor(private deps: { workRepo: WorkArticleRepository, eventRepo: EventRepository, ... })`.
- Error hierarchy: `src/domain/errors.ts` — `DomainError` base class, subtypes: `ValidationError`, `NotFoundError`, `ConflictError`, `GuardFailedError`.
- MCP tool handler pattern: `validate input with Zod → call service → return { content: [{ type: 'text', text: JSON.stringify(result) }] }`.
- CLI command handler pattern: `parse args → validate → call service → format output → process.stdout.write`.
- Dashboard route handler pattern: `validate request body/params → call service → res.json(result)`.
- No `try/catch` inside services for expected domain errors — throw typed errors upward. Transport layers own the catch boundary.
