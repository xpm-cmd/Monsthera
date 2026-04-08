# Phase 8: Migration — Session Prompt

## Project context

Monsthera v3 is a clean rewrite of a knowledge-native development platform for AI coding agents. It replaces the v2 ticket/council/SQLite model with article-based knowledge, work articles with lifecycle guards, and Dolt-backed persistence.

## Phase status

| Phase | Name | Status | Commit |
|-------|------|--------|--------|
| 0 | Bootstrap | Complete | `8a13a57` |
| 1 | Foundation | Complete | `d395a9a`, `b930c6c`, `6680af1` |
| 2 | Knowledge system | Complete | `1e9fc52` |
| 3 | Work article system | Complete | `6953c33`, `398208b` |
| 4 | Search and retrieval | Complete | `ffcd2bb` |
| 5 | Persistence | Complete | `a8e3430` |
| 6 | Surfaces | Complete | `e6275d3` |
| 7 | Orchestration | Complete | `4302741` |
| 8 | Migration | **This phase** |
| 9 | Hardening | Pending |

**Branch:** `rewrite/v3`
**Test count:** 674 tests, 34 test files, all passing
**Typecheck:** Clean (`pnpm typecheck` passes with zero errors)

## Canonical documents (read these first)

All in `MonstheraV3/` directory (untracked, present on disk):

1. **`monsthera-architecture-v6-final.md`** — Full architecture. Section 9.4 defines the migration boundary: "The migration layer can talk to v2 SQLite. The v3 core cannot."
2. **`monsthera-ticket-as-article-design.md`** — Work article design, lifecycle model.
3. **`monsthera-v3-implementation-plan-final.md`** — Implementation plan. Section 4, Phase 8 deliverables: v2 import tooling, dry-run, validation reports, alias preservation.

## What Phase 8 must deliver

### 8.1 v2 data model understanding

The v2 system uses SQLite with these core entities:
- **Tickets** — the v2 equivalent of work articles (title, description, status, priority, assignee, labels)
- **Council/Quorum** — replaced by enrichment roles and review assignments in v3
- **Verdicts** — replaced by review status in v3
- **Sessions** — agent interaction sessions
- **Evidence bundles** — structured data attached to tickets

Phase 8 needs to read the v2 SQLite database and map its entities to v3 articles.

### 8.2 Migration service

Create `src/migration/` module with:

```typescript
interface MigrationService {
  // Analyze v2 database and return migration plan
  analyzeSources(sqlitePath: string): Promise<Result<MigrationPlan, MigrationError>>

  // Execute migration in dry-run mode (no writes)
  dryRun(plan: MigrationPlan): Promise<Result<DryRunReport, MigrationError>>

  // Execute migration (write to v3 repositories)
  execute(plan: MigrationPlan): Promise<Result<MigrationResult, MigrationError>>

  // Validate migrated data against v2 source
  validate(sqlitePath: string): Promise<Result<ValidationReport, MigrationError>>
}
```

### 8.3 Entity mapping

Map v2 entities to v3:

| v2 Entity | v3 Entity | Notes |
|-----------|-----------|-------|
| Ticket | WorkArticle | Map status→phase, labels→tags |
| Ticket description | WorkArticle content | Convert to markdown with sections |
| Council verdict | ReviewAssignment | Map verdict→review status |
| Evidence bundle | Knowledge article ref | Link as references |
| Ticket aliases | WorkArticle ID aliases | Preserve for backward compatibility |

### 8.4 Migration plan data types

