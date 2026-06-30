/**
 * Agent 8: Recovery Intelligence Agent
 *
 * RESPONSIBILITY: Detect when the trading engine is in a drawdown and select
 * the most appropriate recovery strategy. Manages stake sizing during recovery,
 * chooses recovery contract types, and enforces a cool-down after consecutive losses.
 */

import type { AgentOutput, ScanContext } from "./types";
import { scoreToSignal } from "./types";

export type RecoveryMode = "normal" | "conservative" | "recovery" | "cooldown";

export interface RecoveryState {
  consecutiveLosses: number;
  consecutiveWins: number;
  sessionPnl: number;
  totalTrades: number;
  mode: RecoveryMode;
  recommendedStakeMultiplier: number;
  cooldownUntil: number;
  recoveryContractSuggestion?: string;
}

// In-memory state per session (resets on server restart)
const recoveryStates = new Map<string, RecoveryState>();

function getKey(ctx: ScanContext): string {
  return `${ctx.symbol}|${ctx.settings.riskProfile}`;
}

export function getRecoveryState(ctx: ScanContext): RecoveryState {
  return recoveryStates.get(getKey(ctx)) ?? {
    consecutiveLosses: 0,
    consecutiveWins: 0,
    sessionPnl: 0,
    totalTrades: 0,
    mode: "normal",
    recommendedStakeMultiplier: 1.0,
    cooldownUntil: 0,
  };
}

export function recordTradeOutcomeRecovery(
  ctx: ScanContext,
  won: boolean,
  profit: number,
): void {
  const key = getKey(ctx);
  const prev = getRecoveryState(ctx);

  const consecutiveLosses = won ? 0 : prev.consecutiveLosses + 1;
  const consecutiveWins = won ? prev.consecutiveWins + 1 : 0;
  const sessionPnl = prev.sessionPnl + profit;
  const totalTrades = prev.totalTrades + 1;

  // Determine mode
  let mode: RecoveryMode = "normal";
  let cooldownUntil = prev.cooldownUntil;
  let recommendedStakeMultiplier = 1.0;

  // Cool-down: 3+ consecutive losses → mandatory pause
  if (consecutiveLosses >= 3) {
    mode = "cooldown";
    cooldownUntil = Date.now() + 60_000; // 60s pause
    recommendedStakeMultiplier = 0.0; // no trading
  } else if (consecutiveLosses >= 2) {
    mode = "recovery";
    recommendedStakeMultiplier = 0.6; // reduce stake
  } else if (consecutiveLosses === 1) {
    mode = "conservative";
    recommendedStakeMultiplier = 0.8;
  } else if (consecutiveWins >= 3) {
    // Winning streak — slight increase (but never above 1.3x to limit ruin risk)
    recommendedStakeMultiplier = Math.min(1.3, 1.0 + consecutiveWins * 0.05);
  }

  // Recovery contract suggestion: prefer safer contracts when in drawdown
  let recoveryContractSuggestion: string | undefined;
  if (mode === "recovery" || mode === "conservative") {
    recoveryContractSuggestion = "DIGITOVER_3"; // tier-1 barrier, safer
  }

  recoveryStates.set(key, {
    consecutiveLosses, consecutiveWins,
    sessionPnl, totalTrades, mode,
    recommendedStakeMultiplier, cooldownUntil,
    recoveryContractSuggestion,
  });
}

export function runRecoveryIntelligenceAgent(ctx: ScanContext): AgentOutput & { recoveryState: RecoveryState } {
  const t0 = Date.now();
  const state = getRecoveryState(ctx);
  const now = Date.now();

  const inCooldown = state.mode === "cooldown" && now < state.cooldownUntil;
  const remainingCooldownSec = inCooldown ? Math.round((state.cooldownUntil - now) / 1000) : 0;

  // Score reflects trading readiness
  let score: number;
  if (inCooldown) {
    score = 0; // blocked
  } else if (state.mode === "recovery") {
    score = 35;
  } else if (state.mode === "conservative") {
    score = 55;
  } else if (state.consecutiveWins >= 3) {
    score = 85;
  } else {
    score = 70;
  }

  const reasoning = [
    `Mode: ${state.mode.toUpperCase()}.`,
    `Consecutive losses: ${state.consecutiveLosses}. Consecutive wins: ${state.consecutiveWins}.`,
    `Session P&L: $${state.sessionPnl.toFixed(2)}. Trades: ${state.totalTrades}.`,
    `Stake multiplier: ×${state.recommendedStakeMultiplier.toFixed(2)}.`,
    inCooldown ? `⛔ COOLDOWN — ${remainingCooldownSec}s remaining.` : "",
    state.recoveryContractSuggestion ? `Preferred contract: ${state.recoveryContractSuggestion}.` : "",
  ].filter(Boolean).join(" ");

  return {
    agentId: "recoveryIntelligence",
    score: Math.max(0, Math.min(95, score)),
    confidence: 90,
    signal: scoreToSignal(score),
    reasoning,
    data: {
      mode: state.mode,
      consecutiveLosses: state.consecutiveLosses,
      consecutiveWins: state.consecutiveWins,
      sessionPnl: state.sessionPnl,
      stakeMultiplier: state.recommendedStakeMultiplier,
      inCooldown,
      remainingCooldownSec,
    },
    executionTimeMs: Date.now() - t0,
    recoveryState: state,
  };
}
