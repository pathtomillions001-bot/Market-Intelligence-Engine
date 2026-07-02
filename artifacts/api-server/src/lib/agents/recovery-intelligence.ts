/**
 * Agent 8: Recovery Intelligence Agent
 *
 * RESPONSIBILITY: Track win/loss streaks and session P&L for informational
 * purposes only. The engine always runs in normal mode — no recovery stake
 * adjustments, no mode switching, no cooldown triggers from this agent.
 * Cooldown is handled externally by the consecutive-loss limit in settings.
 */

import type { AgentOutput, ScanContext } from "./types";
import { scoreToSignal } from "./types";

export type RecoveryMode = "normal";

export interface RecoveryState {
  consecutiveLosses: number;
  consecutiveWins: number;
  sessionPnl: number;
  totalTrades: number;
  mode: RecoveryMode;
  recommendedStakeMultiplier: number;
  cooldownUntil: number;
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

  // Always normal mode — no recovery or cooldown triggers from this agent.
  // The engine continues trading normally after any loss.
  recoveryStates.set(key, {
    consecutiveLosses, consecutiveWins,
    sessionPnl, totalTrades,
    mode: "normal",
    recommendedStakeMultiplier: 1.0,
    cooldownUntil: 0,
  });
}

export function runRecoveryIntelligenceAgent(ctx: ScanContext): AgentOutput & { recoveryState: RecoveryState } {
  const t0 = Date.now();
  const state = getRecoveryState(ctx);

  // Score is always positive — engine always in normal trading mode
  const score = state.consecutiveWins >= 3 ? 80 : 70;

  const reasoning = [
    `Mode: NORMAL.`,
    `Consecutive losses: ${state.consecutiveLosses}. Consecutive wins: ${state.consecutiveWins}.`,
    `Session P&L: ${state.sessionPnl.toFixed(2)}. Trades: ${state.totalTrades}.`,
    `Stake: base (no adjustment).`,
  ].join(" ");

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
      stakeMultiplier: 1.0,
      inCooldown: false,
      remainingCooldownSec: 0,
    },
    executionTimeMs: Date.now() - t0,
    recoveryState: state,
  };
}
