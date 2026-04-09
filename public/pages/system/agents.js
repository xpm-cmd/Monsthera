// Agent Profiles — backed by /api/agents. All values escaped via esc().
import { getAgents, getSystemRuntime } from "../../lib/api.js";
import { renderBadge, renderCard, renderStatCard, renderTable, timeAgo, esc } from "../../lib/components.js";
import { agentToolingPlaybook, agentUsagePrinciples, continuousImprovementLoop } from "../../lib/guide-data.js";

export async function render(container) {
  const [directory, runtime] = await Promise.all([
    getAgents().catch(() => ({ agents: [], summary: {} })),
    getSystemRuntime().catch(() => null),
  ]);
  const agentProfiles = directory.agents || [];
  const agentExperience = runtime?.agentExperience;
  let selectedAgent = null;

  function buildDOM() {
    const agents = agentProfiles;
    if (!selectedAgent && agents.length > 0) selectedAgent = agents[0].id;
    const selected = agents.find(a => a.id === selectedAgent);

    const listHtml = agents.map(a =>
      '<li><a href="#" data-agent="' + esc(a.id) + '" class="' + (a.id === selectedAgent ? "active" : "") + '">'
      + esc(a.id) + ' <span class="text-xs text-muted">(' + a.workCount + ")</span></a>"
      + '<div class="mt-4">' + [
        a.status === "active" ? renderBadge("Active", "success") : renderBadge("Idle", "outline"),
        a.pendingReviewCount > 0 ? renderBadge(`${a.pendingReviewCount} review`, "warning") : "",
      ].filter(Boolean).join(" ") + "</div></li>"
    ).join("");

    const detailHtml = selected
      ? [
          `<h3 style="font-size:18px;font-weight:600">${esc(selected.id)}</h3>`,
          `<p class="text-sm text-muted mt-4">${selected.workCount} associated article(s) · updated ${esc(timeAgo(selected.lastActivityAt))}</p>`,
          '<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:16px">'
            + renderStatCard("Active work", selected.activeWorkCount, selected.current ? renderBadge(selected.current.phase, "secondary") : "")
            + renderStatCard("Pending review", selected.pendingReviewCount, selected.pendingReviewCount > 0 ? renderBadge("Needs attention", "warning") : "")
            + renderStatCard("Assigned", selected.assignedCount, "")
            + renderStatCard("Enrichment", selected.enrichmentPendingCount + selected.enrichmentContributedCount, "")
            + "</div>",
          renderCard(
            "Current focus",
            selected.current
              ? `<p class="text-sm" style="font-weight:600">${esc(selected.current.title)}</p><p class="text-xs text-muted mt-4">${esc(selected.current.actionLabel)} · ${esc(selected.current.phase)} · roles: ${esc(selected.current.roles.join(", "))}</p>`
              : '<p class="text-sm text-muted">No active article assigned.</p>',
          ),
          renderCard(
            "Recent events",
            selected.recentEvents.length > 0
              ? selected.recentEvents.map((event) =>
                `<div class="flex items-center justify-between gap-12" style="padding:6px 0"><div><div class="flex items-center gap-8">${renderBadge(event.direct ? "Direct" : "Related", event.direct ? "primary" : "secondary")}${renderBadge(event.eventType, event.direct ? "warning" : "outline")}</div><p class="text-xs text-muted mt-4">${esc(event.workTitle || event.workId)}</p></div><span class="text-xs text-muted">${esc(timeAgo(event.createdAt))}</span></div>`,
              ).join("")
              : '<p class="text-sm text-muted">No recent orchestration events for this agent.</p>',
          ),
          renderCard(
            "Associated work",
            renderTable(
              [
                { key: "title", label: "Article" },
                { key: "phase", label: "Phase", width: "120px", render: row => renderBadge(row.phase, "secondary") },
                { key: "roles", label: "Roles", width: "220px", render: row => '<span class="text-xs text-muted">' + esc(row.roles.join(", ")) + "</span>" },
                { key: "updatedAt", label: "Last update", width: "100px", align: "right", render: row => '<span class="text-xs text-muted">' + esc(timeAgo(row.updatedAt)) + "</span>" },
              ],
              selected.touchpoints,
            ),
          ),
        ].join("")
      : '<p class="text-muted">No agents found in work data.</p>';

    const recommendationHtml = (agentExperience?.recommendations ?? []).slice(0, 5).map((item) => {
      const severityVariant = item.severity === "high" ? "error" : item.severity === "medium" ? "warning" : "secondary";
      return `<div class="guide-line"><div><div class="text-sm" style="font-weight:600">${esc(item.title)}</div><div class="text-xs text-muted mt-4">${esc(item.detail)}</div></div><div class="flex gap-8">${renderBadge(item.impact.replaceAll("_", " "), "outline")}${renderBadge(item.severity, severityVariant)}</div></div>`;
    }).join("");

    const principlesHtml = agentUsagePrinciples.map((item) =>
      `<div class="guide-line"><div><div class="text-sm" style="font-weight:600">${esc(item.title)}</div><div class="text-xs text-muted mt-4">${esc(item.detail)}</div></div><span class="text-xs text-muted">${esc(item.benefit)}</span></div>`
    ).join("");

    const improvementHtml = continuousImprovementLoop.map((item) =>
      `<div class="guide-line"><div><div class="text-sm" style="font-weight:600">${esc(item.title)}</div><div class="text-xs text-muted mt-4">${esc(item.detail)}</div></div><a href="${item.path}" data-link class="btn btn--ghost btn--sm">${esc(item.cta)}</a></div>`
    ).join("");

    const toolingHtml = agentToolingPlaybook.map((item) =>
      `<div class="guide-line"><div><div class="text-sm" style="font-weight:600">${esc(item.stage)}</div><div class="text-xs text-muted mt-4">${esc(item.detail)}</div><div class="mt-4">${item.tools.map((tool) => renderBadge(tool, "outline")).join(" ")}</div></div><span class="text-xs text-muted">${esc(item.benefit)}</span></div>`
    ).join("");

    const temp = document.createElement("template");
    temp.innerHTML = [
      '<div class="page-header"><div><div class="page-kicker">Inspect agent behavior</div><h1 class="page-title">Agent Profiles</h1><p class="page-subtitle">Derived agent directory from work articles and orchestration events.</p></div></div>',
      '<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px">'
        + renderStatCard("Agents", directory.summary?.totalAgents || 0, "")
        + renderStatCard("Active", directory.summary?.activeAgents || 0, "")
        + renderStatCard("Reviewers waiting", directory.summary?.reviewAgents || 0, "")
        + renderStatCard("Enrichment waiting", directory.summary?.enrichmentAgents || 0, "")
        + '</div>',
      agentExperience
        ? '<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px">'
          + renderStatCard("Agent readiness", `${agentExperience.scores.overall}%`, renderBadge(agentExperience.automation.mode, agentExperience.automation.mode === "auto" ? "success" : "secondary"))
          + renderStatCard("Context", `${agentExperience.coverage.context.percent}%`, renderBadge(`${agentExperience.coverage.context.covered}/${agentExperience.coverage.context.total}`, "outline"))
          + renderStatCard("Ownership", `${agentExperience.coverage.ownership.percent}%`, renderBadge(`${agentExperience.coverage.ownership.covered}/${agentExperience.coverage.ownership.total}`, "outline"))
          + renderStatCard("Review coverage", `${agentExperience.coverage.reviewAssignments.percent}%`, renderBadge(`${agentExperience.coverage.reviewAssignments.covered}/${agentExperience.coverage.reviewAssignments.total}`, "outline"))
          + '</div>'
        : "",
      agentExperience
        ? renderCard("Current optimization opportunities", recommendationHtml || '<p class="text-sm text-muted">No urgent optimization recommendations right now.</p>')
        : "",
      renderCard("How agents should operate in Monsthera", principlesHtml),
      renderCard("Recommended tool sequence", toolingHtml),
      '<div class="layout-split"><div style="width:220px"><ul class="nav-list">' + listHtml + "</ul></div>",
      '<div class="col-main">' + detailHtml + "</div></div>",
      renderCard("Continuous improvement loop", improvementHtml),
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
  container.addEventListener("click", (e) => {
    const link = e.target.closest("[data-agent]");
    if (link) { e.preventDefault(); selectedAgent = link.dataset.agent; rerender(); }
  }, { signal: ac.signal });

  return { cleanup: () => ac.abort() };
}
