import {
  executeOrchestrationWave,
  getAgents,
  getHealth,
  getKnowledge,
  getOrchestrationWave,
  getSystemRuntime,
  getWork,
} from "../lib/api.js";
import { onboardingSteps } from "../lib/guide-data.js";
import {
  esc,
  renderAlert,
  renderBadge,
  renderCard,
  renderHeroCallout,
  renderStatCard,
  timeAgo,
} from "../lib/components.js";

function renderBulletList(items) {
  return items.length > 0
    ? `<ul class="guide-list">${items.map((item) => `<li>${item}</li>`).join("")}</ul>`
    : '<p class="text-sm text-muted">Nothing needs attention right now.</p>';
}

function renderStartHere() {
  return `<div class="guide-grid">${onboardingSteps.slice(0, 3).map((step) => [
    '<div class="guide-step">',
    `<div class="guide-step__title">${esc(step.title)}</div>`,
    `<p class="text-sm text-muted mt-8">${esc(step.detail)}</p>`,
    `<div class="mt-16"><a href="${step.path}" data-link class="btn btn--outline btn--sm">${esc(step.cta)}</a></div>`,
    "</div>",
  ].join("")).join("")}</div>`;
}

function renderAgentDirectoryEmptyState() {
  return [
    '<p class="text-sm text-muted">The agent directory is empty — no agents have registered yet. This is expected on a fresh corpus.</p>',
    '<p class="text-sm text-muted mt-8">Agents appear here once they register via <code>register_agent</code> or are seeded from a v2 import.</p>',
    '<div class="mt-16" style="display:flex;gap:8px;flex-wrap:wrap;">',
    '<a href="/work" data-link class="btn btn--primary btn--sm">Create your first work article</a>',
    '<a href="/system" data-link class="btn btn--outline btn--sm">Open system settings</a>',
    '<a href="/guide" data-link class="btn btn--outline btn--sm">How agents register</a>',
    "</div>",
  ].join("");
}

