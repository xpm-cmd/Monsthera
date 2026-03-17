// Re-export from canonical location in core/ layer.
// This module was moved to core/events.ts to fix upward dependency violations.
export {
  type DashboardEvent,
  recordDashboardEvent,
  getDashboardEventsAfter,
  getLatestDashboardEventId,
  getLatestTicketSyncCursor,
} from "../core/events.js";
