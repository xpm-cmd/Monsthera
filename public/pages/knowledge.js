// Knowledge page — API data escaped via esc() in components.js.
import {
  getKnowledge,
  getWork,
  createKnowledge,
  updateKnowledge,
  deleteKnowledge,
  ingestLocalKnowledge,
  previewSlug,
  renameKnowledgeSlug,
  batchCreateKnowledge,
  batchUpdateKnowledge,
} from "../lib/api.js";
import {
  renderSearchInput,
  renderBadge,
  renderCard,
  renderHeroCallout,
  renderMarkdown,
  timeAgo,
  esc,
} from "../lib/components.js";

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildCreateForm() {
  return [
    '<form class="card form-stack" data-knowledge-create>',
    '<div class="card-title">Create knowledge article</div>',
    '<div class="form-grid form-grid--two">',
    '<label class="field"><span class="text-label">Title</span><input class="input" name="title" placeholder="Architecture overview" data-preview-slug-input required></label>',
    '<label class="field"><span class="text-label">Category</span><input class="input" name="category" value="engineering" required></label>',
    '</div>',
    '<p class="text-xs text-muted" data-slug-preview>Slug will be auto-generated from the title.</p>',
    '<label class="field"><span class="text-label">Tags</span><input class="input" name="tags" placeholder="architecture, search"></label>',
    '<label class="field"><span class="text-label">Code refs</span><input class="input" name="codeRefs" placeholder="src/search/service.ts, src/dashboard/index.ts"></label>',
    '<label class="field"><span class="text-label">Content</span><textarea class="textarea textarea--dense" name="content" placeholder="# Summary&#10;&#10;Explain the decision and the important code paths." required></textarea></label>',
    '<div class="form-actions"><button class="btn btn--primary btn--sm" type="submit">Create article</button></div>',
    '</form>',
  ].join("");
}

const BATCH_CREATE_EXAMPLE = JSON.stringify(
  [
    { title: "First Article", category: "architecture", content: "# Summary\n\nBody.", tags: ["ops"] },
    { title: "Second Article", category: "operations", content: "Another body." },
  ],
  null,
  2,
);

const BATCH_UPDATE_EXAMPLE = JSON.stringify(
  [
    { id: "k-abc123", content: "Revised body." },
    { id: "k-def456", tags: ["renamed"], new_slug: "second-article-renamed" },
  ],
  null,
  2,
);

const MAX_BATCH_ARTICLES = 100;

function validateBatchPayload(mode, raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, errors: [`Invalid JSON: ${err.message}`] };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, errors: ["Payload must be a JSON array of objects."] };
  }
  if (parsed.length === 0) {
    return { ok: false, errors: ["Array must contain at least one entry."] };
  }
  if (parsed.length > MAX_BATCH_ARTICLES) {
    return { ok: false, errors: [`At most ${MAX_BATCH_ARTICLES} entries per batch (got ${parsed.length}).`] };
  }
  const errors = [];
  parsed.forEach((entry, idx) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      errors.push(`Entry ${idx}: must be an object.`);
      return;
    }
    if (mode === "create") {
      if (typeof entry.title !== "string" || entry.title.trim().length === 0) {
        errors.push(`Entry ${idx}: "title" is required and must be a non-empty string.`);
      }
      if (typeof entry.category !== "string" || entry.category.trim().length === 0) {
        errors.push(`Entry ${idx}: "category" is required and must be a non-empty string.`);
      }
      if (typeof entry.content !== "string" || entry.content.trim().length === 0) {
        errors.push(`Entry ${idx}: "content" is required and must be a non-empty string.`);
      }
    } else {
      if (typeof entry.id !== "string" || entry.id.trim().length === 0) {
        errors.push(`Entry ${idx}: "id" is required and must be a non-empty string.`);
      }
    }
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, entries: parsed };
}