export async function render(container) {
  let [health, workArticles, knowledgeArticles, wave, runtime, directory] = await Promise.all([
    getHealth().catch(() => null),
    getWork().catch(() => []),
    getKnowledge().catch(() => []),
    getOrchestrationWave().catch(() => null),
    getSystemRuntime().catch(() => null),
    getAgents().catch(() => ({ agents: [], summary: {} })),
  ]);
  let flash = null;

  async function refresh() {
    [health, workArticles, knowledgeArticles, wave, runtime, directory] = await Promise.all([
      getHealth().catch(() => null),
      getWork().catch(() => []),
      getKnowledge().catch(() => []),
      getOrchestrationWave().catch(() => null),
      getSystemRuntime().catch(() => null),
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
    const activeWork = workArticles.filter((article) => article.phase !== "done" && article.phase !== "cancelled");
    const blockedArticles = workArticles.filter((article) => article.blockedBy?.length > 0);
    const pendingReviews = workArticles.filter((article) => article.reviewers?.some((reviewer) => reviewer.status === "pending"));
    const unassignedImplementation = workArticles.filter((article) => article.phase === "implementation" && !article.assignee);
    const readyItems = wave?.ready ?? [];
    const latestKnowledge = [...knowledgeArticles].sort((left, right) =>
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
    )[0];
    const allHealthy = health?.subsystems?.every((subsystem) => subsystem.healthy) ?? false;

    const attentionItems = [
      ...readyItems.slice(0, 3).map((item) => `${esc(item.title)} is ready to move ${esc(item.from)} → ${esc(item.to)}.`),
      ...blockedArticles.slice(0, 3).map((article) => `${esc(article.title)} is blocked by ${article.blockedBy.length} dependency(ies).`),
      ...pendingReviews.slice(0, 3).map((article) => `${esc(article.title)} is waiting on review approval.`),
      ...unassignedImplementation.slice(0, 3).map((article) => `${esc(article.title)} is in implementation without an assignee.`),
    ];

    const alertTitle = readyItems.length > 0
      ? `${readyItems.length} article(s) ready to advance`
      : "No ready wave right now";
    const alertBody = readyItems.length > 0
      ? `Monsthera already sees guard-safe advances. Review the ready wave, then execute it deliberately.`
      : "Use the guide and work forms to add context, owners, and acceptance criteria before expecting automation.";

    const latestKnowledgeHtml = latestKnowledge
      ? `<p class="text-sm">${esc(String(knowledgeArticles.length))} article(s). Most recent: <strong>${esc(latestKnowledge.title)}</strong> (${timeAgo(latestKnowledge.updatedAt)})</p>`
      : '<p class="text-sm text-muted">No knowledge articles yet. Start by importing source notes or writing a guide.</p>';

    const autoAdvance = runtime?.orchestration?.autoAdvance;
    const activeAgents = directory?.summary?.activeAgents ?? 0;
    const totalAgents = directory?.summary?.totalAgents ?? 0;
    const agentDirectoryEmpty = totalAgents === 0;
    const nextAction = readyItems.length > 0
      ? {
          eyebrow: "Next best action",
          title: "Advance the ready wave under supervision",
          body: "Monsthera already has articles whose guards pass. This is the fastest safe move because it improves throughput without inventing new work.",
          meta: [
            renderBadge(`${readyItems.length} ready`, "success"),
            renderBadge(autoAdvance ? "auto loop available" : "manual review", autoAdvance ? "primary" : "secondary"),
          ],
          steps: [
            { title: "Review", detail: "Confirm the ready articles still match current intent." },
            { title: "Advance", detail: "Run the wave or open Flow to move them forward deliberately." },
            { title: "Capture", detail: "Turn reusable outcomes into Knowledge when the work lands." },
          ],
        }
      : blockedArticles.length > 0
        ? {
            eyebrow: "Next best action",
            title: "Unblock the constrained work first",
            body: "Throughput will improve more by clearing dependencies than by starting new tasks. Keep blockers explicit, then resume automation.",
            meta: [
              renderBadge(`${blockedArticles.length} blocked`, "warning"),
              renderBadge("dependency-first", "outline"),
            ],
            steps: [
              { title: "Inspect", detail: "Open Flow or Work and identify the blocker owner." },
              { title: "Clarify", detail: "Add or tighten references, code refs, and ownership on the blocked article." },
              { title: "Resume", detail: "Return to the ready wave once the dependency clears." },
            ],
          }
        : {
            eyebrow: "Next best action",
            title: "Shape the next work contract",
            body: "When no wave is ready, the highest leverage move is to improve the work definition so agents can execute with less ambiguity and less token waste.",
            meta: [
              renderBadge(`${activeWork.length} active`, "secondary"),
              renderBadge("contract-first", "outline"),
            ],
            steps: [
              { title: "Define", detail: "Write objective and acceptance criteria in a work article." },
              { title: "Ground", detail: "Attach references and code refs from Search or Knowledge." },
              { title: "Assign", detail: "Set lead, assignee, and review expectations before implementation." },
            ],
          };

    const wrapper = document.createElement("div");
    wrapper.innerHTML = [
      '<div class="page-header"><div>',
      '<div class="page-kicker">Operate the workspace</div>',
      '<h1 class="page-title">Overview</h1>',
      '<p class="page-subtitle">Operate Monsthera with clear next steps, safe handoffs, and visible blockers.</p>',
      '</div><div class="page-actions">',
      '<a href="/guide" data-link class="btn btn--outline btn--sm">Open guide</a>',
      '<a href="/work" data-link class="btn btn--primary btn--sm">Create work article</a>',
      "</div></div>",
      buildFlash(),
      renderHeroCallout(nextAction),
      '<div class="layout-split"><div class="col-main">',
      renderAlert(
        alertTitle,
        alertBody,
        [
          readyItems.length > 0
            ? '<button class="btn btn--primary btn--sm" type="button" data-run-wave>Advance ready wave</button>'
            : "",
          '<a href="/flow" data-link class="btn btn--outline btn--sm">Open flow</a>',
          '<a href="/guide" data-link class="btn btn--outline btn--sm">How Monsthera works</a>',
        ].filter(Boolean).join(" "),
      ),
      renderCard("Start here", renderStartHere()),
      agentDirectoryEmpty
        ? renderCard("No agents yet", renderAgentDirectoryEmptyState())
        : "",
      renderCard("Needs attention", renderBulletList(attentionItems)),
      renderCard(
        "Latest knowledge",
        latestKnowledgeHtml,
        '<a href="/knowledge" data-link class="btn btn--outline btn--sm">Review notes</a>',
      ),
      '</div><div class="col-side">',
      renderStatCard("Ready wave", readyItems.length, readyItems.length > 0 ? renderBadge("safe to advance", "success") : renderBadge("no ready items", "outline")),
      renderStatCard("Blocked articles", blockedArticles.length, blockedArticles.length > 0 ? renderBadge("needs unblock", "warning") : renderBadge("clear", "success")),
      renderStatCard("Agents", totalAgents, totalAgents > 0 ? renderBadge(`${activeAgents} active`, activeAgents > 0 ? "primary" : "outline") : renderBadge("none yet", "outline")),
      renderStatCard("Automation mode", autoAdvance ? "Auto" : "Manual", renderBadge(autoAdvance ? "loop enabled" : "supervised", autoAdvance ? "success" : "secondary")),
      '<div class="stat-card"><div class="stat-label">System health</div>',
      `<p class="text-sm mt-8">${allHealthy ? "All subsystems are healthy." : "Some subsystems need attention."}</p>`,
      '<div class="mt-8"><a href="/system" data-link class="btn btn--outline btn--sm">Open system</a></div></div>',
      "</div></div>",
    ].join("\n");

    while (wrapper.firstChild) container.appendChild(wrapper.firstChild);
  }

  function rerender() {
    container.textContent = "";
    buildDOM();
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
