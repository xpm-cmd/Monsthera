import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod/v4";

/**
 * A single labelled retrieval case: for `query`, the articles in
 * `expectedArticleIds` are the human-judged correct answers. The harness
 * measures how well retrieval surfaces them. IDs reference real, committed
 * articles in `knowledge/` so the golden set is reproducible in CI.
 *
 * `expectedArticleIds` stays required-min-1: a pure no-answer negative would
 * zero out P@k/NDCG (the ideal ranking is empty) and pollute the aggregate
 * with un-scoreable cases. The cleaner negative signal is `forbiddenArticleIds`
 * — distractor articles that are *known wrong* for this query and must NOT
 * appear in the top-k. The harness counts how many of them leak in
 * (`contamination`); zero is clean. This guards precision/false-positives
 * additively, without touching the relevance math.
 */
export const GoldenCaseSchema = z.object({
  query: z.string().min(1),
  mode: z.enum(["general", "code", "research"]).optional(),
  type: z.enum(["knowledge", "work", "all"]).optional(),
  expectedArticleIds: z.array(z.string().min(1)).min(1),
  /**
   * Optional distractor ids that must NOT surface in the top-k for this query.
   * A precision guardrail: if retrieval starts dragging these in, contamination
   * rises even when the expected ids are still present.
   */
  forbiddenArticleIds: z.array(z.string().min(1)).optional(),
  note: z.string().optional(),
});

export type GoldenCase = z.infer<typeof GoldenCaseSchema>;

/**
 * Load and validate every `*.json` file in `dir` as an array of golden
 * cases. Throws (with the offending file in the message) on malformed JSON
 * or schema mismatch — a broken golden set should fail loudly, not silently
 * skew the metrics.
 */
export function loadGoldenCases(dir: string): GoldenCase[] {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const cases: GoldenCase[] = [];
  for (const file of files) {
    const full = path.join(dir, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(full, "utf-8"));
    } catch (e) {
      throw new Error(`Invalid JSON in golden file ${full}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const result = GoldenCaseSchema.array().safeParse(parsed);
    if (!result.success) {
      throw new Error(`Golden file ${full} does not match schema: ${JSON.stringify(result.error.issues)}`);
    }
    cases.push(...result.data);
  }
  return cases;
}
