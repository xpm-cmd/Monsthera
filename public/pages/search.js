import * as api from "../lib/api.js";
import { renderSearchInput, renderBadge, renderCard, renderHeroCallout, esc } from "../lib/components.js";

function freshnessVariant(state) {
  switch (state) {
    case "fresh": return "success";
    case "attention": return "warning";
    case "stale": return "error";
    default: return "outline";
  }
}

function typeVariant(type) {
  return type === "knowledge" ? "primary" : "success";
}

function buildModeGuide(mode, filterType) {
  const config = mode === "research"
    ? {
        eyebrow: "Investigation mode",
        title: "Investigation mode",
        steps: [
          "Search by symptom, subsystem, or decision topic.",
          "Prefer fresh and source-linked items before trusting older conclusions.",
          "If the investigation becomes a scoped task, create a spike in Work and capture the final conclusion in Knowledge.",
        ],
        benefit: "Best when quality of evidence matters more than raw velocity.",
      }
    : mode === "general"
      ? {
          eyebrow: "General orientation",
          title: "General mode",
          steps: [
            "Use broad queries to find the current baseline quickly.",
            "Open the top items to understand intent, then decide whether the next step belongs in Knowledge, Work, or Flow.",
            "Use this mode when you are orienting a human or a new agent in the workspace.",
          ],
          benefit: "Best for onboarding and fast orientation.",
        }
      : {
          eyebrow: "Code generation mode",
          title: "Code generation mode",
          steps: [
            "Search by feature, bug, module, or architecture concept.",
            "Open only the top 2 to 4 code-linked items before planning implementation.",
            "Move the selected references and code refs into a work article so execution stays grounded.",
          ],
          benefit: "Best for reducing blind repo reading and speeding implementation.",
        };

  return renderHeroCallout({
    eyebrow: config.eyebrow,
    title: config.title,
    body: config.benefit,
    meta: [
      renderBadge(mode, mode === "code" ? "primary" : mode === "research" ? "warning" : "secondary"),
      renderBadge(filterType === "all" ? "knowledge + work" : filterType, "outline"),
    ],
    steps: config.steps.map((item, index) => ({
      title: `Step ${index + 1}`,
      detail: item,
    })),
  });
}

