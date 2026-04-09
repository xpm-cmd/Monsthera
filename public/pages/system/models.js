import { getSystemRuntime } from "../../lib/api.js";
import { renderCard, renderBadge, esc } from "../../lib/components.js";

export async function render(container) {
  const runtime = await getSystemRuntime().catch(() => null);
  const search = runtime?.search;
  const orchestration = runtime?.orchestration;

  const temp = document.createElement("template");
  temp.innerHTML = [
    '<div class="page-header"><div><h1 class="page-title">Models &amp; Runtime</h1>',
    '<p class="page-subtitle">Provider, model routing, and orchestration settings.</p></div></div>',
    '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">',
    renderCard(
      "Embedding provider",
      search
        ? `<p class="text-sm" style="font-weight:600">${esc(search.embeddingProvider)}</p><p class="text-xs text-muted mt-4">${esc(search.embeddingModel)}</p>`
        : '<p class="text-sm text-muted">Runtime data unavailable.</p>',
      search ? `<div class="flex gap-8">${renderBadge(search.semanticEnabled ? "Semantic search on" : "Semantic search off", search.semanticEnabled ? "success" : "warning")}</div>` : "",
    ),
    renderCard(
      "Model endpoint",
      search
        ? `<p class="text-sm">${esc(search.ollamaUrl)}</p><p class="text-xs text-muted mt-4">Blend alpha: ${esc(String(search.alpha))}</p>`
        : '<p class="text-sm text-muted">No endpoint data.</p>',
    ),
    renderCard(
      "Orchestration runtime",
      orchestration
        ? `<p class="text-sm">Auto-advance: <strong>${esc(orchestration.autoAdvance ? "enabled" : "disabled")}</strong></p><p class="text-xs text-muted mt-4">Poll every ${esc(String(orchestration.pollIntervalMs))}ms · max ${esc(String(orchestration.maxConcurrentAgents))} agents</p>`
        : '<p class="text-sm text-muted">No orchestration data.</p>',
      orchestration ? `<div class="flex gap-8">${renderBadge(orchestration.running ? "Loop running" : "Manual mode", orchestration.running ? "success" : "secondary")}</div>` : "",
    ),
    '</div>',
  ].join("\n");
  container.appendChild(temp.content);
}
