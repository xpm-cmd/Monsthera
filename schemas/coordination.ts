import { z } from "zod/v4";

export const MessageType = z.enum([
  "task_claim",
  "task_release",
  "patch_intent",
  "conflict_alert",
  "status_update",
  "broadcast",
]);
export type MessageType = z.infer<typeof MessageType>;

export const CoordinationMessage = z.object({
  id: z.string(),
  from: z.string(), // agent_id
  to: z.string().nullable(), // agent_id or null for broadcast
  type: MessageType,
  payload: z.record(z.string(), z.unknown()),
  timestamp: z.string().datetime(),
});
export type CoordinationMessage = z.infer<typeof CoordinationMessage>;

export const BroadcastInput = z.object({
  message: z.string().min(1).max(2000),
  targetAgents: z.array(z.string()).optional(), // null = all agents
});
export type BroadcastInput = z.infer<typeof BroadcastInput>;
