/**
 * Benchmark: FTS5-only vs FTS5+Rerank vs Hybrid (FTS5 ∪ Vector)
 *
 * Measures relevance, latency, and ranking quality across 3 query categories:
 *   1. Keyword queries (FTS5 should excel)
 *   2. Natural language queries (semantic should help)
 *   3. Conceptual queries (no keyword overlap — hybrid advantage)
 *
 * Each query has manually curated "expected top files" to score relevance.
 *
 * Usage: npx tsx benchmarks/semantic-vs-fts5.ts
 */

import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import { FTS5Backend } from "../src/search/fts5.js";
import { SemanticReranker, buildEmbeddingText, mergeResults } from "../src/search/semantic.js";
import { initDatabase } from "../src/db/init.js";
import { fullIndex } from "../src/indexing/indexer.js";

// ─── Test Queries ────────────────────────────────────────────

interface BenchQuery {
  query: string;
  category: "keyword" | "natural_language" | "conceptual";
  expectedFiles: string[];
}

const QUERIES: BenchQuery[] = [
  // Keyword (exact token match)
  { query: "createServer", category: "keyword", expectedFiles: ["src/server.ts"] },
  { query: "FTS5Backend search", category: "keyword", expectedFiles: ["src/search/fts5.ts"] },
  { query: "registerAgent", category: "keyword", expectedFiles: ["src/agents/registry.ts"] },
  { query: "buildEvidenceBundle", category: "keyword", expectedFiles: ["src/retrieval/evidence-bundle.ts"] },
  // Natural Language
  { query: "how does trust enforcement work", category: "natural_language", expectedFiles: ["src/trust/tiers.ts", "docs/trust-tiers.md"] },
  { query: "how are search results ranked and scored", category: "natural_language", expectedFiles: ["src/search/router.ts", "src/search/fts5.ts", "src/search/semantic.ts"] },
  { query: "what happens when an agent connects to agora", category: "natural_language", expectedFiles: ["src/agents/registry.ts", "src/server.ts"] },
  // Conceptual (no keyword overlap)
  { query: "what prevents two agents from editing the same file", category: "conceptual", expectedFiles: ["src/agents/registry.ts", "src/coordination/bus.ts"] },
  { query: "how does the system ensure code changes are safe", category: "conceptual", expectedFiles: ["src/patches/validator.ts", "src/trust/tiers.ts", "src/trust/secret-patterns.ts"] },
  { query: "how is sensitive information protected from leaking", category: "conceptual", expectedFiles: ["src/trust/secret-patterns.ts", "src/trust/tiers.ts"] },
];

// ─── Scoring ─────────────────────────────────────────────────

function precisionAtK(results: string[], expected: string[], k: number): number {
  const topK = results.slice(0, k);
  const hits = topK.filter((r) => expected.some((e) => r.includes(e) || e.includes(r)));
  return topK.length > 0 ? hits.length / topK.length : 0;
}

function recallAtK(results: string[], expected: string[], k: number): number {
  const topK = results.slice(0, k);
  const found = expected.filter((e) => topK.some((r) => r.includes(e) || e.includes(r)));
  return expected.length > 0 ? found.length / expected.length : 0;
}

