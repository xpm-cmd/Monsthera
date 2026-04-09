// Security — all hardcoded placeholder data. No API/user input whatsoever.
import { renderTabs, renderCard } from "../lib/components.js";

export async function render(container) {
  let activeTab = "posture";

  function buildDOM() {
    const tabs = [
      { id: "posture", label: "Policy & Posture" },
      { id: "permissions", label: "Agent Permissions" },
      { id: "audit", label: "Audit Trail" },
    ];

    let tabContent = "";
    if (activeTab === "posture") {
      tabContent = '<div class="layout-split" style="margin-top:16px"><div class="col-main">'
        + '<div class="stat-card"><div class="stat-label">Security posture</div><div class="stat-value">92 / 100</div>'
        + '<p class="text-xs text-muted mt-4">Local-first execution with least-privilege defaults.</p></div>'
        + '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:16px">'
        + renderCard("Tool policy", '<p class="text-sm" style="font-weight:600">Strict allowlist</p><p class="text-xs text-muted mt-4">Only approved tools can be invoked.</p>')
        + renderCard("Repo access", '<p class="text-sm" style="font-weight:600">Claim before write</p><p class="text-xs text-muted mt-4">Agents must claim files before modifying.</p>')
        + renderCard("Approval mode", '<p class="text-sm" style="font-weight:600">Auto inside policy</p><p class="text-xs text-muted mt-4">Actions within policy are auto-approved.</p>')
        + '</div></div><div class="col-side">'
        + renderCard("Effective policy", '<ul class="checklist"><li>Least-privilege agent defaults</li><li>Tool allowlist enforced</li><li>File claim-before-write</li><li>Review required for phase advance</li><li>No external network by default</li></ul>')
        + renderCard("Runtime boundaries", '<p class="text-sm"><strong>Sandbox posture:</strong> Strict</p><p class="text-sm mt-4"><strong>Approval strategy:</strong> Auto within policy</p>')
        + '</div></div>';
    } else if (activeTab === "permissions") {
      tabContent = '<div style="margin-top:16px">' + renderCard("Agent Permissions", '<p class="text-sm text-muted">Agent permission management is not yet available via the dashboard API.</p>') + '</div>';
    } else {
      tabContent = '<div style="margin-top:16px">' + renderCard("Audit Trail", '<p class="text-sm text-muted">Audit trail is not yet available via the dashboard API.</p>') + '</div>';
    }

    const temp = document.createElement("template");
    temp.innerHTML = '<div class="page-header"><div><h1 class="page-title">Security</h1><p class="page-subtitle">Policy, agent permissions, and audit trail.</p></div></div>'
      + renderTabs(tabs, activeTab) + tabContent;
    return temp.content;
  }

  function rerender() {
    container.textContent = "";
    container.appendChild(buildDOM());
    if (typeof lucide !== "undefined") lucide.createIcons({ nodes: [container] });
  }
  rerender();

  container.addEventListener("click", (e) => {
    const tab = e.target.closest("[data-tab]");
    if (tab) { activeTab = tab.dataset.tab; rerender(); }
  });
}
