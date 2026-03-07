import { z } from "zod/v4";

export const EventStatus = z.enum(["success", "error", "denied", "stale"]);
export type EventStatus = z.infer<typeof EventStatus>;

export const EventLog = z.object({
  eventId: z.string(),
  agentId: z.string(),
  sessionId: z.string(),
  tool: z.string(),
  timestamp: z.string().datetime(),
  durationMs: z.number().nonnegative(),
  status: EventStatus,
  repoId: z.string(),
  commitScope: z.string(), // HEAD at time of call
  payloadSizeIn: z.number().int().nonnegative(),
  payloadSizeOut: z.number().int().nonnegative(),
  inputHash: z.string(), // SHA-256
  outputHash: z.string(), // SHA-256
  redactedSummary: z.string().max(200),
  denialReason: z.string().optional(), // set when status=denied
});
export type EventLog = z.infer<typeof EventLog>;
