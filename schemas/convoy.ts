import { z } from "zod/v4";

/**
 * Convoy configuration for wave scheduling and auto-refresh behavior.
 *
 * - maxTicketsPerWave: caps how many tickets can run concurrently in a single wave.
 *   Lower values for less-capable models; higher for more capable ones.
 * - autoRefresh: when true, `advance_wave` scans for newly-approved tickets and
 *   absorbs them into pending waves or appends new waves.
 */
export const ConvoyConfigSchema = z.object({
  maxTicketsPerWave: z.number().int().min(1).max(50).default(5),
  autoRefresh: z.boolean().default(true),
});

export type ConvoyConfig = z.infer<typeof ConvoyConfigSchema>;