function buildBatchForm(state) {
  const placeholder = state.mode === "update" ? BATCH_UPDATE_EXAMPLE : BATCH_CREATE_EXAMPLE;
  return [
    '<form class="card form-stack" data-knowledge-batch>',
    '<div class="card-title">Bulk import (JSON)</div>',
    `<p class="text-xs text-muted">Paste a JSON array of up to ${MAX_BATCH_ARTICLES} entries. Each entry is validated and applied independently — partial failures do not abort the batch.</p>`,
    '<div class="form-actions" style="gap:16px">',
    `<label class="checkbox"><input type="radio" name="batchMode" value="create"${state.mode === "create" ? " checked" : ""}> <span>Create</span></label>`,
    `<label class="checkbox"><input type="radio" name="batchMode" value="update"${state.mode === "update" ? " checked" : ""}> <span>Update</span></label>`,
    '</div>',
    `<label class="field"><span class="text-label">JSON payload</span><textarea class="textarea mono" name="payload" rows="12" placeholder="${esc(placeholder)}">${esc(state.payload || "")}</textarea></label>`,
    '<div class="form-actions">',
    '<button class="btn btn--outline btn--sm" type="button" data-batch-validate>Validate</button>',
    `<button class="btn btn--primary btn--sm" type="submit">${state.mode === "update" ? "Submit updates" : "Submit create"}</button>`,
    '</div>',
    '</form>',
  ].join("");
}

function buildBatchResult(result) {
  const rows = (result.items || []).map((item) => {
    if (item.ok) {
      return `<li class="text-sm">#${item.index} · <strong>ok</strong> · <span class="mono">${esc(item.article?.id || "")}</span> ${esc(item.article?.title || "")}</li>`;
    }
    return `<li class="text-sm text-error">#${item.index} · <strong>${esc(item.error?.code || "ERROR")}</strong> · ${esc(item.error?.message || "unknown")}</li>`;
  });
  return [
    '<div class="card">',
    `<div class="card-title">Batch result — ${result.succeeded}/${result.total} succeeded, ${result.failed} failed</div>`,
    `<ul style="list-style:none;padding-left:0;margin:0">${rows.join("")}</ul>`,
    '</div>',
  ].join("");
}

function buildImportForm() {
  return [
    '<form class="card form-stack" data-knowledge-import>',
    '<div class="card-title">Import local sources</div>',
    '<label class="field"><span class="text-label">Path</span><input class="input" name="sourcePath" placeholder="docs/adrs" required></label>',
    '<div class="form-grid form-grid--two">',
    '<label class="field"><span class="text-label">Category override</span><input class="input" name="category" placeholder="docs"></label>',
    '<label class="field"><span class="text-label">Tags</span><input class="input" name="tags" placeholder="imported, architecture"></label>',
    '</div>',
    '<label class="field"><span class="text-label">Code refs (extra)</span><input class="input" name="codeRefs" placeholder="src/dashboard/index.ts"></label>',
    '<div class="form-actions">',
    '<label class="checkbox"><input type="checkbox" name="summaryMode"> <span>Create summarized knowledge article</span></label>',
    '</div>',
    '<div class="form-actions">',
    '<label class="checkbox"><input type="checkbox" name="recursive" checked> <span>Recursive directory import</span></label>',
    '<label class="checkbox"><input type="checkbox" name="replaceExisting" checked> <span>Replace existing imported articles</span></label>',
    '</div>',
    '<div class="form-actions"><button class="btn btn--primary btn--sm" type="submit">Import sources</button></div>',
    '</form>',
  ].join("");
}

function buildEditor(article) {
  const tagsValue = (article.tags || []).join(", ");
  const codeRefsValue = (article.codeRefs || []).join(", ");
  return [
    `<form class="card form-stack" data-knowledge-edit="${esc(article.id)}">`,
    '<div class="card-title">Edit selected article</div>',
    '<div class="form-grid form-grid--two">',
    `<label class="field"><span class="text-label">Title</span><input class="input" name="title" value="${esc(article.title)}" required></label>`,
    `<label class="field"><span class="text-label">Category</span><input class="input" name="category" value="${esc(article.category)}" required></label>`,
    '</div>',
    `<label class="field"><span class="text-label">Tags</span><input class="input" name="tags" value="${esc(tagsValue)}"></label>`,
    `<label class="field"><span class="text-label">Code refs</span><input class="input" name="codeRefs" value="${esc(codeRefsValue)}"></label>`,
    `<label class="field"><span class="text-label">Content</span><textarea class="textarea" name="content">${esc(article.content || "")}</textarea></label>`,
    '<div class="form-actions"><button class="btn btn--primary btn--sm" type="submit">Save article</button></div>',
    '</form>',
    `<form class="card form-stack" data-knowledge-rename="${esc(article.id)}">`,
    '<div class="card-title">Rename slug</div>',
    `<p class="text-xs text-muted">Current: <span class="mono">${esc(article.slug)}</span>. Renaming atomically updates every other article's <code>references</code> to the new slug.</p>`,
    `<label class="field"><span class="text-label">New slug</span><input class="input mono" name="newSlug" value="${esc(article.slug)}" placeholder="lowercase-hyphen-separated" pattern="[a-z0-9\\-]+" required></label>`,
    '<label class="checkbox"><input type="checkbox" name="rewriteInlineWikilinks"> <span>Also rewrite <code>[[old-slug]]</code> wikilinks in other articles\' bodies</span></label>',
    '<div class="form-actions"><button class="btn btn--outline btn--sm" type="submit">Rename slug</button></div>',
    '</form>',
    renderCard("Rendered preview", `<div class="markdown-preview">${renderMarkdown(article.content)}</div>`),
  ].join("");
}

