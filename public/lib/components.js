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
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => {
      // Browsers ignore tabs (\x09), newlines (\x0a), CR (\x0d), and other control
      // chars both before AND within a URI scheme. Strip them all before testing so
      // obfuscated variants like "java\tscript:" or "\x01javascript:" are caught.
      const normalized = url.replace(/[\x00-\x20]+/g, '');
      if (/^(javascript|data|vbscript):/i.test(normalized)) {
        return label; // Strip unsafe link, keep text
      }
      return '<a href="' + url.replace(/"/g, '&quot;') + '">' + label + '</a>';
    })
    .replace(/\n\n/g, '</p><p>')
    .replace(/^/, '<p>')
    .replace(/$/, '</p>');
}

export function esc(str) {
  if (str == null) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
