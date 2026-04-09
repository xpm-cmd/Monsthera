// Flow page — API data escaped via esc() in components.js
import { getWork } from "../lib/api.js";
import { renderChips, renderTable, renderBadge, timeAgo, esc, phaseVariant } from "../lib/components.js";

const PHASES = ["planning", "enrichment", "implementation", "review", "done"];

export async function render(container) {
  const workArticles = await getWork().catch(() => []);
  let activePhase = "all";

  function getAgents() {
    const agentMap = new Map();
    for (const w of workArticles) {
      const agents = new Set();
      if (w.author) agents.add(w.author);
      if (w.assignee) agents.add(w.assignee);
      for (const e of w.enrichmentRoles || []) agents.add(e.agentId);
      for (const r of w.reviewers || []) agents.add(r.agentId);
      for (const agentId of agents) {
        if (!agentMap.has(agentId) || new Date(w.updatedAt) > new Date(agentMap.get(agentId).updatedAt)) {
          agentMap.set(agentId, w);
        }
      }
    }
    return [...agentMap.entries()].map(([agentId, w]) => ({
      agent: agentId, action: w.phase, article: w.title, articleId: w.id, lastActivity: w.updatedAt,
    }));
  }

  function getFilteredAgents() {
    const agents = getAgents();
    if (activePhase === "all") return agents;
    return agents.filter(a => a.action === activePhase);
  }

  function getPhaseCounts() {
    const counts = { all: workArticles.length };
    for (const p of PHASES) counts[p] = workArticles.filter(w => w.phase === p).length;
    return counts;
  }

  function buildDOM() {
    const counts = getPhaseCounts();
    const phaseChips = [{ id: "all", label: "All phases", count: counts.all },
      ...PHASES.map(p => ({ id: p, label: p.charAt(0).toUpperCase() + p.slice(1), count: counts[p] }))];
    const agents = getFilteredAgents();

    const tableHtml = renderTable(
      [
        { key: "agent", label: "Agent", width: "140px" },
        { key: "action", label: "Current action", width: "180px", render: row => renderBadge(row.action, phaseVariant(row.action)) },
        { key: "article", label: "Article", render: row => '<a href="/work" data-link style="color:var(--primary)">' + esc(row.article) + "</a>" },
        { key: "lastActivity", label: "Last activity", width: "100px", align: "right", render: row => '<span class="text-muted text-xs">' + timeAgo(row.lastActivity) + "</span>" },
      ],
      agents,
    );

    const parts = [
      '<div class="page-header"><div><h1 class="page-title">Flow</h1><p class="page-subtitle">Agents and phase transitions at a glance.</p></div></div>',
      renderChips(phaseChips, activePhase),
      agents.length > 0
        ? tableHtml
        : '<p class="text-sm text-muted" style="padding:20px">No agent activity' + (activePhase !== "all" ? " in this phase" : "") + ".</p>",
    ];

    // Parse trusted template into DOM nodes
    const temp = document.createElement("template");
    temp.innerHTML = parts.join("\n");
    return temp.content;
  }

  function rerender() {
    container.textContent = "";
    container.appendChild(buildDOM());
    if (typeof lucide !== "undefined") lucide.createIcons({ nodes: [container] });
  }

  rerender();

  const ac = new AbortController();
  container.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-chip]");
    if (chip) { activePhase = chip.dataset.chip; rerender(); }
  }, { signal: ac.signal });

  return { cleanup: () => ac.abort() };
}
