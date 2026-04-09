// Knowledge page — API data escaped via esc() in components.js
// Template innerHTML uses <template> element for safe DOM construction
import { getKnowledge, getWork } from "../lib/api.js";
import { renderSearchInput, renderBadge, renderCard, renderMarkdown, timeAgo, esc } from "../lib/components.js";

export async function render(container) {
  const [articles, workArticles] = await Promise.all([
    getKnowledge().catch(() => []),
    getWork().catch(() => []),
  ]);

  let selectedId = articles[0]?.id ?? null;
  let searchQuery = "";

  function getFiltered() {
    if (!searchQuery) return articles;
    const q = searchQuery.toLowerCase();
    return articles.filter(a =>
      a.title.toLowerCase().includes(q) || a.tags?.some(t => t.toLowerCase().includes(q))
    );
  }

  function getCategories(filtered) {
    const cats = new Map();
    for (const a of filtered) {
      if (!cats.has(a.category)) cats.set(a.category, []);
      cats.get(a.category).push(a);
    }
    return cats;
  }

  function getBacklinks(article) {
    if (!article) return { workCount: 0, knowledgeCount: 0 };
    const workCount = workArticles.filter(w =>
      w.references?.includes(article.id) || w.references?.includes(article.slug) ||
      w.codeRefs?.some(r => article.codeRefs?.includes(r))
    ).length;
    const knowledgeCount = articles.filter(a =>
      a.id !== article.id && a.tags?.some(t => article.tags?.includes(t))
    ).length;
    return { workCount, knowledgeCount };
  }

  function buildDOM() {
    const filtered = getFiltered();
    const categories = getCategories(filtered);
    const selected = articles.find(a => a.id === selectedId);
    const backlinks = getBacklinks(selected);

    let navHtml = renderSearchInput("Search articles...");
    navHtml += '<ul class="nav-list" style="margin-top:8px">';
    for (const [cat, items] of categories) {
      navHtml += '<li class="nav-list-group">' + esc(cat) + "</li>";
      for (const a of items) {
        navHtml += '<li><a href="#" data-article="' + esc(a.id) + '" class="' + (a.id === selectedId ? "active" : "") + '">' + esc(a.title) + "</a></li>";
      }
    }
    navHtml += "</ul>";

    let centerHtml = "";
    if (selected) {
      centerHtml = '<h2 style="font-size:20px;font-weight:600">' + esc(selected.title) + "</h2>"
        + '<div class="flex gap-8 items-center mt-4">' + renderBadge(selected.category, "secondary") + ' <span class="text-xs text-muted">Updated ' + timeAgo(selected.updatedAt) + "</span></div>"
        + '<div class="mt-16" style="font-size:14px;line-height:1.7">' + renderMarkdown(selected.content) + "</div>";
    } else {
      centerHtml = '<p class="text-muted">Select an article from the left panel.</p>';
    }

    const metaHtml = renderCard("Backlinks &amp; related",
      '<p class="text-sm">' + backlinks.workCount + " linked work article(s)<br>" + backlinks.knowledgeCount + " related knowledge article(s)</p>")
      + renderCard("Code references",
        selected?.codeRefs?.length
          ? '<ul style="list-style:none">' + selected.codeRefs.map(r => '<li class="mono text-sm" style="padding:2px 0">' + esc(r) + "</li>").join("") + "</ul>"
          : '<p class="text-sm text-muted">No code references.</p>');

    const temp = document.createElement("template");
    temp.innerHTML = [
      '<div class="page-header"><div><h1 class="page-title">Knowledge</h1><p class="page-subtitle">Architecture notes, guides, and decisions.</p></div>',
      '<a href="/knowledge/graph" data-link class="btn btn--outline btn--sm">Open Graph &rarr;</a></div>',
      '<div class="layout-three">',
      '<div class="col-nav">' + navHtml + "</div>",
      '<div class="col-content">' + centerHtml + "</div>",
      '<div class="col-meta">' + metaHtml + "</div>",
      "</div>",
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
    const articleLink = e.target.closest("[data-article]");
    if (articleLink) { e.preventDefault(); selectedId = articleLink.dataset.article; rerender(); }
  });

  container.addEventListener("input", (e) => {
    if (e.target.classList.contains("search-input")) { searchQuery = e.target.value; rerender(); }
  });
}
