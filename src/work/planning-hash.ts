import { createHash } from "node:crypto";

/**
 * Compute the SHA-256 (hex) of a work article's `## Planning` section
 * content. Section content runs from the line *after* the `## Planning`
 * header up to (but not including) the next `## ` heading or EOF.
 *
 * Returns `null` when the body has no `## Planning` heading — historical
 * articles authored before the convention existed must not synthesize a
 * hash, otherwise the lint rule would flag the entire pre-existing corpus
 * the moment they next advanced.
 *
 * The hash is computed over the *trimmed* section content so that
 * trailing-blank-line fluctuations from editors do not create false
 * mismatches. Internal whitespace and casing ARE significant — those
 * changes are exactly what the rule wants to surface.
 *
 * Pure. No I/O.
 */
export function computePlanningHash(body: string): string | null {
  const section = extractPlanningSection(body);
  if (section === null) return null;
  return createHash("sha256").update(section, "utf8").digest("hex");
}

/**
 * Pull the `## Planning` section content out of a markdown body. Exposed
 * for tests; production callers should go through `computePlanningHash`.
 */
export function extractPlanningSection(body: string): string | null {
  const lines = body.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^## Planning\s*$/.test(lines[i] ?? "")) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^## /.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }

  return lines.slice(start, end).join("\n").trim();
}
