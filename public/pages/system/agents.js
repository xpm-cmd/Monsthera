// Agent Profiles — derives from work data. All values escaped via esc().
import { getWork } from "../../lib/api.js";
import { renderBadge, esc } from "../../lib/components.js";

export async function render(container) {
  const workArticles = await getWork().catch(() => []);
  let selectedAgent = null;

  function getAgents() {
    const agentSet = new Map();
    for (const w of workArticles) {
      for (const id of [w.author, w.assignee, ...(w.enrichmentRoles || []).map(e => e.agentId), ...(w.reviewers || []).map(r => r.agentId)]) {
        if (!id) continue;
        if (!agentSet.has(id)) agentSet.set(id, { id, articles: [] });
        agentSet.get(id).articles.push(w);
      }
    }
    return [...agentSet.values()];
  }

  function buildDOM() {
    const agents = getAgents();
    if (!selectedAgent && agents.length > 0) selectedAgent = agents[0].id;
    const selected = agents.find(a => a.id === selectedAgent);

    const listHtml = agents.map(a =>
      '<li><a href="#" data-agent="' + esc(a.id) + '" class="' + (a.id === selectedAgent ? "active" : "") + '">'
      + esc(a.id) + ' <span class="text-xs text-muted">(' + a.articles.length + ")</span></a></li>"
    ).join("");

    const detailHtml = selected
      ? '<h3 style="font-size:18px;font-weight:600">' + esc(selected.id) + "</h3>"
        + '<p class="text-sm text-muted mt-4">' + selected.articles.length + " associated article(s)</p>"
        + '<div class="mt-16">' + selected.articles.map(w =>
          '<div class="card" style="padding:10px 14px;margin-bottom:8px"><div class="flex items-center gap-8">'
          + '<span class="text-sm">' + esc(w.title) + "</span> " + renderBadge(w.phase, "secondary")
          + "</div></div>").join("") + "</div>"
      : '<p class="text-muted">No agents found in work data.</p>';

    const temp = document.createElement("template");
    temp.innerHTML = [
      '<div class="page-header"><div><h1 class="page-title">Agent Profiles</h1><p class="page-subtitle">Active agents derived from work articles.</p></div></div>',
      '<div class="layout-split"><div style="width:220px"><ul class="nav-list">' + listHtml + "</ul></div>",
      '<div class="col-main">' + detailHtml + "</div></div>",
    ].join("\n");
    return temp.content;
  }

  function rerender() {
    container.textContent = "";
    container.appendChild(buildDOM());
    if (typeof lucide !== "undefined") lucide.createIcons({ nodes: [container] });
  }
  rerender();

  container.addEventListener("click", (e) => {
    const link = e.target.closest("[data-agent]");
    if (link) { e.preventDefault(); selectedAgent = link.dataset.agent; rerender(); }
  });
}
