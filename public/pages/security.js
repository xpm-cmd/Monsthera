import { getSystemRuntime } from "../lib/api.js";
import { renderTabs, renderCard, renderBadge, esc } from "../lib/components.js";

function eventVariant(eventType) {
  switch (eventType) {
    case "phase_advanced": return "success";
    case "dependency_blocked": return "warning";
    case "dependency_resolved": return "primary";
    case "error_occurred": return "error";
    default: return "secondary";
  }
}

export async function render(container) {
  const runtime = await getSystemRuntime().catch(() => null);
  const security = runtime?.security || {};
  const orchestration = runtime?.orchestration || {};
  const recentEvents = runtime?.recentEvents || [];
  let activeTab = "posture";

  function buildPostureTab() {
    const postureScore = [
      security.localFirst ? 25 : 0,
      security.markdownSourceOfTruth ? 25 : 0,
      security.reviewGateEnforced ? 25 : 0,
      security.semanticSearchEnabled ? 10 : 0,
      orchestration.autoAdvance ? 5 : 10,
    ].reduce((sum, value) => sum + value, 0);

    const endpoints = Array.isArray(security.externalEndpoints) && security.externalEndpoints.length > 0
      ? `<ul style="list-style:none">${security.externalEndpoints.map((endpoint) => `<li class="mono text-sm" style="padding:2px 0">${esc(endpoint)}</li>`).join("")}</ul>`
      : '<p class="text-sm text-muted">No external endpoints configured.</p>';

    return '<div class="layout-split" style="margin-top:16px"><div class="col-main">'
      + `<div class="stat-card"><div class="stat-label">Security posture</div><div class="stat-value">${esc(String(postureScore))} / 100</div>`
      + '<p class="text-xs text-muted mt-4">Derived from local-first storage, review gates, and configured runtime boundaries.</p></div>'
      + '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:16px">'
      + renderCard("Storage policy", `<p class="text-sm" style="font-weight:600">${security.localFirst ? "Local-first" : "Mixed"}</p><p class="text-xs text-muted mt-4">Markdown remains the source of truth.</p>`)
      + renderCard("Review gate", `<p class="text-sm" style="font-weight:600">${security.reviewGateEnforced ? "Enforced" : "Advisory"}</p><p class="text-xs text-muted mt-4">Done-phase work still requires approved reviewers.</p>`)
      + renderCard("Automation mode", `<p class="text-sm" style="font-weight:600">${orchestration.autoAdvance ? "Auto-advance" : "Manual advance"}</p><p class="text-xs text-muted mt-4">Poll loop ${esc(String(orchestration.pollIntervalMs || "n/a"))}ms.</p>`)
      + '</div></div><div class="col-side">'
      + renderCard("Effective controls", '<ul class="checklist"><li>Markdown source of truth</li><li>Guarded phase transitions</li><li>Review approval before done</li><li>Search index derived from repo content</li><li>Explicit runtime endpoints</li></ul>')
      + renderCard("External endpoints", endpoints)
      + '</div></div>';
  }

  function buildPermissionsTab() {
    const rows = [
      ["Knowledge CRUD", runtime?.capabilities?.knowledgeCrud],
      ["Work CRUD", runtime?.capabilities?.workCrud],
      ["Phase advance", runtime?.capabilities?.phaseAdvance],
      ["Review workflow", runtime?.capabilities?.reviewWorkflow],
      ["Agent directory", runtime?.capabilities?.agentDirectory],
      ["Knowledge ingest", runtime?.capabilities?.knowledgeIngest],
      ["Search reindex", runtime?.capabilities?.searchReindex],
      ["Search auto-sync", runtime?.capabilities?.searchAutoSync],
      ["Context packs", runtime?.capabilities?.contextPacks],
      ["Wave planning", runtime?.capabilities?.wavePlanning],
      ["Wave execution", runtime?.capabilities?.waveExecution],
      ["Migration", runtime?.capabilities?.migrationAvailable],
    ].map(([label, enabled]) =>
      `<div class="flex justify-between text-sm" style="padding:6px 0"><span>${esc(label)}</span>${renderBadge(enabled ? "Allowed" : "Disabled", enabled ? "success" : "outline")}</div>`,
    ).join("");

    return '<div style="margin-top:16px">'
      + renderCard("Dashboard permissions", `<div style="max-width:480px">${rows}</div>`)
      + renderCard("Boundary summary", `<p class="text-sm">The dashboard mutates knowledge and work through the same domain services as CLI and MCP.</p><p class="text-xs text-muted mt-4">Configured server: ${esc(runtime?.server?.host || "localhost")}:${esc(String(runtime?.server?.port || "3000"))}</p>`)
      + '</div>';
  }

  function buildAuditTab() {
    const body = recentEvents.length > 0
      ? recentEvents.map((event) =>
        `<div class="card" style="padding:14px 16px"><div class="flex items-center justify-between gap-12"><div class="flex items-center gap-8">${renderBadge(event.eventType, eventVariant(event.eventType))}<span class="mono text-xs">${esc(event.workId)}</span></div><span class="text-xs text-muted">${esc(event.createdAt)}</span></div><p class="text-sm mt-8">${esc(JSON.stringify(event.details))}</p></div>`,
      ).join("")
      : renderCard("Audit trail", '<p class="text-sm text-muted">No orchestration events recorded yet. Phase advances and dependency changes will appear here.</p>');

    return `<div style="margin-top:16px;display:flex;flex-direction:column;gap:12px">${body}</div>`;
  }

  function buildDOM() {
    const tabs = [
      { id: "posture", label: "Policy & Posture" },
      { id: "permissions", label: "Dashboard Permissions" },
      { id: "audit", label: "Audit Trail" },
    ];

    let tabContent = "";
    if (activeTab === "posture") tabContent = buildPostureTab();
    else if (activeTab === "permissions") tabContent = buildPermissionsTab();
    else tabContent = buildAuditTab();

    const temp = document.createElement("template");
    temp.innerHTML = '<div class="page-header"><div><h1 class="page-title">Security</h1><p class="page-subtitle">Runtime posture, effective permissions, and orchestration audit trail.</p></div></div>'
      + renderTabs(tabs, activeTab) + tabContent;
    return temp.content;
  }

  function rerender() {
    container.textContent = "";
    container.appendChild(buildDOM());
    if (typeof lucide !== "undefined") lucide.createIcons({ nodes: [container] });
  }

  rerender();

  const ac = new AbortController();
  container.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab]");
    if (tab) {
      activeTab = tab.dataset.tab;
      rerender();
    }
  }, { signal: ac.signal });

  return { cleanup: () => ac.abort() };
}
