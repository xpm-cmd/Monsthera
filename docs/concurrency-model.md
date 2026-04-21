# Concurrency model — work article mutations (2026-04-21)

This note describes the concurrency semantics of the work-article mutation surface as of v3.0.0-alpha.7, based on an investigation triggered by the `work enrich` question: "is a concurrent enrichment from two subagents atomic, or last-write-wins?"

**Short answer.** Every mutation (`contributeEnrichment`, `assignReviewer`, `submitReview`, `addDependency`, `removeDependency`, `updateWork`, `advancePhase`) is an unprotected read-modify-write cycle. Two concurrent writers to the same article in the **same process** (i.e. a single MCP server handling two overlapping calls) reliably lose one write. Two concurrent writers in **separate processes** (two CLI invocations) are effectively serialised by process-boot latency and rarely — but not never — lose writes.

The service layer's shape is the root cause, not any adapter detail; both `InMemoryWorkArticleRepository` and `FileWorkArticleRepository` exhibit it.

## What `work enrich` does today

`work enrich <id> --role <role> --status <contributed|skipped>` routes to `WorkService.contributeEnrichment`, which calls the repository's same-name method. Shape for the file adapter (`src/work/file-repository.ts:420`):

```ts
async contributeEnrichment(id, role, status) {
  const existing = await this.getMutable(id);               // read
  // ... find role in existing.value.enrichmentRoles, swap its status
  return this.writeArticle({ ...existing.value, ... });     // write
}
```

Two important properties:

1. **`contributeEnrichment` does NOT append a `## <Role> Perspective` body section.** It only flips the role entry in the `enrichmentRoles` frontmatter array (`status`, `contributedAt`). Body content is expected to be written separately by `work update --content-file`, which is *also* last-write-wins.
2. **No version check / optimistic lock / file lock.** Between `getMutable` and `writeArticle`, another caller can read the same state, modify a *different* role, and write. Whichever `writeArticle` lands second overwrites the other's mutation, because the second write serialises the entire frontmatter — including the now-stale role entries it read earlier.

The same pattern is used by `assignReviewer`, `submitReview`, `addDependency`, `removeDependency`, and `advancePhase`. `updateWork` (applied fields like `title`, `priority`, `tags`, `content`) is the same read-modify-write via `repository.update(id, input)`.

## Measured race behaviour

### In-process (MCP server hot-path, `Promise.all`)

Script: `scripts/race-enrich.ts` (not part of the test suite; ad-hoc repro).

```
async () => Promise.all([
  workService.contributeEnrichment(id, "architecture", "contributed"),
  workService.contributeEnrichment(id, "testing", "contributed"),
])
```

Result: **20/20 rounds lost one write.** The second-resolving call's `writeArticle` clobbers the first. Output snippet:

```
round 19: LOST WRITE — contributed=1, roles=[
  {"role":"architecture","status":"pending"},      // first writer's mutation lost
  {"role":"testing","status":"contributed"}        // second writer's mutation survived
]
Lost writes: 20 / 20
```

This is the hot-path the MCP server exercises whenever two clients (or one client issuing two parallel tool calls) target the same article.

### Out-of-process (two CLI invocations)

```
node dist/bin.js work enrich <id> --role architecture --status contributed &
node dist/bin.js work enrich <id> --role testing      --status contributed &
wait
```

Result: **0/10 rounds lost a write** on the test machine. Explanation: each `node dist/bin.js …` invocation takes ~150–300 ms from process spawn to the actual file write (container boot, logger init, config load, Ollama probe). That latency effectively serialises the two invocations even though they are parallel at the shell level.

This is a fragile property, not a guarantee:
- a faster host, a smaller `dist/bin.js`, or the MCP-server transport will shrink the window;
- `advancePhase` on a template with an async guard can also slide the timing either direction.

So: **the CLI is currently safe by accident, not by design.** Relying on it is a latent footgun, especially for teams who plan to wire the MCP server into an orchestrator that issues several enrich/review calls concurrently per article.

## Scope of the problem

Every mutation in `src/work/file-repository.ts` that goes through `writeArticle` is susceptible:

| Method                  | Conflict domain                               |
|-------------------------|-----------------------------------------------|
| `update`                | Any two updates to the same article.          |
| `advancePhase`          | Two advances (or advance + any other mutation). |
| `contributeEnrichment`  | Two enrichments for different roles.          |
| `assignReviewer`        | Two reviewer adds.                            |
| `submitReview`          | Two reviews from different reviewers.         |
| `addDependency`         | Two deps added in parallel.                   |
| `removeDependency`      | Two removes (or add + remove).                |

`InMemoryWorkArticleRepository` has the same structural pattern — it's just invisible because single-threaded JS happens to resolve the `Promise.resolve`-returning reads in FIFO order within one microtask tick; schedule them across the event loop and the same race fires.

`DoltWorkArticleRepository` (when enabled) backs the same interface with MySQL-compatible SQL. That path could use row-level locking, but at present the repository interface does not expose a "compare-and-swap" primitive, so the Dolt adapter necessarily mirrors the last-write-wins semantic to satisfy the interface.

## Recommended fix directions (not implemented; this doc is research-only)

Three options, increasing order of invasiveness. **None of these are being merged as part of this investigation** — any of them would alter the repository interface and deserve its own ADR + PR.

### 1. Role-level write guard in `contributeEnrichment` only

Cheapest. Before `writeArticle`, re-read and verify the role entry's `contributedAt` hasn't changed since the first read. On mismatch, return a `CONCURRENCY_CONFLICT` error with retry guidance.

- Pro: fixes the most common "two subagents enriching at once" case.
- Con: only touches `contributeEnrichment`. The other six mutations stay racy. Also introduces a new error code that MCP clients must handle.

### 2. Optimistic concurrency control via `updatedAt` version

Add a required `ifUpdatedAt: Timestamp` parameter to every mutation. Repository compares on read; if the stored `updatedAt` ≠ the caller's expected value, return `CONCURRENCY_CONFLICT`. Callers (CLI, MCP tool, dashboard) fetch first, pass the value they observed, retry on conflict.

- Pro: uniform model, matches how HTTP `If-Match` / ETag flows work.
- Con: every mutation signature changes; all transports need to thread the version; tests need retry loops.

### 3. Per-article serialisation in the service layer

Add a keyed async mutex in `WorkService` (e.g. a `Map<WorkId, Promise<void>>`), and gate every mutation method behind it. Concurrent calls for the *same* id serialise at the service; concurrent calls for different ids still run in parallel.

- Pro: invisible to callers; no interface change; fixes all seven mutations at once.
- Con: only protects in-process concurrency. Two separate processes (two CLI invocations, or dashboard + MCP server) still race through the filesystem. Multi-process safety would still need either (1) or (2) on top.

## Next-step proposal

Open an issue titled "Work-article mutation concurrency" with this note linked. Given the surface area (seven mutations across two transports plus the dashboard), a proper fix warrants:
- An ADR (`docs/adrs/007-work-article-concurrency.md`) describing the chosen approach.
- A new error code (`CONCURRENCY_CONFLICT`) wired through `MonstheraError` + `mapErrorToHttp`.
- A companion test suite (`tests/integration/work-concurrency.test.ts`) that exercises each mutation with `Promise.all(…)` and asserts either success-without-loss or a CONFLICT error.

Until then, consumers should treat `work enrich` — and every other work-article mutation — as **single-writer per article**. Serialise in the orchestrator, or accept occasional silent loss.
