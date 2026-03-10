export interface DashboardEvent {
  type:
    | "agent_registered"
    | "session_changed"
    | "patch_proposed"
    | "note_added"
    | "event_logged"
    | "index_updated"
    | "knowledge_stored"
    | "ticket_created"
    | "ticket_assigned"
    | "ticket_status_changed"
    | "ticket_commented";
  data: Record<string, unknown>;
}

type DashboardListener = (event: DashboardEvent) => void;

const listeners = new Set<DashboardListener>();

export function subscribeDashboardEvents(listener: DashboardListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishDashboardEvent(event: DashboardEvent): void {
  for (const listener of listeners) {
    listener(event);
  }
}
