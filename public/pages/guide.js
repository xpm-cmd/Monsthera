import {
  getAgents,
  getOrchestrationWave,
  getSystemRuntime,
  executeOrchestrationWave,
} from "../lib/api.js";
import { renderBadge, renderCard, renderStatCard, esc } from "../lib/components.js";
import {
  agentUsagePrinciples,
  agentToolingPlaybook,
  automationRules,
  benefitPillars,
  continuousImprovementLoop,
  dashboardSections,
  onboardingSteps,
  operationModes,
  operatorJourneys,
  phasePlaybooks,
} from "../lib/guide-data.js";

function renderBulletList(items) {
  return `<ul class="guide-list">${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`;
}

function renderStepCard(step) {
  return [
    '<div class="guide-step">',
    `<div class="guide-step__title">${esc(step.title)}</div>`,
    `<p class="text-sm text-muted mt-8">${esc(step.detail)}</p>`,
    `<div class="mt-16"><a href="${step.path}" data-link class="btn btn--outline btn--sm">${esc(step.cta)}</a></div>`,
    "</div>",
  ].join("");
}

function renderRecommendation(item) {
  const severityVariant = item.severity === "high" ? "error" : item.severity === "medium" ? "warning" : "secondary";
  const impactLabel = item.impact === "save_tokens"
    ? "save tokens"
    : item.impact === "reduce_handoffs"
      ? "reduce handoffs"
      : item.impact === "unblock_flow"
        ? "unblock flow"
        : "accelerate";
  return [
    '<div class="guide-line">',
    '<div>',
    `<div class="text-sm" style="font-weight:600">${esc(item.title)}</div>`,
    `<div class="text-xs text-muted mt-4">${esc(item.detail)}</div>`,
    "</div>",
    `<div class="flex gap-8">${renderBadge(impactLabel, "outline")}${renderBadge(item.severity, severityVariant)}<a href="${item.path}" data-link class="btn btn--ghost btn--sm">Open</a></div>`,
    "</div>",
  ].join("");
}

function renderJourneyCard(journey) {
  return renderCard(
    journey.title,
    [
      `<p class="text-sm">${esc(journey.detail)}</p>`,
      renderBulletList(journey.steps),
      `<p class="text-xs text-muted mt-8">${esc(journey.benefit)}</p>`,
    ].join(""),
    `<a href="${journey.path}" data-link class="btn btn--outline btn--sm">${esc(journey.cta)}</a>`,
  );
}

function renderPlaybookCard(step) {
  return renderCard(
    step.stage,
    [
      `<div class="flex gap-8" style="flex-wrap:wrap">${step.tools.map((tool) => renderBadge(tool, "outline")).join("")}</div>`,
      `<p class="text-sm mt-8">${esc(step.detail)}</p>`,
      `<p class="text-xs text-muted mt-8">${esc(step.benefit)}</p>`,
      `<p class="text-xs mt-8"><strong>Avoid:</strong> ${esc(step.avoid)}</p>`,
    ].join(""),
  );
}

