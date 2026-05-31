import type { Result } from "../core/result.js";
import { ok, err } from "../core/result.js";

/**
 * Custom-frontmatter query (PR-14a, ADR-020 P2). Parses and applies a
 * `custom.<key><op><value>` filter against an article's free-form
 * `extraFrontmatter` bag — an in-memory layer over `list_articles` /
 * `knowledge list`, mirroring the existing `tag` / `hasCodeRefs` filters
 * rather than introducing a query language.
 *
 * Equality (`=`) is string-based (the stored scalar is coerced with `String`).
 * `<`, `<=`, `>`, `>=` are numeric. Only scalar values (string/number/boolean)
 * are filterable; objects and arrays are stored and returned verbatim but never
 * match (ADR-012 — no silent coercion or truncation).
 */

export type CustomFilterOp = "=" | "<" | "<=" | ">" | ">=";

export interface CustomFilter {
  readonly key: string;
  readonly op: CustomFilterOp;
  /** The comparison value exactly as written. */
  readonly value: string;
  /** Parsed numeric form; present iff `op` is a comparison (`<`/`<=`/`>`/`>=`). */
  readonly numeric?: number;
}

const PREFIX = "custom.";

/**
 * Parse a `custom.<key><op><value>` expression. The *leftmost* operator is the
 * separator, so operators embedded in an equality value (e.g. `custom.note=a<b`)
 * are preserved. Returns a human-readable message on malformed input rather than
 * silently matching nothing.
 */
export function parseCustomFilter(expr: string): Result<CustomFilter, string> {
  const trimmed = expr.trim();
  if (!trimmed.startsWith(PREFIX)) {
    return err(`filter must start with "custom." (got "${expr}")`);
  }
  const rest = trimmed.slice(PREFIX.length);

  let op: CustomFilterOp | undefined;
  let opIdx = -1;
  for (let i = 0; i < rest.length; i++) {
    const two = rest.slice(i, i + 2);
    if (two === "<=" || two === ">=") {
      op = two;
      opIdx = i;
      break;
    }
    const one = rest[i];
    if (one === "<" || one === ">" || one === "=") {
      op = one;
      opIdx = i;
      break;
    }
  }

  if (op === undefined) {
    return err(`filter must contain one of =, <, <=, >, >= (got "${expr}")`);
  }
  const key = rest.slice(0, opIdx).trim();
  const value = rest.slice(opIdx + op.length).trim();
  if (key.length === 0) return err(`filter is missing a key before "${op}"`);
  if (value.length === 0) return err(`filter is missing a value after "${op}"`);

  if (op === "=") {
    return ok({ key, op, value });
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return err(`filter "${op}" needs a numeric value (got "${value}")`);
  }
  return ok({ key, op, value, numeric });
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** Coerce a scalar to a finite number, or NaN if it isn't numeric (booleans never qualify). */
function toNumber(value: string | number | boolean): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return NaN; // booleans are not numerically comparable
}

/**
 * True if `extraFrontmatter[filter.key]` is a scalar that satisfies the filter.
 * Missing keys, absent frontmatter, and non-scalar values all fail to match.
 */
export function matchesCustomFilter(
  extraFrontmatter: Readonly<Record<string, unknown>> | undefined,
  filter: CustomFilter,
): boolean {
  const raw = extraFrontmatter?.[filter.key];
  if (!isScalar(raw)) return false;

  if (filter.op === "=") {
    return String(raw) === filter.value;
  }

  const lhs = toNumber(raw);
  if (!Number.isFinite(lhs)) return false;
  const rhs = filter.numeric as number;
  switch (filter.op) {
    case "<":
      return lhs < rhs;
    case "<=":
      return lhs <= rhs;
    case ">":
      return lhs > rhs;
    case ">=":
      return lhs >= rhs;
  }
}
