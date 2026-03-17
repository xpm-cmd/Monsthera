import * as queries from "../db/queries.js";

/**
 * Check if all tickets in a work group are completed (resolved/closed/wont_fix).
 * If so, auto-transition the group to "completed".
 * Called as a side-effect of ticket status changes in tickets/service.ts.
 */
export function autoCompleteWorkGroups(
  db: Parameters<typeof queries.getWorkGroupsForTicket>[0],
  ticketInternalId: number,
): void {
  const groups = queries.getWorkGroupsForTicket(db, ticketInternalId);

  for (const group of groups) {
    if (group.status !== "open") continue;

    const fullGroup = queries.getWorkGroupByGroupId(db, group.groupId);
    if (!fullGroup) continue;

    const progress = queries.getWorkGroupProgress(db, fullGroup.id);

    // Don't auto-complete empty groups
    if (progress.totalTickets === 0) continue;

    // Check if all tickets are in a completed status
    if (progress.completionPercent === 100) {
      queries.updateWorkGroup(db, fullGroup.id, {
        status: "completed",
        updatedAt: new Date().toISOString(),
      });
    }
  }
}
