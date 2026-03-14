import { describe, expect, it } from "vitest";
import { renderDashboard } from "../../../src/dashboard/html.js";
import { MAX_TICKET_LONG_TEXT_LENGTH } from "../../../src/core/input-hardening.js";

describe("dashboard html", () => {
  it("uses the shared long-text limits and includes quorum UI rendering hooks", () => {
    const html = renderDashboard();

    expect(html).toContain(`id="create-ticket-criteria" name="criteria" maxlength="${MAX_TICKET_LONG_TEXT_LENGTH}"`);
    expect(html).toContain(`id="ticket-comment-content" maxlength="${MAX_TICKET_LONG_TEXT_LENGTH}"`);
    expect(html).toContain("Council Verdicts");
    expect(html).toContain("Quorum");
    expect(html).toContain('id="governance-panel"');
    expect(html).toContain("governance-model-diversity-toggle");
  });
});
