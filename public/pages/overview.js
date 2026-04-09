// Overview page — all API data escaped via esc() before HTML interpolation
import { getStatus, getHealth, getWork, getKnowledge } from "../lib/api.js";
import { renderAlert, renderStatCard, renderBadge, renderCard, timeAgo, esc } from "../lib/components.js";
import { navigate } from "../lib/router.js";

export async function render(container) {
  const [status, health, workArticles, knowledgeArticles] = await Promise.all([
    getStatus().catch(() => null),
    getHealth().catch(() => null),
    getWork().catch(() => []),
    getKnowledge().catch(() => []),
  ]);

  const activeWork = workArticles.filter(w => w.phase !== "done" && w.phase !== "cancelled");
  const blockedArticles = workArticles.filter(w => w.blockedBy && w.blockedBy.length > 0);
  const inReview = workArticles.filter(w => w.phase === "review");
  const pendingReviews = inReview.filter(w => w.reviewers?.some(r => r.status === "pending"));

  const attentionItems = [];
  for (const w of workArticles) {
    if (w.blockedBy && w.blockedBy.length > 0)
      attentionItems.push(esc(w.title) + " is blocked by " + w.blockedBy.length + " dependency(ies)");
    if (w.reviewers?.some(r => r.status === "pending"))
      attentionItems.push(esc(w.title) + " has pending review(s)");
    if (w.phase === "implementation" && !w.assignee)
      attentionItems.push(esc(w.title) + " is unassigned in implementation");
  }

  const sortedKnowledge = [...knowledgeArticles].sort((a, b) =>
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const latestKnowledge = sortedKnowledge[0];
  const allHealthy = health?.subsystems?.every(s => s.healthy) ?? false;

  const alertTitle = pendingReviews.length > 0
    ? pendingReviews.length + " article(s) ready for review"
    : "No pending reviews";
  const alertBody = pendingReviews.map(w => esc(w.title)).join(", ") || "All reviews are up to date.";

  const attentionHtml = attentionItems.length > 0
    ? '<ul style="list-style:disc;padding-left:20px;font-size:14px">' + attentionItems.map(i => "<li>" + i + "</li>").join("") + "</ul>"
    : '<p class="text-sm text-muted">Nothing needs attention right now.</p>';

  const knowledgeHtml = latestKnowledge
    ? '<p class="text-sm">' + esc(String(knowledgeArticles.length)) + ' article(s). Most recent: <strong>' + esc(latestKnowledge.title) + '</strong> (' + timeAgo(latestKnowledge.updatedAt) + ')</p>'
    : '<p class="text-sm text-muted">No knowledge articles yet.</p>';

  // Build DOM safely — all interpolated values are escaped
  const wrapper = document.createElement("div");
  wrapper.innerHTML = [
    '<div class="page-header"><div>',
    '<h1 class="page-title">Overview</h1>',
    '<p class="page-subtitle">Work health, blockers, and knowledge freshness.</p>',
    '</div><div class="flex gap-8">',
    '<a href="/search" data-link class="btn btn--outline btn--sm">Open Search</a>',
    '<a href="/work" data-link class="btn btn--primary btn--sm">+ New Work Article</a>',
    '</div></div>',
    '<div class="layout-split"><div class="col-main">',
    renderAlert(alertTitle, alertBody,
      pendingReviews.length > 0
        ? '<a href="/flow" data-link class="btn btn--primary btn--sm">Review articles</a> <a href="/work" data-link class="btn btn--outline btn--sm">View work queue</a>'
        : ""),
    renderCard("Needs attention", attentionHtml),
    renderCard("Latest knowledge", knowledgeHtml,
      knowledgeArticles.length > 0 ? '<a href="/knowledge" data-link class="btn btn--outline btn--sm">Review notes</a>' : ""),
    '</div><div class="col-side">',
    renderStatCard("Active work", activeWork.length,
      activeWork.length > 0 ? renderBadge(inReview.length + " in review", "success") : ""),
    renderStatCard("Blocked articles", blockedArticles.length,
      blockedArticles.length > 0 ? renderBadge(blockedArticles.length + " blocked", "warning") : ""),
    renderStatCard("Knowledge articles", knowledgeArticles.length,
      latestKnowledge ? renderBadge("updated " + timeAgo(latestKnowledge.updatedAt), "success") : ""),
    '<div class="stat-card"><div class="stat-label">System health</div>',
    '<p class="text-sm" style="margin-top:8px">' + (allHealthy ? "All subsystems healthy." : "Some subsystems unhealthy.") + '</p>',
    '<div class="mt-8"><a href="/system" data-link class="btn btn--outline btn--sm">Open system</a></div></div>',
    '</div></div>',
  ].join("\n");

  while (wrapper.firstChild) container.appendChild(wrapper.firstChild);
}
