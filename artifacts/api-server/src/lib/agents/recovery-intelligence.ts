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

  // Use the authoritative session consecutive-loss count from the daily context.
  // This counts all losses (across all families) since the last win or cooldown,
  // giving every downstream agent accurate loss-streak awareness.
  const sessionLosses = ctx.daily.consecutiveLosses;

  // Score reflects how cautious the AI should be. A loss streak demands that every
  // other agent produces a much stronger signal before the engine takes the next trade.
  // Thresholds are deliberately aggressive:
  //   score < 20 → confidence-fusion hard-blocks the trade entirely
  //   score 20-44 → heavy weight penalty in the fusion sum, typically pushes below threshold
  // At ≥4 consecutive losses the hard-block fires, forcing a full wait for the
  // mandatory consecutive-loss cooldown to activate via the loop-level check.
  const score =
    sessionLosses >= 4 ? 15   // Hard-block: 4 losses → confidence-fusion vetoes trade
    : sessionLosses >= 3 ? 25  // Near-veto: only very high conviction all-agent consensus passes
    : sessionLosses >= 2 ? 40  // Strong caution — tighten gates, demand real edge
    : sessionLosses >= 1 ? 58  // Mild caution — slightly below normal
    : state.consecutiveWins >= 3 ? 82
    : 72;

  const cautionLabel =
    sessionLosses >= 4 ? "HARD STOP (recovery intelligence veto)"
    : sessionLosses >= 3 ? "SEVERE CAUTION"
    : sessionLosses >= 2 ? "ELEVATED CAUTION"
    : sessionLosses >= 1 ? "CAUTION"
    : "NORMAL";

  const reasoning = [
    `Mode: ${cautionLabel}.`,
    `Session consecutive losses: ${sessionLosses}. Consecutive wins: ${state.consecutiveWins}.`,
    `Session P&L: ${state.sessionPnl.toFixed(2)}. Trades: ${state.totalTrades}.`,
    sessionLosses >= 2
      ? `⚠ Raising bar for all agents — require stronger edge to trade (score=${score}).`
      : `Stake: base (no adjustment).`,
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
