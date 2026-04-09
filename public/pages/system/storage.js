// Storage & Indexing — status API data escaped via esc() before interpolation.
import { getStatus } from "../../lib/api.js";
import { renderCard, renderBadge, esc } from "../../lib/components.js";

export async function render(container) {
  const status = await getStatus().catch(() => null);
  const stats = status?.stats || {};

  const rows = [
    { label: "Search index size", value: stats.searchIndexSize },
    { label: "Last reindex", value: stats.lastReindexAt },
    { label: "Last migration", value: stats.lastMigrationAt },
  ].map(r =>
    '<div class="flex justify-between text-sm" style="padding:4px 0"><span>' + esc(r.label) + '</span>'
    + '<span class="mono">' + (r.value != null ? esc(String(r.value)) : '<span class="text-muted">Not recorded</span>') + '</span></div>'
  ).join("");

  const temp = document.createElement("template");
  // All dynamic values above pass through esc()
  temp.innerHTML = '<div class="page-header"><div><h1 class="page-title">Storage &amp; Indexing</h1>'
    + '<p class="page-subtitle">Backend, freshness, and indexing policy.</p></div></div>'
    + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">'
    + renderCard("Backend", '<p class="text-sm">Markdown + file system</p><p class="text-xs text-muted mt-4">Primary storage for knowledge and work articles.</p>')
    + renderCard("Index freshness", status ? '<div class="flex items-center gap-8">' + renderBadge("Indexed", "success") + '</div>' : '<p class="text-sm text-muted">Status unavailable.</p>')
    + '</div>' + renderCard("Indexing metrics", '<div style="max-width:400px">' + rows + '</div>');
  container.appendChild(temp.content);
  if (typeof lucide !== "undefined") lucide.createIcons({ nodes: [container] });
}