```typescript
interface MigrationPlan {
  readonly sourceStats: { tickets: number; sessions: number; evidence: number };
  readonly mappings: readonly EntityMapping[];
  readonly warnings: readonly string[];
}

interface EntityMapping {
  readonly v2Type: string;
  readonly v2Id: string;
  readonly v3Type: "work" | "knowledge";
  readonly proposedTitle: string;
  readonly proposedTemplate: WorkTemplate;
  readonly proposedPhase: WorkPhase;
}

interface DryRunReport {
  readonly wouldCreate: number;
  readonly wouldSkip: number;
  readonly conflicts: readonly string[];
  readonly warnings: readonly string[];
}

interface MigrationResult {
  readonly created: number;
  readonly skipped: number;
  readonly errors: readonly string[];
  readonly aliasMap: Record<string, string>; // v2Id → v3Id
}

interface ValidationReport {
  readonly totalChecked: number;
  readonly valid: number;
  readonly invalid: number;
  readonly issues: readonly ValidationIssue[];
}
```

### 8.5 Alias preservation

v2 tickets may be referenced by their IDs in agent conversations and external systems. The migration must:
- Create a v2Id→v3Id alias map
- Expose an alias lookup method: `resolveAlias(v2Id: string) → v3Id | null`
- Store alias mappings persistently (Dolt table or in-memory map)

### 8.6 MCP tools for migration

Add migration tools to the MCP server:
- `analyze_v2_source` — analyze a v2 SQLite database
- `dry_run_migration` — preview what would be migrated
- `execute_migration` — run the migration
- `validate_migration` — validate migrated data
- `resolve_alias` — look up a v2 ID alias

### 8.7 Wire into container

Update `src/core/container.ts` to:
- Create and expose `MigrationService` in the container interface
- Wire it with v3 repositories and logger
- Migration service should be lazy-initialized (only created when needed)

## Key files to read

| File | Purpose |
|------|---------|
| `src/core/container.ts` | Dependency container — wire migration service here |
| `src/core/config.ts` | Config schema — may need migration section |
| `src/knowledge/repository.ts` | KnowledgeArticle type and repository |
| `src/work/repository.ts` | WorkArticle type and repository |
| `src/work/templates.ts` | Template configs for mapping v2 ticket types |
| `src/tools/orchestration-tools.ts` | Tool pattern to follow for migration tools |
| `src/server.ts` | MCP server — register migration tools |
| `src/persistence/index.ts` | Dolt persistence layer |

## Architecture rules (Section 9.4)

1. **Migration boundary** — The migration layer can talk to v2 SQLite. The v3 core cannot.
2. **Edge concern** — Migration is not a core domain concern; it's a one-time import tool.
3. **Repository interfaces** — Migration writes through v3 repository interfaces, never directly to Dolt.
4. **Dry-run first** — Always support previewing before writing.
5. **Alias preservation** — v2 references must remain resolvable after migration.

## Existing patterns to follow

- All service methods return `Result<T, E>` — never throw
- Services take dependencies via constructor injection
- Container creates and wires all services
- Tests use in-memory repositories and `createLogger({ level: "warn", domain: "test" })`
- MCP tools follow the pattern in `src/tools/knowledge-tools.ts` and `src/tools/orchestration-tools.ts`

## Data types to define

See section 8.4 above for the full type definitions.

## Workflow

1. Claude (Opus) plans each sub-deliverable
2. Claude implements using agents for parallel work
3. Submit to Codex for review (`node codex-companion.mjs review`)
4. Fix all findings
5. Run `pnpm test && pnpm typecheck` before committing
6. Commit with descriptive message

## Test expectations

- Migration service: test analyzeSources, dryRun, execute, validate
- Entity mapping: test each v2→v3 mapping path
- Alias preservation: test alias creation and resolution
- MCP tools: test input validation and result formatting
- Dry-run: verify no writes occur during dry-run mode
- Validation: test mismatch detection between v2 source and v3 state
- Target: ~25-35 new tests

## Pre-existing lint issues

The following lint errors exist from previous phases and are NOT introduced by Phase 8:
- `src/persistence/dolt-knowledge-repository.ts` — type import issues
- `src/persistence/dolt-orchestration-repository.ts` — unused imports
- `src/persistence/dolt-work-helpers.ts` — unused imports
- `src/persistence/dolt-work-repository.ts` — type import issues
- `src/core/container.ts:100` — unused `healthPromise` variable

Do not fix these unless they interfere with your work.
