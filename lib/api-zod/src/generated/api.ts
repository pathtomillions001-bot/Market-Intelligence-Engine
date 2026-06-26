import { z } from "zod/v4";

export const ConnectDerivAccountBody = z.object({
  token: z.string(),
});

export const GetMarketsQueryParams = z.object({
  category: z.string().optional(),
  limit: z.coerce.number().optional(),
});

export const ExecuteTradeBody = z.object({
  symbol: z.string(),
  contractType: z.string(),
  stake: z.number(),
  direction: z.enum(["up", "down"]),
  barrier: z.number().nullable().optional(),
  isAutonomous: z.boolean().optional(),
  duration: z.number().optional(),
  durationUnit: z.enum(["t", "s", "m", "h", "d"]).optional(),
});

export const GetTradesQueryParams = z.object({
  status: z.string().optional(),
  market: z.string().optional(),
  limit: z.coerce.number().optional(),
  offset: z.coerce.number().optional(),
});

export const GetTradeParams = z.object({
  id: z.coerce.number(),
});

export const UpdateSettingsBody = z.object({
  riskProfile: z.enum(["conservative", "moderate", "aggressive"]).optional(),
  maxRiskPerTrade: z.coerce.number().optional(),
  dailyTarget: z.coerce.number().optional(),
  dailyLossLimit: z.coerce.number().optional(),
  maxTradeStake: z.coerce.number().optional(),
  minConfidenceThreshold: z.coerce.number().optional(),
  tradeDurationSec: z.coerce.number().optional(),
  paperTradeMode: z.boolean().optional(),
  requirePositiveEv: z.boolean().optional(),
  drawdownProtection: z.boolean().optional(),
  drawdownThreshold: z.coerce.number().optional(),
  consecutiveLossLimit: z.coerce.number().optional(),
  marketRotationAfter: z.coerce.number().optional(),
  loopIntervalSec: z.coerce.number().optional(),
  preferredContractTypes: z.string().optional(),
  allowedMarkets: z.string().optional(),
  recoveryMode: z.boolean().optional(),
  recoveryMultiplier: z.coerce.number().optional(),
  maxRecoverySteps: z.coerce.number().optional(),
});

export const ToggleAutonomousEngineBody = z.object({
  running: z.boolean(),
  preferredContractTypes: z.string().optional(),
});

export const GetPerformanceAnalyticsQueryParams = z.object({
  period: z.string().optional(),
  days: z.coerce.number().optional(),
});

export const HealthCheckResponse = z.object({
  status: z.string(),
});
