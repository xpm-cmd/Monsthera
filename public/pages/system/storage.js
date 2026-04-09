// Storage & Indexing — dashboard can now trigger reindexing directly.
import { getStatus, getKnowledge, getWork, reindexSearch } from "../../lib/api.js";
import { renderCard, renderBadge, esc } from "../../lib/components.js";

export async function render(container) {
  let [status, knowledge, work] = await Promise.all([
    getStatus().catch(() => null),
    getKnowledge().catch(() => []),
    getWork().catch(() => []),
  ]);
  let flash = null;

  async function refresh() {
    [status, knowledge, work] = await Promise.all([
      getStatus().catch(() => null),
      getKnowledge().catch(() => []),
      getWork().catch(() => []),
    ]);
  }

  async function handleReindex() {
    try {
      const result = await reindexSearch();
      flash = {
        kind: "success",
        message: `Reindexed ${result.knowledgeCount} knowledge article(s) and ${result.workCount} work article(s).`,
      };
      await refresh();
      rerender();
    } catch (error) {
      flash = { kind: "error", message: error?.message || "Reindex failed" };
      rerender();
    }
  }

  function buildFlash() {
    if (!flash) return "";
    const variant = flash.kind === "error" ? "error" : "success";
    return `<div class="inline-notice inline-notice--${variant}">${esc(flash.message)}</div>`;
  }

  function buildRows() {
    const stats = status?.stats || {};
    return [
      { label: "Knowledge articles", value: knowledge.length },
      { label: "Work articles", value: work.length },
      { label: "Search index size", value: stats.searchIndexSize },
      { label: "Last reindex", value: stats.lastReindexAt },
      { label: "Last migration", value: stats.lastMigrationAt },
    ].map((row) =>
      `<div class="flex justify-between text-sm" style="padding:4px 0"><span>${esc(row.label)}</span><span class="mono">${row.value != null ? esc(String(row.value)) : '<span class="text-muted">Not recorded</span>'}</span></div>`,
    ).join("");
  }

  function buildDOM() {
    const backendDetail = status?.subsystems?.find((subsystem) => subsystem.name === "storage")?.detail
      || "Markdown + file system";
    const indexed = Boolean(status?.stats?.lastReindexAt);

    const temp = document.createElement("template");
    temp.innerHTML = [
      '<div class="page-header"><div><h1 class="page-title">Storage &amp; Indexing</h1><p class="page-subtitle">Backend, freshness, and indexing policy.</p></div></div>',
      buildFlash(),
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">',
      renderCard("Backend", `<p class="text-sm">${esc(backendDetail)}</p><p class="text-xs text-muted mt-4">Markdown remains the source of truth for work and knowledge.</p>`),
      renderCard(
        "Index freshness",
        `<div class="flex items-center gap-8">${renderBadge(indexed ? "Indexed" : "Needs reindex", indexed ? "success" : "warning")}</div><p class="text-xs text-muted mt-4">Use reindex after large imports or before a demo.</p>`,
        '<button class="btn btn--primary btn--sm" type="button" data-reindex-search>Run reindex</button>',
      ),
      "</div>",
      renderCard("Indexing metrics", `<div style="max-width:440px">${buildRows()}</div>`),
    ].join("\n");
    return temp.content;
  }

  function rerender() {
    container.textContent = "";
    container.appendChild(buildDOM());
    if (typeof lucide !== "undefined") lucide.createIcons({ nodes: [container] });
  }

  rerender();

  const ac = new AbortController();
  container.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-reindex-search]");
    if (button) {
      await handleReindex();
    }
  }, { signal: ac.signal });

  return { cleanup: () => ac.abort() };
}