export async function render(container) {
  let [articles, workArticles] = await Promise.all([
    getKnowledge().catch(() => []),
    getWork().catch(() => []),
  ]);

  let selectedId = articles[0]?.id ?? null;
  let searchQuery = "";
  let showCreate = false;
  let flash = null;
  let inputState = {
    restore: false,
    start: 0,
    end: 0,
  };
  let batchState = { mode: "create", payload: "" };
  let batchResult = null;

  function captureInputState(input) {
    inputState = {
      restore: true,
      start: input.selectionStart ?? searchQuery.length,
      end: input.selectionEnd ?? searchQuery.length,
    };
  }

  async function refresh(preferredId = selectedId) {
    [articles, workArticles] = await Promise.all([
      getKnowledge().catch(() => []),
      getWork().catch(() => []),
    ]);
    if (preferredId && articles.some((article) => article.id === preferredId)) {
      selectedId = preferredId;
    } else {
      selectedId = articles[0]?.id ?? null;
    }
  }

  async function runMutation(action, successMessage, preferredId = selectedId) {
    try {
      const result = await action();
      flash = { kind: "success", message: successMessage };
      showCreate = false;
      await refresh(result?.id || result?.items?.[0]?.articleId || preferredId || null);
      rerender();
    } catch (error) {
      flash = { kind: "error", message: error?.message || "Request failed" };
      rerender();
    }
  }

  function getFiltered() {
    if (!searchQuery) return articles;
    const q = searchQuery.toLowerCase();
    return articles.filter((article) =>
      article.title.toLowerCase().includes(q)
      || article.category.toLowerCase().includes(q)
      || article.tags?.some((tag) => tag.toLowerCase().includes(q)),
    );
  }

  function getCategories(filtered) {
    const categories = new Map();
    for (const article of filtered) {
      if (!categories.has(article.category)) categories.set(article.category, []);
      categories.get(article.category).push(article);
    }
    return categories;
  }

  function getBacklinks(article) {
    if (!article) return { workCount: 0, knowledgeCount: 0 };
    const workCount = workArticles.filter((work) =>
      work.references?.includes(article.id)
      || work.references?.includes(article.slug)
      || work.codeRefs?.some((ref) => article.codeRefs?.includes(ref))
    ).length;
    const knowledgeCount = articles.filter((other) =>
      other.id !== article.id && other.tags?.some((tag) => article.tags?.includes(tag))
    ).length;
    return { workCount, knowledgeCount };
  }

  function buildFlash() {
    if (!flash) return "";
    const variant = flash.kind === "error" ? "error" : "success";
    return `<div class="inline-notice inline-notice--${variant}">${esc(flash.message)}</div>`;
  }

  function buildDOM() {
    const filtered = getFiltered();
    const categories = getCategories(filtered);
    const selected = articles.find((article) => article.id === selectedId) ?? null;
    const backlinks = getBacklinks(selected);

    let navHtml = renderSearchInput("Search articles...", searchQuery);
    navHtml += '<ul class="nav-list" style="margin-top:8px">';
    for (const [category, items] of categories) {
      navHtml += `<li class="nav-list-group">${esc(category)}</li>`;
      for (const article of items) {
        navHtml += `<li><a href="#" data-article="${esc(article.id)}" class="${article.id === selectedId ? "active" : ""}">${esc(article.title)}</a><div class="mt-4">${article.diagnostics?.freshness ? renderBadge(article.diagnostics.freshness.label, article.diagnostics.freshness.state === "fresh" ? "success" : article.diagnostics.freshness.state === "attention" ? "warning" : article.diagnostics.freshness.state === "stale" ? "error" : "outline") : ""}</div></li>`;
      }
    }
    navHtml += "</ul>";

    const centerParts = [];
    if (showCreate) centerParts.push(buildCreateForm());
    if (showCreate) centerParts.push(buildImportForm());
    if (showCreate) centerParts.push(buildBatchForm(batchState));
    if (showCreate && batchResult) centerParts.push(buildBatchResult(batchResult));
    if (selected) {
      centerParts.push(
        `<div class="page-section"><h2 style="font-size:20px;font-weight:600">${esc(selected.title)}</h2><div class="flex gap-8 items-center mt-4" style="flex-wrap:wrap">${renderBadge(selected.category, "secondary")}${selected.diagnostics?.freshness ? renderBadge(selected.diagnostics.freshness.label, selected.diagnostics.freshness.state === "fresh" ? "success" : selected.diagnostics.freshness.state === "attention" ? "warning" : selected.diagnostics.freshness.state === "stale" ? "error" : "outline") : ""}${selected.diagnostics?.quality ? renderBadge(`${selected.diagnostics.quality.score}/100`, "outline") : ""}<span class="text-xs text-muted">Updated ${timeAgo(selected.updatedAt)}</span></div></div>`,
      );
      centerParts.push(buildEditor(selected));
    } else {
      centerParts.push('<p class="text-muted">No knowledge article selected.</p>');
    }

    const metaParts = [
      renderCard(
        "Backlinks & related",
        `<p class="text-sm">${backlinks.workCount} linked work article(s)<br>${backlinks.knowledgeCount} related knowledge article(s)</p>`,
      ),
      renderCard(
        "Code references",
        selected?.codeRefs?.length
          ? `<ul style="list-style:none">${selected.codeRefs.map((ref) => `<li class="mono text-sm" style="padding:2px 0">${esc(ref)}</li>`).join("")}</ul>`
          : '<p class="text-sm text-muted">No code references.</p>',
      ),
      renderCard(
        "Context quality",
        selected?.diagnostics
          ? `<p class="text-sm" style="font-weight:600">${esc(selected.diagnostics.quality.label)} · ${esc(String(selected.diagnostics.quality.score))}/100</p><p class="text-xs text-muted mt-4">${esc(selected.diagnostics.quality.summary)}</p><div class="mt-8">${selected.recommendedFor?.length ? selected.recommendedFor.map((mode) => renderBadge(mode, mode === "code" ? "primary" : mode === "research" ? "warning" : "secondary")).join(" ") : ""}</div>`
          : '<p class="text-sm text-muted">Quality diagnostics unavailable.</p>',
      ),
    ];

    if (selected) {
      metaParts.push(
        renderCard(
          "Actions",
          `<p class="text-sm text-muted">ID: <span class="mono">${esc(selected.id)}</span></p>${selected.sourcePath ? `<p class="text-sm text-muted mt-4">Source: <span class="mono">${esc(selected.sourcePath)}</span></p>` : ""}${selected.diagnostics?.freshness?.detail ? `<p class="text-xs text-muted mt-4">${esc(selected.diagnostics.freshness.detail)}</p>` : ""}`,
          `<button class="btn btn--ghost btn--sm" type="button" data-delete-knowledge="${esc(selected.id)}">Delete article</button>`,
        ),
      );
    }

    const temp = document.createElement("template");
    const knowledgePrimer = renderHeroCallout({
      eyebrow: "Shared memory",
      title: "Save what should survive the current task",
      body: "Knowledge is where guides, architecture notes, imported sources, and reusable implementation lessons become retrievable for later humans and agents.",
      meta: [
        renderBadge(`${articles.length} articles`, "secondary"),
        renderBadge(selected?.diagnostics?.freshness?.label || "select an article", selected?.diagnostics?.freshness?.state === "fresh" ? "success" : selected?.diagnostics?.freshness?.state === "attention" ? "warning" : selected?.diagnostics?.freshness?.state === "stale" ? "error" : "outline"),
      ],
      steps: [
        { title: "Capture", detail: "Write the durable conclusion, not just a temporary note." },
        { title: "Ground", detail: "Attach code refs and source paths when they exist." },
        { title: "Reuse", detail: "Reference strong knowledge from work so execution starts from a better baseline." },
      ],
    });
    temp.innerHTML = [
      '<div class="page-header"><div><div class="page-kicker">Build durable context</div><h1 class="page-title">Knowledge</h1><p class="page-subtitle">Create, edit, and connect the Markdown knowledge base.</p></div><div class="page-actions">',
      '<a href="/guide" data-link class="btn btn--outline btn--sm">Open guide</a>',
      '<button class="btn btn--outline btn--sm" type="button" data-toggle-create>' + (showCreate ? "Close form" : "New article") + "</button>",
      '<a href="/knowledge/graph" data-link class="btn btn--outline btn--sm">Open Graph →</a></div></div>',
      buildFlash(),
      knowledgePrimer,
      '<div class="layout-three">',
      `<div class="col-nav">${navHtml}</div>`,
      `<div class="col-content">${centerParts.join("")}</div>`,
      `<div class="col-meta">${metaParts.join("")}</div>`,
      "</div>",
    ].join("\n");
    return temp.content;
  }

  function rerender() {
    container.textContent = "";
    container.appendChild(buildDOM());
    if (inputState.restore) {
      const input = container.querySelector(".search-input");
      if (input) {
        input.focus();
        const start = Math.min(inputState.start, input.value.length);
        const end = Math.min(inputState.end, input.value.length);
        input.setSelectionRange(start, end);
      }
    }
    if (typeof lucide !== "undefined") lucide.createIcons({ nodes: [container] });
  }

  rerender();

  const ac = new AbortController();

  container.addEventListener("click", async (event) => {
    const target = event.target;

    const toggleCreate = target.closest("[data-toggle-create]");
    if (toggleCreate) {
      inputState.restore = false;
      showCreate = !showCreate;
      rerender();
      return;
    }

    const articleLink = target.closest("[data-article]");
    if (articleLink) {
      event.preventDefault();
      inputState.restore = false;
      selectedId = articleLink.dataset.article;
      rerender();
      return;
    }

    const deleteButton = target.closest("[data-delete-knowledge]");
    if (deleteButton) {
      if (!window.confirm(`Delete knowledge article ${deleteButton.dataset.deleteKnowledge}?`)) return;
      await runMutation(
        async () => {
          await deleteKnowledge(deleteButton.dataset.deleteKnowledge);
          return { id: null };
        },
        "Deleted knowledge article.",
        null,
      );
      return;
    }

    const validateButton = target.closest("[data-batch-validate]");
    if (validateButton) {
      const form = validateButton.closest("form");
      const textarea = form?.querySelector('[name="payload"]');
      const mode = form?.querySelector('input[name="batchMode"]:checked')?.value || batchState.mode;
      const payload = textarea?.value || "";
      batchState = { mode, payload };
      const v = validateBatchPayload(mode, payload);
      if (v.ok) {
        flash = { kind: "success", message: `Payload valid — ${v.entries.length} entry(ies) ready to submit.` };
        batchResult = null;
      } else {
        flash = { kind: "error", message: v.errors.join(" · ") };
      }
      rerender();
      return;
    }
  }, { signal: ac.signal });

  container.addEventListener("change", (event) => {
    const radio = event.target.closest('input[name="batchMode"]');
    if (radio) {
      const form = radio.closest("form");
      const textarea = form?.querySelector('[name="payload"]');
      batchState = { mode: radio.value, payload: textarea?.value || "" };
      rerender();
    }
  }, { signal: ac.signal });

  function renderSlugPreview(el, result) {
    el.textContent = "";
    if (result.alreadyExists) {
      el.append("Slug ");
      const code = document.createElement("code");
      code.className = "mono";
      code.textContent = result.slug;
      el.append(code, " already exists — pick a different title or content will collide.");
      return;
    }
    el.append("Slug will be ");
    const code = document.createElement("code");
    code.className = "mono";
    code.textContent = result.slug;
    el.append(code);
    if (result.conflicts?.length) {
      el.append(" · near-miss conflicts: ");
      result.conflicts.forEach((conflict, index) => {
        if (index > 0) el.append(", ");
        const c = document.createElement("code");
        c.className = "mono";
        c.textContent = conflict;
        el.append(c);
      });
    }
    el.append(".");
  }

  let slugPreviewTimer = null;
  container.addEventListener("input", (event) => {
    if (event.target.classList.contains("search-input")) {
      captureInputState(event.target);
      searchQuery = event.target.value;
      rerender();
      return;
    }

    const titleInput = event.target.closest("[data-preview-slug-input]");
    if (titleInput) {
      clearTimeout(slugPreviewTimer);
      const preview = container.querySelector("[data-slug-preview]");
      if (!preview) return;
      const title = titleInput.value.trim();
      if (!title) {
        preview.textContent = "Slug will be auto-generated from the title.";
        return;
      }
      preview.textContent = "Checking slug…";
      slugPreviewTimer = setTimeout(async () => {
        try {
          const res = await previewSlug(title);
          renderSlugPreview(preview, res);
        } catch (_err) {
          preview.textContent = "Slug preview unavailable.";
        }
      }, 300);
    }
  }, { signal: ac.signal });

  container.addEventListener("submit", async (event) => {
    const form = event.target.closest("form");
    if (!form) return;
    event.preventDefault();

    if (form.matches("[data-knowledge-create]")) {
      const data = new FormData(form);
      await runMutation(
        () => createKnowledge({
          title: String(data.get("title") || "").trim(),
          category: String(data.get("category") || "engineering").trim(),
          tags: parseCsv(data.get("tags")),
          codeRefs: parseCsv(data.get("codeRefs")),
          content: String(data.get("content") || "").trim(),
        }),
        "Created knowledge article.",
      );
      form.reset();
      form.querySelector('[name="category"]').value = "engineering";
      return;
    }

    if (form.matches("[data-knowledge-import]")) {
      const data = new FormData(form);
      await runMutation(
        () => ingestLocalKnowledge({
          sourcePath: String(data.get("sourcePath") || "").trim(),
          category: String(data.get("category") || "").trim() || undefined,
          tags: parseCsv(data.get("tags")),
          codeRefs: parseCsv(data.get("codeRefs")),
          mode: data.get("summaryMode") !== null ? "summary" : "raw",
          recursive: data.get("recursive") !== null,
          replaceExisting: data.get("replaceExisting") !== null,
        }),
        "Imported local source(s) into knowledge.",
      );
      return;
    }

    if (form.matches("[data-knowledge-edit]")) {
      const data = new FormData(form);
      const id = form.dataset.knowledgeEdit;
      await runMutation(
        () => updateKnowledge(id, {
          title: String(data.get("title") || "").trim(),
          category: String(data.get("category") || "").trim(),
          tags: parseCsv(data.get("tags")),
          codeRefs: parseCsv(data.get("codeRefs")),
          content: String(data.get("content") || "").trim(),
        }),
        "Saved knowledge article.",
        id,
      );
      return;
    }

    if (form.matches("[data-knowledge-batch]")) {
      const data = new FormData(form);
      const mode = String(data.get("batchMode") || "create");
      const payload = String(data.get("payload") || "");
      batchState = { mode, payload };
      const v = validateBatchPayload(mode, payload);
      if (!v.ok) {
        flash = { kind: "error", message: v.errors.join(" · ") };
        rerender();
        return;
      }
      try {
        const result = mode === "update"
          ? await batchUpdateKnowledge(v.entries)
          : await batchCreateKnowledge(v.entries);
        batchResult = result;
        flash = {
          kind: result.failed === 0 ? "success" : "error",
          message: `${result.succeeded}/${result.total} entries ${mode === "update" ? "updated" : "created"}. ${result.failed} failed.`,
        };
        await refresh(selectedId);
        rerender();
      } catch (error) {
        flash = { kind: "error", message: error?.message || "Batch request failed." };
        rerender();
      }
      return;
    }

    if (form.matches("[data-knowledge-rename]")) {
      const data = new FormData(form);
      const id = form.dataset.knowledgeRename;
      const newSlug = String(data.get("newSlug") || "").trim();
      const rewriteInlineWikilinks = data.get("rewriteInlineWikilinks") !== null;
      if (!newSlug || !/^[a-z0-9-]+$/.test(newSlug)) {
        flash = { kind: "error", message: "New slug must be lowercase letters, numbers, and hyphens." };
        rerender();
        return;
      }
      const confirmMsg = rewriteInlineWikilinks
        ? `Rename slug to "${newSlug}" and rewrite [[${newSlug}]] wikilinks in other articles' bodies?`
        : `Rename slug to "${newSlug}"? References in other articles will be updated automatically.`;
      if (!window.confirm(confirmMsg)) return;
      await runMutation(
        () => renameKnowledgeSlug(id, newSlug, { rewriteInlineWikilinks }),
        `Renamed slug to ${newSlug}.`,
        id,
      );
      return;
    }
  }, { signal: ac.signal });

  return { cleanup: () => ac.abort() };
}