function computeMRR(results: string[], expected: string[]): number {
  for (let i = 0; i < results.length; i++) {
    if (expected.some((e) => results[i]!.includes(e) || e.includes(results[i]!))) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

// ─── Main ────────────────────────────────────────────────────

interface ModeResult {
  paths: string[];
  ms: number;
  p5: number;
  r5: number;
  mrr: number;
}

async function main() {
  const repoPath = process.cwd();

  console.log("================================================================");
  console.log("  Agora Benchmark: FTS5 vs Rerank vs Hybrid");
  console.log("================================================================\n");

  // Initialize database (auto-creates if missing)
  const { db, sqlite } = initDatabase({ repoPath, agoraDir: ".agora", dbName: "agora.db" });

  // Ensure repo exists
  let repo = sqlite.prepare("SELECT id FROM repos LIMIT 1").get() as { id: number } | undefined;
  if (!repo) {
    console.log("No repo found. Creating repo + indexing...");
    db.insert(schema.repos).values({
      path: repoPath,
      name: "Agora",
      createdAt: new Date().toISOString(),
    }).run();
    repo = sqlite.prepare("SELECT id FROM repos LIMIT 1").get() as { id: number };
  }
  const repoId = repo.id;

  // Index files if none exist
  let fileCount = (sqlite.prepare("SELECT COUNT(*) as c FROM files WHERE repo_id = ?").get(repoId) as any).c;
  if (fileCount === 0) {
    console.log("No files indexed. Running full index...");
    const result = await fullIndex({
      repoPath,
      repoId,
      db,
      onProgress: (msg) => console.log(`  [index] ${msg}`),
    });
    console.log(`Indexed ${result.filesIndexed} files in ${result.durationMs}ms\n`);
    fileCount = result.filesIndexed;
  }

  const embCount = (sqlite.prepare("SELECT COUNT(*) as c FROM files WHERE repo_id = ? AND embedding IS NOT NULL").get(repoId) as any).c;
  console.log(`Files: ${fileCount} | Embeddings: ${embCount}`);

  // Always regenerate embeddings to use enriched text
  {
    console.log("\nGenerating enriched embeddings...");
    sqlite.prepare("UPDATE files SET embedding = NULL WHERE repo_id = ?").run(repoId);
    const sem = new SemanticReranker({ sqlite, db });
    if (!(await sem.initialize())) { console.error("Model failed."); process.exit(1); }
    const files = db.select().from(schema.files).where(eq(schema.files.repoId, repoId)).all();
    let count = 0;
    for (const file of files) {
      const imports = db.select()
        .from(schema.imports)
        .where(eq(schema.imports.sourceFileId, file.id))
        .all()
        .map((i) => i.targetPath);

      const text = buildEmbeddingText({
        path: file.path,
        language: file.language,
        summary: file.summary ?? "",
        symbolsJson: file.symbolsJson ?? "[]",
        imports: imports.length > 0 ? imports : undefined,
      });
      const emb = await sem.embed(text);
      if (emb) { sem.storeEmbedding(file.id, emb); count++; }
    }
    console.log(`Generated ${count} enriched embeddings.\n`);
  }

  // Setup
  const fts5 = new FTS5Backend(sqlite, db);
  fts5.initFtsTable();
  fts5.rebuildIndex(repoId);

  const semantic = new SemanticReranker({ sqlite, db });
  if (!(await semantic.initialize())) { console.error("Semantic model failed."); process.exit(1); }

  console.log(`\nRunning ${QUERIES.length} queries x 3 modes...\n`);

  // Warmup
  await fts5.search("warmup", repoId, 5);
  await semantic.embed("warmup");
  await semantic.vectorSearch("warmup", repoId, 5);

  interface QR {
    query: string; category: string;
    fts5: ModeResult;
    rerank: ModeResult;
    hybrid: ModeResult;
  }
  const results: QR[] = [];

  for (const q of QUERIES) {
    // Mode 1: FTS5 only
    const t0 = performance.now();
    const fts5Res = await fts5.search(q.query, repoId, 5);
    const fts5Ms = performance.now() - t0;
    const fts5P = fts5Res.map((r) => r.path);

    // Mode 2: FTS5 + Semantic rerank
    const t1 = performance.now();
    const wide = await fts5.search(q.query, repoId, 20);
    const reranked = await semantic.rerank(q.query, wide, repoId, 5);
    const rerankMs = performance.now() - t1;
    const rerankP = reranked.map((r) => r.path);

    // Mode 3: Hybrid (FTS5 ∪ Vector → merge)
    const t2 = performance.now();
    const fts5ForHybrid = await fts5.search(q.query, repoId, 5);
    const vectorRes = await semantic.vectorSearch(q.query, repoId, 5);
    const hybridRes = mergeResults(fts5ForHybrid, vectorRes, 5);
    const hybridMs = performance.now() - t2;
    const hybridP = hybridRes.map((r) => r.path);

    const score = (paths: string[]) => ({
      paths,
      ms: 0,
      p5: precisionAtK(paths, q.expectedFiles, 5),
      r5: recallAtK(paths, q.expectedFiles, 5),
      mrr: computeMRR(paths, q.expectedFiles),
    });

    results.push({
      query: q.query, category: q.category,
      fts5: { ...score(fts5P), ms: fts5Ms },
      rerank: { ...score(rerankP), ms: rerankMs },
      hybrid: { ...score(hybridP), ms: hybridMs },
    });
  }

  // ─── Print Per-Query ───────────────────────────────────
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`.padStart(5);
  const msf = (n: number) => `${n.toFixed(1)}ms`.padStart(8);
  const pad = (s: string, n: number) => s.slice(0, n).padEnd(n);

  console.log("Per-Query Results:");
  console.log("-".repeat(130));
  console.log(`  ${"Query".padEnd(42)} | ${"FTS5-only".padEnd(25)} | ${"Rerank".padEnd(25)} | ${"Hybrid".padEnd(25)}`);
  console.log(`  ${"".padEnd(42)} | P@5  R@5  MRR  Latency  | P@5  R@5  MRR  Latency  | P@5  R@5  MRR  Latency`);
  console.log("-".repeat(130));

  for (const r of results) {
    const tag = r.category === "keyword" ? "[KEY]" : r.category === "natural_language" ? "[NL] " : "[CON]";
    const col = (m: ModeResult) => `${pct(m.p5)} ${pct(m.r5)} ${pct(m.mrr)} ${msf(m.ms)}`;
    console.log(
      `  ${pad(tag + " " + r.query, 42)} | ${col(r.fts5)} | ${col(r.rerank)} | ${col(r.hybrid)}`
    );
  }
  console.log("-".repeat(130));

  // ─── Aggregate ─────────────────────────────────────────
  const avg = (items: QR[], key: "fts5" | "rerank" | "hybrid") => {
    const n = items.length;
    return {
      p5: items.reduce((s, r) => s + r[key].p5, 0) / n,
      r5: items.reduce((s, r) => s + r[key].r5, 0) / n,
      mrr: items.reduce((s, r) => s + r[key].mrr, 0) / n,
      ms: items.reduce((s, r) => s + r[key].ms, 0) / n,
    };
  };

  console.log("\nAggregate by Category:");
  console.log("-".repeat(110));
  console.log(`  ${"Category".padEnd(22)} | ${"FTS5-only".padEnd(24)} | ${"Rerank".padEnd(24)} | ${"Hybrid".padEnd(24)}`);
  console.log(`  ${"".padEnd(22)} | P@5  R@5  MRR    ms   | P@5  R@5  MRR    ms   | P@5  R@5  MRR    ms`);
  console.log("-".repeat(110));

  for (const cat of ["keyword", "natural_language", "conceptual"] as const) {
    const cr = results.filter((r) => r.category === cat);
    if (cr.length === 0) continue;
    const f = avg(cr, "fts5");
    const rr = avg(cr, "rerank");
    const h = avg(cr, "hybrid");
    const label = cat === "keyword" ? "Keyword" : cat === "natural_language" ? "Natural Language" : "Conceptual";
    const col = (m: { p5: number; r5: number; mrr: number; ms: number }) => `${pct(m.p5)} ${pct(m.r5)} ${pct(m.mrr)} ${msf(m.ms)}`;
    console.log(`  ${pad(`${label} (${cr.length})`, 22)} | ${col(f)} | ${col(rr)} | ${col(h)}`);
  }

  const af = avg(results, "fts5");
  const ar = avg(results, "rerank");
  const ah = avg(results, "hybrid");
  const col = (m: { p5: number; r5: number; mrr: number; ms: number }) => `${pct(m.p5)} ${pct(m.r5)} ${pct(m.mrr)} ${msf(m.ms)}`;
  console.log("-".repeat(110));
  console.log(`  ${pad(`OVERALL (${results.length})`, 22)} | ${col(af)} | ${col(ar)} | ${col(ah)}`);
  console.log("-".repeat(110));

  // ─── Delta ─────────────────────────────────────────────
  const delta = (base: number, target: number) => base > 0 ? ((target - base) / base * 100) : 0;

  console.log("\nDelta vs FTS5-only:");
  console.log(`  Rerank:  P@5 ${delta(af.p5, ar.p5) >= 0 ? "+" : ""}${delta(af.p5, ar.p5).toFixed(1)}%  R@5 ${delta(af.r5, ar.r5) >= 0 ? "+" : ""}${delta(af.r5, ar.r5).toFixed(1)}%  MRR ${delta(af.mrr, ar.mrr) >= 0 ? "+" : ""}${delta(af.mrr, ar.mrr).toFixed(1)}%  Latency +${(ar.ms - af.ms).toFixed(1)}ms`);
  console.log(`  Hybrid:  P@5 ${delta(af.p5, ah.p5) >= 0 ? "+" : ""}${delta(af.p5, ah.p5).toFixed(1)}%  R@5 ${delta(af.r5, ah.r5) >= 0 ? "+" : ""}${delta(af.r5, ah.r5).toFixed(1)}%  MRR ${delta(af.mrr, ah.mrr) >= 0 ? "+" : ""}${delta(af.mrr, ah.mrr).toFixed(1)}%  Latency +${(ah.ms - af.ms).toFixed(1)}ms`);

  // ─── Side-by-side ──────────────────────────────────────
  console.log("\n\nSide-by-Side Rankings:");
  console.log("=".repeat(130));

  for (const r of results) {
    const q = QUERIES.find((q) => q.query === r.query)!;
    const tag = r.category === "keyword" ? "[KEY]" : r.category === "natural_language" ? "[NL]" : "[CON]";
    console.log(`\n${tag} "${r.query}"`);
    console.log(`  Expected: [${q.expectedFiles.join(", ")}]`);
    console.log(`  FTS5-only                          | Rerank                           | Hybrid`);
    const maxLen = Math.max(r.fts5.paths.length, r.rerank.paths.length, r.hybrid.paths.length);
    for (let i = 0; i < maxLen; i++) {
      const fp = r.fts5.paths[i] ?? "-";
      const rp = r.rerank.paths[i] ?? "-";
      const hp = r.hybrid.paths[i] ?? "-";
      const fm = q.expectedFiles.some((e) => fp.includes(e)) ? "+" : " ";
      const rm = q.expectedFiles.some((e) => rp.includes(e)) ? "+" : " ";
      const hm = q.expectedFiles.some((e) => hp.includes(e)) ? "+" : " ";
      console.log(`  ${(i+1+".").padEnd(3)} ${fm} ${fp.padEnd(33)} | ${(i+1+".").padEnd(3)} ${rm} ${rp.padEnd(33)} | ${(i+1+".").padEnd(3)} ${hm} ${hp}`);
    }
  }

  // ─── Alpha Sweep ────────────────────────────────────────
  console.log("\n\n================================================================");
  console.log("  Alpha Sweep: Hybrid search with varying alpha");
  console.log("  alpha = weight given to vector (1-alpha = weight to FTS5)");
  console.log("================================================================\n");

  // Cache FTS5 + vector results per query (avoid recomputation)
  const cachedPairs: Array<{
    query: BenchQuery;
    fts5Res: Awaited<ReturnType<typeof fts5.search>>;
    vectorRes: Awaited<ReturnType<typeof semantic.vectorSearch>>;
  }> = [];

  for (const q of QUERIES) {
    const fts5Res = await fts5.search(q.query, repoId, 5);
    const vectorRes = await semantic.vectorSearch(q.query, repoId, 5);
    cachedPairs.push({ query: q, fts5Res, vectorRes });
  }

  const ALPHAS = [0.0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0];

  // Per-alpha aggregate metrics
  console.log("-".repeat(80));
  console.log(`  ${"Alpha".padEnd(8)} | ${"P@5".padStart(6)} ${"R@5".padStart(6)} ${"MRR".padStart(6)} | ${"KW R@5".padStart(7)} ${"NL R@5".padStart(7)} ${"CON R@5".padStart(8)} | Note`);
  console.log("-".repeat(80));

  let bestAlpha = 0;
  let bestScore = -1; // R@5 + MRR combined

  for (const alpha of ALPHAS) {
    const alphaResults: Array<{ category: string; p5: number; r5: number; mrr: number }> = [];

    for (const { query: q, fts5Res, vectorRes } of cachedPairs) {
      const merged = mergeResults(fts5Res, vectorRes, 5, alpha);
      const paths = merged.map((r) => r.path);
      alphaResults.push({
        category: q.category,
        p5: precisionAtK(paths, q.expectedFiles, 5),
        r5: recallAtK(paths, q.expectedFiles, 5),
        mrr: computeMRR(paths, q.expectedFiles),
      });
    }

    const n = alphaResults.length;
    const overall = {
      p5: alphaResults.reduce((s, r) => s + r.p5, 0) / n,
      r5: alphaResults.reduce((s, r) => s + r.r5, 0) / n,
      mrr: alphaResults.reduce((s, r) => s + r.mrr, 0) / n,
    };

    // Per-category R@5
    const catR5 = (cat: string) => {
      const cr = alphaResults.filter((_, i) => cachedPairs[i]!.query.category === cat);
      return cr.length > 0 ? cr.reduce((s, r) => s + r.r5, 0) / cr.length : 0;
    };

    const combined = overall.r5 + overall.mrr;
    const isBest = combined > bestScore;
    if (isBest) { bestScore = combined; bestAlpha = alpha; }

    const note = alpha === 0.0 ? "pure FTS5" : alpha === 1.0 ? "pure vector" : isBest ? "◀ best" : "";
    console.log(
      `  ${alpha.toFixed(1).padEnd(8)} | ${pct(overall.p5)} ${pct(overall.r5)} ${pct(overall.mrr)} | ${pct(catR5("keyword"))} ${pct(catR5("natural_language"))} ${pct(catR5("conceptual"))}  | ${note}`
    );
  }

  console.log("-".repeat(80));
  console.log(`\n  Best alpha: ${bestAlpha.toFixed(1)} (maximizes R@5 + MRR)`);
  console.log(`  FTS5-only baseline: R@5=${pct(af.r5)} MRR=${pct(af.mrr)}`);

  sqlite.close();
  console.log("\nDone.");
}

main().catch((e) => { console.error(e); process.exit(1); });