export async function render(container) {
  let pack = null;
  let selectedResult = null;
  let selectedResultId = null;
  let filterType = "all";
  let mode = "code";
  let query = "";
  let debounceTimer = null;
  let isLoading = false;
  let errorMessage = null;
  let loadRequestId = 0;
  let previewRequestId = 0;
  let inputState = {
    restore: false,
    start: 0,
    end: 0,
  };

  function captureInputState(input) {
    inputState = {
      restore: true,
      start: input.selectionStart ?? query.length,
      end: input.selectionEnd ?? query.length,
    };
  }

  function getFiltered() {
    const items = pack?.items || [];
    if (filterType === "all") return items;
    return items.filter((item) => item.type === filterType);
  }

  function clearSelection() {
    previewRequestId += 1;
    selectedResult = null;
    selectedResultId = null;
  }

  async function selectResult(id, type) {
    const requestId = ++previewRequestId;
    selectedResultId = id;
    selectedResult = null;
    rerender();
    try {
      const nextResult = type === "knowledge"
        ? await api.getKnowledgeById(id)
        : await api.getWorkById(id);
      if (requestId !== previewRequestId || ac.signal.aborted || selectedResultId !== id) return;
      selectedResult = nextResult;
      rerender();
    } catch {
      if (requestId !== previewRequestId || ac.signal.aborted || selectedResultId !== id) return;
      selectedResult = null;
      rerender();
    }
  }

  function buildSummary() {
    if (errorMessage) {
      return renderCard(
        "Context pack",
        `<p class="text-sm">Monsthera could not build the context pack right now.</p><p class="text-xs text-muted mt-8">${esc(errorMessage)}</p>`,
      );
    }

    if (isLoading && !pack) {
      return renderCard(
        "Context pack",
        '<p class="text-sm text-muted">Searching and ranking the best context for this query...</p>',
      );
    }

    if (!pack) {
      return renderCard(
        "Context pack",
        '<p class="text-sm text-muted">Type a query and Monsthera will assemble a ranked pack optimized for code generation or investigation.</p>',
      );
    }

    return renderCard(
      "Context pack",
      '<div class="guide-hero">'
        + `<div class="stat-card"><div class="stat-label">Items</div><div class="stat-value">${esc(String(pack.summary.itemCount))}</div><div class="mt-4">${renderBadge(pack.mode, "secondary")}</div></div>`
        + `<div class="stat-card"><div class="stat-label">Fresh</div><div class="stat-value">${esc(String(pack.summary.freshCount))}</div><div class="mt-4">${renderBadge(pack.summary.staleCount > 0 ? `${pack.summary.staleCount} stale` : "clean", pack.summary.staleCount > 0 ? "warning" : "success")}</div></div>`
        + `<div class="stat-card"><div class="stat-label">Code-linked</div><div class="stat-value">${esc(String(pack.summary.codeLinkedCount))}</div><div class="mt-4">${renderBadge(pack.summary.sourceLinkedCount > 0 ? `${pack.summary.sourceLinkedCount} source-linked` : "no source links", pack.summary.sourceLinkedCount > 0 ? "primary" : "outline")}</div></div>`
        + `<div class="stat-card"><div class="stat-label">Index drift</div><div class="stat-value">${esc(String(pack.summary.skippedStaleIndexCount))}</div><div class="mt-4">${renderBadge(pack.summary.skippedStaleIndexCount > 0 ? "repair suggested" : "clean", pack.summary.skippedStaleIndexCount > 0 ? "warning" : "success")}</div></div>`
        + "</div>"
        + `<ul class="guide-list">${(pack.guidance || []).map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`,
    );
  }

  function buildDOM() {
    const filtered = getFiltered();
    const hasQuery = query.trim().length > 0;
    const resultListHtml = filtered.length > 0
      ? filtered.map((item) =>
        '<button type="button" class="card card--interactive search-result-card' + (selectedResultId === item.id ? ' card--selected' : '') + '" style="padding:14px 16px" data-result-id="' + esc(item.id) + '" data-result-type="' + esc(item.type) + '" aria-pressed="' + String(selectedResultId === item.id) + '">'
          + '<div class="flex items-center gap-8" style="flex-wrap:wrap">' + renderBadge(item.type, typeVariant(item.type))
          + renderBadge(item.diagnostics?.freshness?.label || "unknown", freshnessVariant(item.diagnostics?.freshness?.state))
          + renderBadge(item.diagnostics?.quality?.label || "quality", "outline")
          + '<strong class="text-sm">' + esc(item.title) + "</strong></div>"
          + '<p class="text-xs text-muted mt-4">' + esc(item.reason || "") + "</p>"
          + (item.snippet ? '<p class="text-xs text-muted mt-8">' + esc(item.snippet) + "</p>" : "")
          + '<div class="flex gap-8 mt-8" style="flex-wrap:wrap">'
          + (item.category ? renderBadge(item.category, "secondary") : "")
          + (item.template ? renderBadge(item.template, "secondary") : "")
          + (item.phase ? renderBadge(item.phase, "outline") : "")
          + (item.codeRefs?.length ? renderBadge(`${item.codeRefs.length} code refs`, "primary") : "")
          + (item.references?.length ? renderBadge(`${item.references.length} refs`, "outline") : "")
          + "</div></button>"
      ).join("\n")
      : isLoading
        ? '<div class="empty-state">Searching and ranking context...</div>'
        : errorMessage
          ? `<div class="empty-state">Search failed. ${esc(errorMessage)}</div>`
          : hasQuery
            ? '<div class="empty-state">No results for this query yet. Try a shorter term, a file path, or switch mode.</div>'
            : '<div class="empty-state">Type a query to build a context pack.</div>';

    const previewHtml = selectedResult
      ? renderCard(
        null,
        '<h3 style="font-size:16px;font-weight:600">' + esc(selectedResult.title) + "</h3>"
          + '<div class="flex gap-8 mt-4" style="flex-wrap:wrap">'
          + renderBadge(selectedResult.category || selectedResult.template || selectedResult.type, "secondary")
          + (selectedResult.diagnostics?.freshness ? renderBadge(selectedResult.diagnostics.freshness.label, freshnessVariant(selectedResult.diagnostics.freshness.state)) : "")
          + (selectedResult.diagnostics?.quality ? renderBadge(`${selectedResult.diagnostics.quality.score}/100`, "outline") : "")
          + "</div>"
          + (selectedResult.diagnostics?.freshness?.detail ? `<p class="text-xs text-muted mt-8">${esc(selectedResult.diagnostics.freshness.detail)}</p>` : "")
          + (selectedResult.sourcePath ? `<p class="text-xs text-muted mt-8">Source: <span class="mono">${esc(selectedResult.sourcePath)}</span></p>` : "")
          + '<p class="text-sm mt-8">' + esc((selectedResult.content || "").slice(0, 800)) + "</p>",
      )
      : selectedResultId
        ? renderCard(
          null,
          '<p class="text-sm text-muted">Loading preview…</p>',
        )
      : '<p class="text-sm text-muted">Select a result to preview.</p>';

    const temp = document.createElement("template");
    temp.innerHTML = [
      '<div class="page-header"><div><div class="page-kicker">Retrieve with intent</div><h1 class="page-title">Search</h1><p class="page-subtitle">Assemble targeted context packs for coding and investigation instead of reading the repo blindly.</p></div><div class="page-actions"><a href="/guide" data-link class="btn btn--outline btn--sm">Open guide</a></div></div>',
      renderSearchInput("Search code paths, decisions, bugs, architecture, experiments...", query),
      '<div class="flex gap-8 mt-4" style="flex-wrap:wrap">'
        + '<button class="tab' + (mode === "code" ? " active" : "") + '" data-mode="code">Code generation</button>'
        + '<button class="tab' + (mode === "research" ? " active" : "") + '" data-mode="research">Investigation</button>'
        + '<button class="tab' + (mode === "general" ? " active" : "") + '" data-mode="general">General</button>'
        + "</div>",
      '<div class="flex gap-8 mt-4">'
        + '<button class="tab' + (filterType === "all" ? " active" : "") + '" data-filter="all">All</button>'
        + '<button class="tab' + (filterType === "knowledge" ? " active" : "") + '" data-filter="knowledge">Knowledge</button>'
        + '<button class="tab' + (filterType === "work" ? " active" : "") + '" data-filter="work">Work</button>'
        + "</div>",
      buildModeGuide(mode, filterType),
      buildSummary(),
      '<div class="layout-split" style="margin-top:16px">'
        + '<div class="col-main" style="gap:8px">' + resultListHtml + "</div>"
        + '<div class="col-side">' + previewHtml + "</div></div>",
    ].join("\n");
    return temp.content;
  }

  function rerender() {
    container.textContent = "";
    container.appendChild(buildDOM());
    if (inputState.restore) {
      const input = container.querySelector(".search-input");
      if (input) {
        input.focus();
        const start = Math.min(inputState.start, input.value.length);
        const end = Math.min(inputState.end, input.value.length);
        input.setSelectionRange(start, end);
      }
    }
    if (typeof lucide !== "undefined") lucide.createIcons({ nodes: [container] });
  }

  async function loadPack() {
    const trimmed = query.trim();
    if (!trimmed) {
      pack = null;
      clearSelection();
      errorMessage = null;
      isLoading = false;
      rerender();
      return;
    }

    const requestId = ++loadRequestId;
    isLoading = true;
    errorMessage = null;
    clearSelection();
    rerender();

    try {
      const nextPack = await api.getContextPack(trimmed, mode, 10, filterType === "all" ? "all" : filterType);
      if (requestId !== loadRequestId || ac.signal.aborted) return;
      pack = nextPack;
      isLoading = false;
      errorMessage = null;
      rerender();
    } catch (error) {
      if (requestId !== loadRequestId || ac.signal.aborted) return;
      pack = null;
      isLoading = false;
      errorMessage = error?.message || "Unknown search error";
      rerender();
    }
  }

  rerender();

  const ac = new AbortController();
  container.addEventListener("input", (event) => {
    if (!event.target.classList.contains("search-input")) return;
    query = event.target.value;
    captureInputState(event.target);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void loadPack();
    }, 250);
  }, { signal: ac.signal });

  container.addEventListener("click", async (event) => {
    const filter = event.target.closest("[data-filter]");
    if (filter) {
      inputState.restore = false;
      filterType = filter.dataset.filter;
      if (query.trim()) await loadPack();
      else rerender();
      return;
    }

    const modeButton = event.target.closest("[data-mode]");
    if (modeButton) {
      inputState.restore = false;
      mode = modeButton.dataset.mode;
      if (query.trim()) await loadPack();
      else rerender();
      return;
    }

    const card = event.target.closest("[data-result-id]");
    if (card) {
      inputState.restore = false;
      await selectResult(card.dataset.resultId, card.dataset.resultType);
    }
  }, { signal: ac.signal });

  return { cleanup: () => { ac.abort(); clearTimeout(debounceTimer); } };
}
