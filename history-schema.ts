import { z } from "zod";

const totalsSchema = z.object({
  tokens: z.number().finite().nonnegative(),
  costUsd: z.number().finite().nonnegative().nullable(),
  events: z.number().int().nonnegative(),
  estimated: z.boolean().optional(),
  unpricedTokens: z.number().finite().nonnegative().optional(),
});
export const historySchema = z.object({
  status: z.enum(["loading", "ready", "unavailable", "error"]),
  source: z.enum(["local", "cursor"]),
  days: z.array(totalsSchema.extend({ date: z.string() })),
  models: z.array(totalsSchema.extend({ model: z.string() })),
  fetchedAt: z.number().nullable(),
  refreshing: z.boolean(),
  partial: z.boolean(),
  error: z.string().nullable(),
  timeZone: z.string().optional(),
  pricingAsOf: z.number().optional(),
});
