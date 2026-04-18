// ─── Shared UI components ───────────────────────────────────────────────────

export function renderCard(title, contentHtml, actionsHtml) {
  return `
    <div class="card">
      ${title ? `<div class="card-title">${esc(title)}</div>` : ""}
      ${contentHtml}
      ${actionsHtml ? `<div class="mt-8">${actionsHtml}</div>` : ""}
    </div>`;
}

export function renderBadge(text, variant = "secondary") {
  return `<span class="badge badge--${variant}">${esc(text)}</span>`;
}

export function renderStatCard(label, value, badge) {
  return `
    <div class="stat-card">
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value">${esc(String(value))}</div>
      ${badge ? `<div class="mt-4">${badge}</div>` : ""}
    </div>`;
}

export function renderAlert(title, body, actions) {
  return `
    <div class="alert">
      <div class="alert-header">
        <i data-lucide="zap"></i>
        ${esc(title)}
      </div>
      <div class="alert-body">${esc(body)}</div>
      ${actions ? `<div class="alert-actions">${actions}</div>` : ""}
    </div>`;
}

export function renderHeroCallout({ eyebrow, title, body, meta = [], steps = [] }) {
  return `
    <section class="hero-callout">
      ${eyebrow ? `<div class="hero-callout__eyebrow">${esc(eyebrow)}</div>` : ""}
      <div class="hero-callout__title">${esc(title)}</div>
      ${body ? `<div class="hero-callout__body">${esc(body)}</div>` : ""}
      ${meta.length > 0 ? `<div class="hero-callout__meta">${meta.join("")}</div>` : ""}
      ${steps.length > 0 ? `<div class="hero-callout__steps">${steps.map((step) => `
        <div class="hero-callout__step">
          <div class="hero-callout__step-title">${esc(step.title)}</div>
          <div class="text-sm">${esc(step.detail)}</div>
        </div>
      `).join("")}</div>` : ""}
    </section>`;
}

export function renderTable(columns, rows) {
  const ths = columns.map(c =>
    `<th${c.align === "right" ? ' class="text-right"' : ""}${c.width ? ` style="width:${c.width}"` : ""}>${esc(c.label)}</th>`
  ).join("");
  const trs = rows.map(row => {
    const tds = columns.map(c => {
      const val = typeof c.render === "function" ? c.render(row) : esc(String(row[c.key] ?? ""));
      return `<td${c.align === "right" ? ' class="text-right"' : ""}>${val}</td>`;
    }).join("");
    return `<tr>${tds}</tr>`;
  }).join("");
  return `<div class="table-card"><table class="table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

export function renderTabs(items, activeId) {
  return `<div class="tabs">${items.map(item =>
    `<button class="tab${item.id === activeId ? " active" : ""}" data-tab="${esc(item.id)}">${esc(item.label)}</button>`
  ).join("")}</div>`;
}

export function renderChips(items, activeId) {
  return `<div class="chip-bar">${items.map(item =>
    `<button class="chip${item.id === activeId ? " active" : ""}" data-chip="${esc(item.id)}">
      ${esc(item.label)}${item.count != null ? ` <span class="chip-count">${item.count}</span>` : ""}
    </button>`
  ).join("")}</div>`;
}

export function renderSearchInput(placeholder = "Search...", value = "") {
  return `
    <div class="search-input-wrap">
      <i data-lucide="search"></i>
      <input type="text" class="search-input" placeholder="${esc(placeholder)}" value="${esc(value)}">
    </div>`;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInlineMarkdown(text) {
  if (!text) return "";

  const codeTokens = [];
  const linkTokens = [];
  let html = String(text);

  html = html.replace(/`([^`]+)`/g, (_match, code) => {
    const token = `\uE000CODE${codeTokens.length}\uE001`;
    codeTokens.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => {
    const token = `\uE000LINK${linkTokens.length}\uE001`;
    const normalized = String(url).replace(/[\x00-\x20]+/g, "");
    if (/^(javascript|data|vbscript):/i.test(normalized)) {
      linkTokens.push(escapeHtml(label));
      return token;
    }
    linkTokens.push(`<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`);
    return token;
  });

  html = escapeHtml(html)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");

  html = html.replace(/\uE000CODE(\d+)\uE001/g, (_match, index) => codeTokens[Number(index)] ?? "");
  html = html.replace(/\uE000LINK(\d+)\uE001/g, (_match, index) => linkTokens[Number(index)] ?? "");

  return html;
}

export function timeAgo(iso) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function renderMarkdown(text) {
  if (!text) return "";
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paragraphLines = [];
  let listItems = [];
  let inCodeBlock = false;
  let codeFence = "";
  let codeLines = [];

  function flushParagraph() {
    if (paragraphLines.length === 0) return;
    blocks.push(`<p>${renderInlineMarkdown(paragraphLines.join(" "))}</p>`);
    paragraphLines = [];
  }

  function flushList() {
    if (listItems.length === 0) return;
    blocks.push(`<ul>${listItems.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ul>`);
    listItems = [];
  }

  function flushCodeBlock() {
    if (!inCodeBlock) return;
    blocks.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    inCodeBlock = false;
    codeFence = "";
    codeLines = [];
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, "  ");
    const fenceMatch = line.match(/^(```+|~~~+)/);

    if (inCodeBlock) {
      if (fenceMatch && fenceMatch[1][0] === codeFence[0] && fenceMatch[1].length >= codeFence.length) {
        flushCodeBlock();
      } else {
        codeLines.push(rawLine);
      }
      continue;
    }

    if (fenceMatch) {
      flushParagraph();
      flushList();
      inCodeBlock = true;
      codeFence = fenceMatch[1];
      codeLines = [];
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushParagraph();
      flushList();
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = Math.min(headingMatch[1].length + 1, 6);
      blocks.push(`<h${level}>${renderInlineMarkdown(headingMatch[2].trim())}</h${level}>`);
      continue;
    }

    const listMatch = line.match(/^\s*[-*]\s+(.+)$/);
    if (listMatch) {
      flushParagraph();
      listItems.push(listMatch[1].trim());
      continue;
    }

    flushList();
    paragraphLines.push(line.trim());
  }

  flushCodeBlock();
  flushParagraph();
  flushList();

  return blocks.join("");
}

export function esc(str) {
  return escapeHtml(str);
}

export function priorityVariant(priority) {
  switch (priority) {
    case "critical": return "error";
    case "high": return "warning";
    case "medium": return "secondary";
    case "low": return "outline";
    default: return "secondary";
  }
}

export function phaseVariant(phase) {
  switch (phase) {
    case "planning": return "outline";
    case "enrichment": return "secondary";
    case "implementation": return "primary";
    case "review": return "warning";
    case "done": return "success";
    case "cancelled": return "error";
    default: return "secondary";
  }
}
