import { getSystemRuntime } from "../../lib/api.js";
import { renderCard, renderBadge, esc } from "../../lib/components.js";

export async function render(container) {
  const runtime = await getSystemRuntime().catch(() => null);
  const integrations = runtime?.integrations || [];
  const capabilities = runtime?.capabilities || {};

  const cards = integrations.length > 0
    ? integrations.map((integration) =>
      renderCard(
        integration.name,
        `<p class="text-sm">${esc(integration.detail || "No detail available.")}</p>`,
        `<div class="flex gap-8">${renderBadge(integration.configured ? "Configured" : "Disabled", integration.configured ? "primary" : "outline")}${renderBadge(integration.healthy ? "Healthy" : "Unavailable", integration.healthy ? "success" : "warning")}</div>`,
      )).join("")
    : renderCard("Connected services", '<p class="text-sm text-muted">Integration data unavailable.</p>');

  const capabilityRows = [
    ["Knowledge CRUD", capabilities.knowledgeCrud],
    ["Work CRUD", capabilities.workCrud],
    ["Phase advance", capabilities.phaseAdvance],
    ["Review workflow", capabilities.reviewWorkflow],
    ["Agent directory", capabilities.agentDirectory],
    ["Knowledge ingest", capabilities.knowledgeIngest],
    ["Search reindex", capabilities.searchReindex],
    ["Search auto-sync", capabilities.searchAutoSync],
    ["Context packs", capabilities.contextPacks],
    ["Wave planning", capabilities.wavePlanning],
    ["Wave execution", capabilities.waveExecution],
    ["MCP server", capabilities.mcpServer],
    ["Migration service", capabilities.migrationAvailable],
  ].map(([label, enabled]) =>
    `<div class="flex justify-between text-sm" style="padding:4px 0"><span>${esc(label)}</span>${renderBadge(enabled ? "Available" : "Off", enabled ? "success" : "outline")}</div>`,
  ).join("");

  const temp = document.createElement("template");
  temp.innerHTML = '<div class="page-header"><div><h1 class="page-title">Integrations</h1>'
    + '<p class="page-subtitle">Connected services, runtime dependencies, and exposed surfaces.</p></div></div>'
    + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">' + cards + '</div>'
    + renderCard("Surface capabilities", `<div style="max-width:440px">${capabilityRows}</div>`);
  container.appendChild(temp.content);
}
