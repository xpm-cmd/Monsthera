import type { Result } from "../core/result.js";
import type { StorageError } from "../core/errors.js";
import { ok } from "../core/result.js";
import type { WorkId } from "../core/types.js";

/**
 * Preserves the mapping between v2 ticket IDs and v3 work article IDs.
 *
 * During migration, each imported article stores its original v2 ID as an alias.
 * The AliasStore provides bidirectional lookup so external tools referencing
 * v2 IDs (e.g., old links, scripts) can resolve to v3 articles.
 */
export class AliasStore {
  /** v2 alias → v3 WorkId */
  private readonly aliasToWork = new Map<string, WorkId>();
  /** v3 WorkId → list of v2 aliases */
  private readonly workToAliases = new Map<string, string[]>();

  /** Register a v2 alias for a v3 work article */
  register(alias: string, v3Id: WorkId): void {
    this.aliasToWork.set(alias, v3Id);
    const existing = this.workToAliases.get(v3Id) ?? [];
    if (!existing.includes(alias)) {
      existing.push(alias);
      this.workToAliases.set(v3Id, existing);
    }
  }

  /** Resolve a v2 alias to a v3 WorkId */
  resolve(alias: string): Result<WorkId | undefined, StorageError> {
    return ok(this.aliasToWork.get(alias));
  }

  /** Get all v2 aliases for a v3 WorkId */
  aliasesFor(v3Id: WorkId): Result<readonly string[], StorageError> {
    return ok(this.workToAliases.get(v3Id) ?? []);
  }

  /** Check if a v2 alias has already been migrated */
  has(alias: string): boolean {
    return this.aliasToWork.has(alias);
  }

  /** Number of registered aliases */
  get size(): number {
    return this.aliasToWork.size;
  }
}
