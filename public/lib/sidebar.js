// ─── Sidebar renderer ───────────────────────────────────────────────────────
//
// Security note: All content rendered here comes from hardcoded nav items and
// theme state — no user-supplied or API-derived data is interpolated into HTML.
// innerHTML usage is safe in this context as there is no untrusted input.

import { navigate } from "./router.js";
import { getConvoys } from "./api.js";

const NAV_ITEMS = [
  { icon: "layout-dashboard", label: "Overview", path: "/" },
  { icon: "compass", label: "Guide", path: "/guide" },
  { icon: "activity", label: "Flow", path: "/flow" },
  { icon: "list-todo", label: "Work", path: "/work" },
  { icon: "radio", label: "Events", path: "/events" },
  { icon: "git-fork", label: "Convoys", path: "/convoys" },
  { icon: "book-open", label: "Knowledge", path: "/knowledge" },
  { icon: "search", label: "Search", path: "/search" },
  { icon: "settings", label: "System", path: "/system" },
];

const SYSTEM_SUBNAV = [
  { label: "Health", path: "/system" },
  { label: "Models & Runtime", path: "/system/models" },
  { label: "Agent Profiles", path: "/system/agents" },
  { label: "Integrations", path: "/system/integrations" },
  { label: "Storage & Indexing", path: "/system/storage" },
  { label: "Security", path: "/security" },
];

export function renderSidebar(currentPath) {
  const isSystemActive = currentPath.startsWith("/system") || currentPath === "/security";

  const navHtml = NAV_ITEMS.map(item => {
    const active = item.path === "/"
      ? currentPath === "/"
      : item.path === "/system"
        ? isSystemActive
        : currentPath.startsWith(item.path);
    return `<li>
      <a href="${item.path}" data-link class="${active ? "active" : ""}">
        <i data-lucide="${item.icon}"></i>
        ${item.label}
        ${item.path === "/convoys" ? '<span class="nav-badge" id="convoy-warning-badge" hidden></span>' : ""}
      </a>
      ${item.path === "/system" ? renderSubnav(currentPath, isSystemActive) : ""}
    </li>`;
  }).join("");

  const theme = document.documentElement.getAttribute("data-theme");
  const themeIcon = theme === "dark" ? "sun" : "moon";

  return `
    <div class="sidebar-logo">
      <i data-lucide="leaf"></i>
      Monsthera
    </div>
    <ul class="sidebar-nav">
      ${navHtml}
    </ul>
    <div class="sidebar-footer">
      <div class="sidebar-footer-text">code · research · memory<br>workspace active</div>
      <button class="theme-toggle" id="theme-toggle" title="Toggle theme">
        <i data-lucide="${themeIcon}"></i>
      </button>
    </div>`;
}

function renderSubnav(currentPath, isOpen) {
  const items = SYSTEM_SUBNAV.map(item => {
    const active = item.path === "/system"
      ? currentPath === "/system"
      : currentPath === item.path;
    return `<li><a href="${item.path}" data-link class="${active ? "active" : ""}">${item.label}</a></li>`;
  }).join("");
  return `<ul class="sidebar-subnav${isOpen ? " open" : ""}">${items}</ul>`;
}

export function initSidebar() {
  const sidebar = document.getElementById("sidebar");

  // Theme toggle
  sidebar.addEventListener("click", (e) => {
    const toggle = e.target.closest("#theme-toggle");
    if (toggle) {
      const html = document.documentElement;
      const current = html.getAttribute("data-theme");
      const next = current === "dark" ? "light" : "dark";
      html.setAttribute("data-theme", next);
      localStorage.setItem("monsthera-theme", next);
      updateSidebar(window.location.pathname);
    }
  });

  // Nav link clicks
  sidebar.addEventListener("click", (e) => {
    const link = e.target.closest("[data-link]");
    if (link) {
      e.preventDefault();
      navigate(link.getAttribute("href"));
    }
  });
}

export function updateSidebar(currentPath) {
  const sidebar = document.getElementById("sidebar");
  // Safe: all content is from hardcoded nav items, no user/API input
  sidebar.innerHTML = renderSidebar(currentPath);
  if (typeof lucide !== "undefined") lucide.createIcons({ nodes: [sidebar] });
  refreshConvoyWarningBadge();
}

let badgeRefreshInFlight = null;

export async function refreshConvoyWarningBadge() {
  if (badgeRefreshInFlight) return badgeRefreshInFlight;
  badgeRefreshInFlight = (async () => {
    try {
      const data = await getConvoys();
      const count = (data?.warnings || []).length;
      const badge = document.getElementById("convoy-warning-badge");
      if (!badge) return;
      if (count > 0) {
        badge.textContent = String(count);
        badge.hidden = false;
        badge.setAttribute("aria-label", `${count} unresolved convoy warning${count === 1 ? "" : "s"}`);
      } else {
        badge.hidden = true;
        badge.removeAttribute("aria-label");
      }
    } catch {
      // Silent — previous count preserved.
    } finally {
      badgeRefreshInFlight = null;
    }
  })();
  return badgeRefreshInFlight;
}
