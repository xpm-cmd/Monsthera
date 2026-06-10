// System Health — API data escaped via esc(). Template element for safe DOM.
import { getHealth, getStatus, getSystemEval } from "../../lib/api.js";
import { renderBadge, renderCard, esc } from "../../lib/components.js";

export async function render(container) {
  const [health, status, evalInfo] = await Promise.all([
    getHealth().catch(() => null),
    getStatus().catch(() => null),
    getSystemEval().catch(() => null), // 404 in consumer repos — card hides
  ]);

  const subsystems = health?.subsystems || [];
  const stats = status?.stats || {};

  const subsystemCards = subsystems.map(s =>
    '<div class="stat-card"><div class="flex items-center justify-between">'
    + '<span class="text-sm" style="font-weight:600">' + esc(s.name) + "</span> "
    + renderBadge(s.healthy ? "Healthy" : "Unhealthy", s.healthy ? "success" : "error")
    + "</div>" + (s.detail ? '<p class="text-xs text-muted mt-4">' + esc(s.detail) + "</p>" : "") + "</div>"
  ).join("\n");

  const statsRows = [
    { label: "Knowledge articles", value: stats.knowledgeArticleCount },
    { label: "Work articles", value: stats.workArticleCount },
    { label: "Search index size", value: stats.searchIndexSize },
    { label: "Last reindex", value: stats.lastReindexAt },
    { label: "Last migration", value: stats.lastMigrationAt },
  ].map(s =>
    '<div class="flex justify-between text-sm" style="padding:4px 0"><span>' + esc(s.label) + "</span>"
    + '<span class="mono">' + (s.value != null ? esc(String(s.value)) : '<span class="text-muted">Not recorded</span>') + "</span></div>"
  ).join("");

  const temp = document.createElement("template");
  temp.innerHTML = [
    '<div class="page-header"><div><h1 class="page-title">System Health</h1><p class="page-subtitle">Subsystem status and operational metrics.</p></div></div>',
    '<div class="flex gap-8">' + (health
      ? renderBadge(subsystems.every(s => s.healthy) ? "All systems healthy" : "Issues detected", subsystems.every(s => s.healthy) ? "success" : "error")
      : renderBadge("Unable to fetch health", "error")) + "</div>",
    '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px">' + subsystemCards + "</div>",
    renderCard("Statistics", '<div style="max-width:400px">' + statsRows + "</div>"),
    buildEvalCard(evalInfo, stats),
  ].join("\n");
  container.appendChild(temp.content);
  if (typeof lucide !== "undefined") lucide.createIcons({ nodes: [container] });
}

// Retrieval quality — committed eval baseline + live semantic state. The
// endpoint 404s in repos without tests/eval/baseline.json; render nothing.
function buildEvalCard(evalInfo, stats) {
  if (!evalInfo?.baseline?.aggregate) return "";
  const agg = evalInfo.baseline.aggregate;
  const engine = evalInfo.baseline.engine || "unknown";
  const liveSemantic = Boolean(stats.semanticSearchEnabled ?? evalInfo.live?.semanticEnabled);
  const metrics = [
    { label: "NDCG@" + (evalInfo.baseline.k ?? 10), value: agg.ndcgAtK },
    { label: "MRR", value: agg.mrr },
    { label: "Recall", value: agg.recallAtK },
    { label: "Contamination", value: agg.contaminationRate },
  ].map((m) =>
    '<div class="stat-card"><div class="stat-label">' + esc(m.label) + '</div><div class="stat-value">' + esc(m.value != null ? Number(m.value).toFixed(3) : "—") + "</div></div>"
  ).join("");
  return renderCard(
    "Retrieval quality (eval baseline)",
    '<div class="flex items-center gap-8" style="flex-wrap:wrap">'
      + renderBadge("baseline engine: " + engine, engine === "semantic" ? "primary" : "warning")
      + renderBadge(liveSemantic ? "semantic live" : "bm25 fallback live", liveSemantic ? "success" : "warning")
      + renderBadge((evalInfo.baseline.caseCount ?? "?") + " golden cases", "outline")
      + "</div>"
      + '<div class="mt-8" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px">' + metrics + "</div>"
      + '<p class="text-xs text-muted mt-8">From the committed <span class="mono">tests/eval/baseline.json</span> — regenerate with <span class="mono">monsthera eval --json --k 10</span>.</p>',
  );
}
