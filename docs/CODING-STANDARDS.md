# Coding Standards — Monsthera v3

These standards apply to all code in the v3 rewrite. They are enforced during code review.

---

## Module System

- **ESM only.** All packages must have `"type": "module"` in `package.json`.
- **File extensions required.** All imports must include `.js` extensions, enforced by `verbatimModuleSyntax` in `tsconfig.json`.
- **Named exports only.** Default exports are banned. Named exports are better for tree-shaking and refactoring safety.

```ts
// good
export function createArticle() {}
export type { WorkArticle };

// bad
export default function createArticle() {}
```

---

## Type System

- **Zod v4 from day one.** Import from `"zod/v4"`, not `"zod"`.
- **Branded types for all IDs and semantic primitives:**
  - `ArticleId`, `WorkId`, `AgentId`, `SessionId`, `Slug`, `Timestamp`
- **`Result<T, E>` for all fallible operations.** No thrown exceptions for expected failures.

```ts
type Result<T, E = MonstheraError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

// Helper functions
function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
```

- **`any` is banned.** Use `unknown` when the type is genuinely unknown. Enable `noImplicitAny` and `strict` in `tsconfig.json`.

---

## Error Handling

- All errors extend a common `MonstheraError` base class.
- Every error carries a string `code` constant.

**Domain error types:**

| Class | Code example |
|---|---|
| `ValidationError` | `'VALIDATION_FAILED'` |
| `NotFoundError` | `'NOT_FOUND'` |
| `PermissionError` | `'PERMISSION_DENIED'` |
| `StateTransitionError` | `'INVALID_STATE_TRANSITION'` |
| `StorageError` | `'STORAGE_FAILED'` |

- Expected failures (validation, not found, etc.) return `Result.err`.
- Unexpected/fatal errors (programmer errors, infrastructure failures) may throw.

```ts
// good — expected failure
async function findArticle(id: ArticleId): Promise<Result<WorkArticle>> {
  const row = await db.get(id);
  if (!row) return err(new NotFoundError(id));
  return ok(row);
}

// bad — do not throw for expected failures
async function findArticle(id: ArticleId): Promise<WorkArticle> {
  const row = await db.get(id);
  if (!row) throw new Error("not found"); // banned pattern
  return row;
}
```

---

## File Organization

- **300-line soft cap, 500-line hard cap.** Files over 500 lines must be split.
- **One public interface per file** for repository and service contracts.
- **Barrel files (`index.ts`) per domain** — export only the public API. Do not re-export internal implementation details.
- **Test structure mirrors source:**
  - `src/<domain>/` → `tests/unit/<domain>/`
  - Integration tests live in `tests/integration/`

```
src/
  articles/
    article-repository.ts       # interface
    work-article.ts             # domain type
    index.ts                    # public API only
  adapters/
    sqlite-article-repository.ts
tests/
  unit/
    articles/
      work-article.test.ts
  integration/
    article-flow.test.ts
```

---

## Domain Architecture

- **Repository pattern:** interfaces live in domain directories; implementations live in `src/adapters/`.
- **Dependencies via constructor/factory arguments.** No service locator, no global registries.
- **Composition root at `src/core/container.ts`.** This is a plain factory function — no DI framework.
- **Domain code never imports from transport layers** (MCP tools, CLI, dashboard).
- **Transport layers are thin:** validate input → call service → format output.

```ts
// src/core/container.ts
export function createContainer(config: Config): Container {
  const db = openDatabase(config.dbPath);
  const articleRepo = new SqliteArticleRepository(db);
  const articleService = new ArticleService(articleRepo);
  return { articleService };
}
```

---

## Naming Conventions

| Artifact | Convention | Example |
|---|---|---|
| Files | kebab-case | `work-article.ts`, `phase-guards.ts` |
| Types / Interfaces | PascalCase | `WorkArticle`, `KnowledgeArticleRepository` |
| Functions / Variables | camelCase | `createWorkArticle`, `findByPhase` |
| Constants | SCREAMING_SNAKE_CASE | `MAX_ARTICLE_SIZE`, `DEFAULT_PORT` |
| Error codes | SCREAMING_SNAKE_CASE strings | `'VALIDATION_FAILED'`, `'NOT_FOUND'` |

---

## Testing

- **Framework:** Vitest with `globals: true`.
- **File naming:** `*.test.ts`.
- **File placement:** `tests/unit/<domain>/` or `tests/integration/`.
- Each test file covers exactly one module.
- **Integration tests** use `createTestContainer()` with real (or in-memory) infrastructure.
- **Unit tests** use in-memory repository implementations — no real I/O.
- **Coverage targets:**
  - Lines: 80%
  - Functions: 80%
  - Branches: 70%

```ts
// in-memory repository for unit tests
class InMemoryArticleRepository implements ArticleRepository {
  private store = new Map<ArticleId, WorkArticle>();

  async findById(id: ArticleId): Promise<Result<WorkArticle>> {
    const article = this.store.get(id);
    return article ? ok(article) : err(new NotFoundError(id));
  }
  // ...
}
```

---

## Forbidden Patterns (v2 Debt)

These patterns are explicitly banned in v3 and will be rejected in code review.

| Pattern | Reason |
|---|---|
| `ticket`, `council`, `verdict`, `quorum` concepts in v3 core | v2 governance model — do not port |
| `drizzle-orm` or `better-sqlite3` imports | Use repository interfaces; adapters are isolated |
| `console.log` in production code | Use the structured logger |
| Ambient / global state | Everything flows through the composition root |
| Files exceeding 500 lines | Split into focused modules |
| Default exports | Use named exports only |
