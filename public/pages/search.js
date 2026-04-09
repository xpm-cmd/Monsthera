// Search page — API data escaped via esc() in components.js
// Uses <template> element for safe DOM construction from trusted templates
import * as api from "../lib/api.js";
import { renderSearchInput, renderBadge, renderCard, esc } from "../lib/components.js";

export async function render(container) {
  let results = [];
  let selectedResult = null;
  let filterType = "all";
  let debounceTimer = null;

  function getFiltered() {
    if (filterType === "all") return results;
    return results.filter(r => r.type === filterType);
  }

  function buildDOM() {
    const filtered = getFiltered();
    const resultListHtml = filtered.length > 0
      ? filtered.map(r =>
          '<div class="card" style="cursor:pointer;padding:14px 16px" data-result-id="' + esc(r.id) + '" data-result-type="' + esc(r.type) + '">'
          + '<div class="flex items-center gap-8">' + renderBadge(r.type, r.type === "knowledge" ? "primary" : "success")
          + '<strong class="text-sm">' + esc(r.title) + "</strong></div>"
          + (r.snippet ? '<p class="text-xs text-muted mt-4">' + esc(r.snippet) + "</p>" : "")
          + "</div>"
        ).join("\n")
      : '<p class="text-sm text-muted" style="padding:20px">No results. Type a query above.</p>';

    let previewHtml = selectedResult
      ? renderCard(null, '<h3 style="font-size:16px;font-weight:600">' + esc(selectedResult.title) + "</h3>"
          + '<div class="mt-4">' + renderBadge(selectedResult.category || selectedResult.template || selectedResult.type, "secondary") + "</div>"
          + '<p class="text-sm mt-8">' + esc((selectedResult.content || "").slice(0, 500)) + "</p>")
      : '<p class="text-sm text-muted">Select a result to preview.</p>';

    const temp = document.createElement("template");
    temp.innerHTML = [
      '<div class="page-header"><div><h1 class="page-title">Search</h1><p class="page-subtitle">Search across all articles.</p></div></div>',
      renderSearchInput("Search articles, work items, code..."),
      '<div class="flex gap-8 mt-4">'
        + '<button class="tab' + (filterType === "all" ? " active" : "") + '" data-filter="all">All</button>'
        + '<button class="tab' + (filterType === "knowledge" ? " active" : "") + '" data-filter="knowledge">Knowledge</button>'
        + '<button class="tab' + (filterType === "work" ? " active" : "") + '" data-filter="work">Work</button>'
        + "</div>",
      '<div class="layout-split" style="margin-top:16px">'
        + '<div class="col-main" style="gap:8px">' + resultListHtml + "</div>"
        + '<div class="col-side">' + previewHtml + "</div></div>",
    ].join("\n");
    return temp.content;
  }

  function rerender() {
    container.textContent = "";
    container.appendChild(buildDOM());
    if (typeof lucide !== "undefined") lucide.createIcons({ nodes: [container] });
  }

  rerender();

  container.addEventListener("input", (e) => {
    if (!e.target.classList.contains("search-input")) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const q = e.target.value.trim();
      if (!q) { results = []; rerender(); return; }
      try { results = await api.search(q, 20); selectedResult = null; rerender(); } catch { /* ignore */ }
    }, 300);
  });

  container.addEventListener("click", async (e) => {
    const filter = e.target.closest("[data-filter]");
    if (filter) { filterType = filter.dataset.filter; rerender(); return; }
    const card = e.target.closest("[data-result-id]");
    if (card) {
      try {
        selectedResult = card.dataset.resultType === "knowledge"
          ? await api.getKnowledgeById(card.dataset.resultId)
          : await api.getWorkById(card.dataset.resultId);
        rerender();
      } catch { /* ignore */ }
    }
  });
}
