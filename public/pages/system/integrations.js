// Integrations — placeholder. Only hardcoded strings, no untrusted data.
import { renderCard } from "../../lib/components.js";

export async function render(container) {
  const temp = document.createElement("template");
  temp.innerHTML = '<div class="page-header"><div><h1 class="page-title">Integrations</h1>'
    + '<p class="page-subtitle">Connected apps, MCP surfaces, and webhooks.</p></div></div>'
    + renderCard("Connected services", '<p class="text-sm text-muted">Integrations are configured at the server level and not yet exposed via the dashboard API.</p>');
  container.appendChild(temp.content);
}
