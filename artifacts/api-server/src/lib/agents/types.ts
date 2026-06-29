/**
 * Agent System Type Definitions
 *
 * Every agent in the system produces an AgentOutput. The coordinator
 * collects all outputs and passes them to the MasterDecisionAgent which
 * makes the final execute / skip / wait decision.
 *
 * Design principles:
 * - Agents are stateless functions — all mutable state lives in external stores
 * - Each agent has exactly ONE responsibility
 * - Agents communicate through a shared ScanContext, not through each other
 * - Every number has a physical meaning (probability, dollars, ticks)
 */

// ── Signal type ───────────────────────────────────────────────────────────────

export type SignalType = "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell";

export function scoreToSignal(score: number): SignalType {
  if (score >= 80) return "strong_buy";
  if (score >= 63) return "buy";
  if (score >= 37) return "neutral";
  if (score >= 20) return "sell";
  return "strong_sell";
}

// ── Agent output ──────────────────────────────────────────────────────────────

export interface AgentOutput {
  agentId: string;
  /** 0–100: quality / favorability of conditions as seen by this agent */
  score: number;
  /** 0–100: how certain is this agent about its own score */
  confidence: number;
  signal: SignalType;
  reasoning: string;
  /** agent-specific structured data for use by downstream agents */
  data: Record<string, unknown>;
  executionTimeMs: number;
}

// ── Market regime ─────────────────────────────────────────────────────────────

export type MarketRegime =
  | "trending_up"
  | "trending_down"
  | "mean_reverting"
  | "choppy"
  | "volatile"
  | "quiet";

// ── Product-specific decision ─────────────────────────────────────────────────

export type ProductType = "RISE" | "FALL" | "DIGITOVER" | "DIGITUNDER" | "DIGITEVEN" | "DIGITODD";

export interface ProductRecommendation {
  product: ProductType;
  barrier?: number;          // only for DIGITOVER / DIGITUNDER
  winProbability: number;    // 0–100 calibrated estimate
  payoutMultiplier: number;  // e.g. 1.87
  expectedValue: number;     // dollars: EV = winProb * payout - stake
  breakevenWinRate: number;  // minimum win% to be profitable
  duration: number;          // ticks or seconds
  stake: number;             // dollars
  reasoning: string;
}

// ── Scan context ──────────────────────────────────────────────────────────────
// Passed to every agent so each can use the same raw data without fetching twice.

export interface TradingSettings {
  maxRiskPerTrade: number;         // % of balance per trade
  minConfidenceThreshold: number;  // minimum confidence to trade
  riskProfile: "conservative" | "moderate" | "aggressive";
  preferredContractTypes: string[];
  tradeDurationSec: number;
  maxTradeStake: number;
  dailyLossLimit: number;
  dailyTarget: number;
  consecutiveLossLimit: number;
  maxDrawdown: number;
  requirePositiveEv: boolean;
  paperTradeMode: boolean;
}

export interface DailyStats {
  tradesCount: number;
  wins: number;
  losses: number;
  profit: number;
  consecutiveLosses: number;
  consecutiveWins: number;
}

export interface ScanContext {
  symbol: string;
  displayName: string;
  category: string;
  prices: number[];      // last N prices from tick buffer
  digits: number[];      // last N last-digits (digit-enabled markets only)
  balance: number;
  settings: TradingSettings;
  daily: DailyStats;
  token: string | null;
  currency: string;
}

// ── Full coordinator output ───────────────────────────────────────────────────

export interface CoordinatorOutput {
  symbol: string;
  displayName: string;
  category: string;

  // Final decision
  shouldTrade: boolean;
  rejectReason?: string;
  recommendation: ProductRecommendation;

  // Regime
  regime: MarketRegime;

  // All agent outputs (keyed by agentId)
  agents: Record<string, AgentOutput>;

  // Summary metrics (for backward compatibility with existing API)
  qualityScore: number;
  confidenceScore: number;
  riskScore: number;
  trend: "strong_up" | "up" | "sideways" | "down" | "strong_down";
  volatility: "low" | "medium" | "high" | "extreme";
  direction: "up" | "down";
  warnings: string[];
  reasoning: string;

  // For UI panels
  digitStats?: import("../deriv").DigitStats;
}