export async function render(container) {
  let [runtime, wave, directory] = await Promise.all([
    getSystemRuntime().catch(() => null),
    getOrchestrationWave().catch(() => null),
    getAgents().catch(() => ({ agents: [], summary: {} })),
  ]);
  let flash = null;

  async function refresh() {
    [runtime, wave, directory] = await Promise.all([
      getSystemRuntime().catch(() => null),
      getOrchestrationWave().catch(() => null),
      getAgents().catch(() => ({ agents: [], summary: {} })),
    ]);
  }

  async function handleRunWave() {
    try {
      const result = await executeOrchestrationWave();
      flash = {
        kind: "success",
        message: `Advanced ${result.summary.advancedCount} ready article(s).`,
      };
      await refresh();
      rerender();
    } catch (error) {
      flash = { kind: "error", message: error?.message || "Wave execution failed" };
      rerender();
    }
  }

  function buildFlash() {
    if (!flash) return "";
    const variant = flash.kind === "error" ? "error" : "success";
    return `<div class="inline-notice inline-notice--${variant}">${esc(flash.message)}</div>`;
  }

  function buildDOM() {
    const readyCount = wave?.summary?.readyCount ?? 0;
    const blockedCount = wave?.summary?.blockedCount ?? 0;
    const totalAgents = directory?.summary?.totalAgents ?? 0;
    const activeAgents = directory?.summary?.activeAgents ?? 0;
    const autoAdvance = runtime?.orchestration?.autoAdvance;
    const agentExperience = runtime?.agentExperience;

    const heroActions = [
      '<a href="/work" data-link class="btn btn--primary btn--sm">Create work article</a>',
      '<a href="/knowledge" data-link class="btn btn--outline btn--sm">Open knowledge</a>',
      readyCount > 0
        ? '<button class="btn btn--outline btn--sm" type="button" data-run-wave>Advance ready wave</button>'
        : "",
    ].filter(Boolean).join("");

    const sectionCards = dashboardSections.map((section) =>
      `<div class="guide-panel"><div class="guide-panel__title">${esc(section.title)}</div><p class="text-sm mt-8">${esc(section.purpose)}</p><p class="text-sm text-muted mt-8">${esc(section.detail)}</p><div class="mt-16"><a href="${section.path}" data-link class="btn btn--ghost btn--sm">Open section</a></div></div>`
    ).join("");

    const modeCards = operationModes.map((mode) =>
      renderCard(mode.title, `<p class="text-sm">${esc(mode.detail)}</p>`)
    ).join("");

    const playbooks = phasePlaybooks.map((playbook) =>
      renderCard(
        playbook.phase,
        `<p class="text-sm" style="font-weight:600">${esc(playbook.intent)}</p>${renderBulletList(playbook.actions)}`,
      )
    ).join("");

    const principleCards = agentUsagePrinciples.map((principle) =>
      renderCard(
        principle.title,
        `<p class="text-sm">${esc(principle.detail)}</p><p class="text-xs text-muted mt-8">${esc(principle.benefit)}</p>`,
      )
    ).join("");

    const benefitCards = benefitPillars.map((item) =>
      renderCard(
        item.title,
        `<p class="text-sm">${esc(item.detail)}</p><p class="text-xs text-muted mt-8">${esc(item.benefit)}</p>`,
      )
    ).join("");

    const journeyCards = operatorJourneys.map((journey) => renderJourneyCard(journey)).join("");
    const playbookCards = agentToolingPlaybook.map((step) => renderPlaybookCard(step)).join("");
    const improvementCards = continuousImprovementLoop.map((step) => renderStepCard(step)).join("");

    const readyItems = (wave?.ready ?? []).slice(0, 4).map((item) =>
      `<div class="guide-line"><div><div class="text-sm" style="font-weight:600">${esc(item.title)}</div><div class="text-xs text-muted mt-4">${esc(item.workId)} · ${esc(item.from)} → ${esc(item.to)}</div></div>${renderBadge(item.priority || "ready", item.priority === "high" || item.priority === "critical" ? "warning" : "success")}</div>`
    ).join("");

    const blockedItems = (wave?.blocked ?? []).slice(0, 4).map((item) =>
      `<div class="guide-line"><div><div class="text-sm" style="font-weight:600">${esc(item.title)}</div><div class="text-xs text-muted mt-4">${esc(item.reason)}</div></div>${renderBadge(item.phase || "blocked", "warning")}</div>`
    ).join("");

    const recommendationHtml = (agentExperience?.recommendations ?? []).slice(0, 6).map((item) => renderRecommendation(item)).join("");

    const diagnosticsHtml = agentExperience
      ? [
        '<div class="guide-grid">',
        renderStatCard("Agent readiness", `${agentExperience.scores.overall}%`, renderBadge(agentExperience.automation.mode === "auto" ? "auto" : "supervised", agentExperience.automation.mode === "auto" ? "success" : "secondary")),
        renderStatCard("Contract coverage", `${agentExperience.coverage.contract.percent}%`, renderBadge(`${agentExperience.coverage.contract.covered}/${agentExperience.coverage.contract.total}`, "outline")),
        renderStatCard("Context coverage", `${agentExperience.coverage.context.percent}%`, renderBadge(`${agentExperience.coverage.context.covered}/${agentExperience.coverage.context.total}`, "outline")),
        renderStatCard("Ownership coverage", `${agentExperience.coverage.ownership.percent}%`, renderBadge(`${agentExperience.coverage.ownership.covered}/${agentExperience.coverage.ownership.total}`, "outline")),
        "</div>",
        '<div class="layout-split mt-16">',
        `<div class="col-main">${recommendationHtml || '<p class="text-sm text-muted">No urgent optimization recommendations right now.</p>'}</div>`,
        `<div class="col-side">${renderCard("What this improves", `<ul class="guide-list"><li>Less token waste from repeated rediscovery</li><li>Cleaner agent handoffs through stronger work contracts</li><li>Safer autonomous flow because blockers and review gates stay explicit</li><li>Compounding reuse as work output becomes durable knowledge</li></ul>`)}</div>`,
        "</div>",
      ].join("")
      : '<p class="text-sm text-muted">Agent diagnostics are not available right now.</p>';

    const temp = document.createElement("template");
    temp.innerHTML = [
      '<div class="page-header"><div><div class="page-kicker">Learn the operating model</div><h1 class="page-title">Guide</h1><p class="page-subtitle">How to use Monsthera, orchestrate agents, and automate work without losing clarity.</p></div><div class="page-actions">',
      heroActions,
      "</div></div>",
      buildFlash(),
      '<div class="guide-hero">',
      renderStatCard("Ready wave", readyCount, readyCount > 0 ? renderBadge("safe to advance", "success") : renderBadge("nothing queued", "outline")),
      renderStatCard("Blocked work", blockedCount, blockedCount > 0 ? renderBadge("needs action", "warning") : renderBadge("clear", "success")),
      renderStatCard("Agents", totalAgents, activeAgents > 0 ? renderBadge(`${activeAgents} active`, "primary") : renderBadge("idle", "outline")),
      renderStatCard("Automation mode", autoAdvance ? "Auto" : "Manual", renderBadge(autoAdvance ? "loop enabled" : "supervised", autoAdvance ? "success" : "secondary")),
      "</div>",
      renderCard(
        "Start here",
        `<div class="guide-grid">${onboardingSteps.map((step) => renderStepCard(step)).join("")}</div>`,
      ),
      renderCard(
        "What Monsthera improves",
        `<div class="guide-grid">${benefitCards}</div>`,
      ),
      renderCard(
        "Choose the right workflow",
        `<div class="guide-grid">${journeyCards}</div>`,
      ),
      renderCard(
        "Current operating picture",
        `<div class="layout-split"><div class="col-main">${readyItems || '<p class="text-sm text-muted">No ready articles yet. Add objectives and acceptance criteria in Work first.</p>'}</div><div class="col-side">${blockedItems || '<p class="text-sm text-muted">No blocked articles right now.</p>'}</div></div>`,
        '<a href="/flow" data-link class="btn btn--outline btn--sm">Open flow control</a>',
      ),
      renderCard(
        "How agents should use Monsthera",
        `<div class="guide-grid">${principleCards}</div>`,
      ),
      renderCard(
        "Tool sequence agents should follow",
        `<div class="guide-grid">${playbookCards}</div>`,
      ),
      renderCard(
        "Agent efficiency and optimization",
        diagnosticsHtml,
        agentExperience?.search?.autoSync
          ? `<div class="flex gap-8">${renderBadge("search auto-sync", "success")}${agentExperience.search.lastReindexAt ? renderBadge(`last reindex ${new Date(agentExperience.search.lastReindexAt).toLocaleDateString()}`, "outline") : renderBadge("no baseline reindex yet", "warning")}</div>`
          : "",
      ),
      renderCard(
        "Choose your operating mode",
        `<div class="guide-grid">${modeCards}</div>`,
      ),
      renderCard(
        "What each dashboard section is for",
        `<div class="guide-intent-grid">${sectionCards}</div>`,
      ),
      renderCard(
        "Phase-by-phase playbook",
        `<div class="guide-grid">${playbooks}</div>`,
      ),
      renderCard(
        "Automation rules",
        renderBulletList(automationRules),
      ),
      renderCard(
        "Continuous improvement loop",
        `<div class="guide-grid">${improvementCards}</div>`,
      ),
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
    const button = event.target.closest("[data-run-wave]");
    if (button) {
      await handleRunWave();
    }
  }, { signal: ac.signal });

  return { cleanup: () => ac.abort() };
}
