import { useState, useEffect, useRef } from "react";
import { useGetMarketDetail, useExecuteTrade, useGetAiRecommendationForMarket, useGetAiEngineStatus } from "@workspace/api-client-react";
import { useParams, Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { toast } from "sonner";
import { ArrowLeft, TrendingUp, TrendingDown, AlertTriangle, Wifi, WifiOff, Activity, ArrowUp, ArrowDown } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useQueryClient } from "@tanstack/react-query";

function AgentBar({ name, score, weight, signal, reasoning }: { name: string; score: number; weight: number; signal: string; reasoning: string }) {
  const color = score >= 70 ? "bg-green-500" : score >= 50 ? "bg-amber-500" : "bg-red-500";
  const textColor = score >= 70 ? "text-green-500" : score >= 50 ? "text-amber-500" : "text-red-500";
  const sigColor = signal.includes("buy") ? "text-green-500 border-green-500/30" : signal.includes("sell") ? "text-red-500 border-red-500/30" : "text-zinc-400 border-zinc-700";
  return (
    <div className="p-3 rounded-lg border border-border bg-secondary/20">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{name}</span>
        <div className="flex items-center gap-1.5">
          <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${sigColor}`}>{signal.replace(/_/g, " ")}</Badge>
          <span className="text-[10px] text-zinc-600 font-mono">{(weight * 100).toFixed(0)}%</span>
        </div>
      </div>
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`text-lg font-mono font-bold ${textColor}`}>{score.toFixed(0)}</span>
        <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${score}%` }} />
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground leading-relaxed line-clamp-2" title={reasoning}>{reasoning}</p>
    </div>
  );
}

const AGENT_LABELS: Record<string, string> = {
  marketScanner: "Market Scanner", trendAnalysis: "Trend Analysis", volatilityAnalysis: "Volatility Analysis",
  patternRecognition: "Pattern Recognition", riskManagement: "Risk Management", capitalPreservation: "Capital Preservation",
  tradeExecution: "Trade Execution", selfLearning: "Self-Learning Performance",
};

// ── Agent Intelligence Panel ───────────────────────────────────────────────────

const AGENT_META: Record<string, { label: string; icon: string; description: string }> = {
  featureEngineering: { label: "Feature Engineering", icon: "⚙", description: "Extracts multi-horizon price/digit features" },
  marketRegime:       { label: "Market Regime",       icon: "📊", description: "Classifies trend/volatility/regime state" },
  direction:          { label: "Direction Model",     icon: "🧭", description: "ML ensemble: RF + GB directional probability" },
  digitDistribution:  { label: "Digit Distribution",  icon: "🔢", description: "Multinomial + Markov EV-ranked barrier scoring" },
  evCalculator:       { label: "EV Calculator",       icon: "💰", description: "Expected value vs Deriv payout analysis" },
  riskManager:        { label: "Risk Manager",        icon: "🛡", description: "Portfolio risk, drawdown, stake sizing" },
  executionTiming:    { label: "Execution Timing",    icon: "⏱", description: "Entry quality: velocity, momentum, z-score" },
  performanceFeedback:{ label: "Performance Feedback",icon: "📈", description: "Historical win rates and strategy drift" },
  masterDecision:     { label: "Master Decision",     icon: "🎯", description: "Final gate: EV + timing + consensus aggregation" },
  durationOptimizer:  { label: "Duration Optimizer",  icon: "⌛", description: "Optimal tick duration: volatility + regime + Hurst" },
};

const AGENT_ORDER = [
  "featureEngineering", "marketRegime", "direction", "digitDistribution",
  "evCalculator", "riskManager", "executionTiming", "performanceFeedback",
  "durationOptimizer", "masterDecision",
];

function AgentSignalBadge({ signal }: { signal: string }) {
  const map: Record<string, string> = {
    strong_buy: "bg-green-500/15 text-green-400 border-green-500/30",
    buy: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    neutral: "bg-zinc-500/15 text-zinc-400 border-zinc-600/30",
    sell: "bg-red-500/15 text-red-400 border-red-500/30",
    strong_sell: "bg-rose-500/15 text-rose-500 border-rose-500/30",
  };
  const label: Record<string, string> = {
    strong_buy: "STRONG BUY", buy: "BUY", neutral: "NEUTRAL", sell: "SELL", strong_sell: "STRONG SELL",
  };
  return (
    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${map[signal] ?? map["neutral"]}`}>
      {label[signal] ?? signal.toUpperCase()}
    </span>
  );
}

function AgentScoreRing({ score }: { score: number }) {
  const color = score >= 70 ? "#22c55e" : score >= 50 ? "#f59e0b" : "#ef4444";
  const r = 12, circ = 2 * Math.PI * r;
  const fill = (score / 100) * circ;
  return (
    <svg width="32" height="32" className="shrink-0">
      <circle cx="16" cy="16" r={r} fill="none" stroke="hsl(var(--secondary))" strokeWidth="3" />
      <circle cx="16" cy="16" r={r} fill="none" stroke={color} strokeWidth="3"
        strokeDasharray={`${fill} ${circ}`} strokeLinecap="round"
        transform="rotate(-90 16 16)" />
      <text x="16" y="20" textAnchor="middle" fontSize="8" fontWeight="bold" fill={color}>{score}</text>
    </svg>
  );
}

function AgentIntelligencePanel({ agentOutputs, recommendation }: { agentOutputs: any; recommendation: any }) {
  if (!agentOutputs || Object.keys(agentOutputs).length === 0) {
    return (
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity className="w-4 h-4 text-primary" />
            Agent Intelligence Panel
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-xs text-muted-foreground text-center py-4">
            Loading agent analysis... (refresh in a moment)
          </div>
        </CardContent>
      </Card>
    );
  }

  const masterAgent = agentOutputs["masterDecision"];
  const shouldTrade = masterAgent?.data?.shouldTrade ?? false;
  const rejectReasons: string[] = masterAgent?.data?.rejectReasons ?? [];
  const weightedScore = masterAgent?.data?.weightedScore ?? 0;
  const qualityScore = masterAgent?.data?.qualityScore ?? 0;
  const optimizedDuration = masterAgent?.data?.optimizedDuration ?? recommendation?.recommendedDuration ?? 5;

  const orderedAgents = AGENT_ORDER.filter((k) => agentOutputs[k]);

  return (
    <Card className="bg-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity className="w-4 h-4 text-primary" />
            Agent Intelligence Panel
            <span className="ml-1 w-2 h-2 rounded-full bg-green-500 animate-pulse" title="Live" />
          </CardTitle>
          <div className="flex items-center gap-2">
            <div className={`text-[10px] font-bold px-2 py-1 rounded-full border ${
              shouldTrade
                ? "bg-green-500/15 text-green-400 border-green-500/30"
                : "bg-amber-500/10 text-amber-400 border-amber-500/30"
            }`}>
              {shouldTrade ? "✓ TRADE" : "⏸ WAIT"}
            </div>
            <div className="text-[10px] font-mono text-muted-foreground">
              Q:{qualityScore} · {optimizedDuration}t
            </div>
          </div>
        </div>

        {/* Master summary row */}
        <div className="mt-2 grid grid-cols-3 gap-2">
          <div className="text-center p-2 rounded-lg bg-secondary/30 border border-border">
            <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-0.5">Consensus</div>
            <div className={`text-base font-mono font-bold ${weightedScore >= 60 ? "text-green-400" : weightedScore >= 45 ? "text-amber-400" : "text-red-400"}`}>{weightedScore.toFixed(0)}<span className="text-xs text-muted-foreground">/100</span></div>
          </div>
          <div className="text-center p-2 rounded-lg bg-secondary/30 border border-border">
            <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-0.5">Duration</div>
            <div className="text-base font-mono font-bold text-primary">{optimizedDuration}<span className="text-xs text-muted-foreground"> ticks</span></div>
          </div>
          <div className="text-center p-2 rounded-lg bg-secondary/30 border border-border">
            <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-0.5">Agents</div>
            <div className="text-base font-mono font-bold">{orderedAgents.length}<span className="text-xs text-muted-foreground"> active</span></div>
          </div>
        </div>

        {/* Reject reasons */}
        {rejectReasons.length > 0 && (
          <div className="mt-2 space-y-1">
            {rejectReasons.map((r, i) => (
              <div key={i} className="flex items-start gap-1.5 px-2 py-1.5 rounded bg-amber-500/5 border border-amber-500/15 text-[10px] text-amber-400">
                <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                <span>{r}</span>
              </div>
            ))}
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-1.5 pt-0">
        {orderedAgents.map((key) => {
          const agent = agentOutputs[key];
          const meta = AGENT_META[key] ?? { label: key, icon: "◈", description: "" };
          const isLast = key === "masterDecision";
          return (
            <div key={key}
              className={`flex items-start gap-3 p-2.5 rounded-lg border transition-colors ${
                isLast
                  ? "border-primary/30 bg-primary/5"
                  : agent.score >= 70
                    ? "border-green-500/15 bg-secondary/20"
                    : agent.score >= 50
                      ? "border-border bg-secondary/10"
                      : "border-red-500/15 bg-red-500/5"
              }`}
            >
              {/* Score ring */}
              <AgentScoreRing score={agent.score ?? 0} />

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                  <span className="text-[10px] font-bold text-foreground">{meta.icon} {meta.label}</span>
                  <AgentSignalBadge signal={agent.signal ?? "neutral"} />
                  {agent.confidence != null && (
                    <span className="text-[9px] text-muted-foreground font-mono">
                      conf:{agent.confidence}%
                    </span>
                  )}
                  {agent.executionTimeMs != null && agent.executionTimeMs > 0 && (
                    <span className="text-[9px] text-zinc-600 font-mono ml-auto">{agent.executionTimeMs}ms</span>
                  )}
                </div>
                <p className="text-[10px] text-muted-foreground leading-relaxed line-clamp-2" title={agent.reasoning}>
                  {agent.reasoning || meta.description}
                </p>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// ── AI Trade Panel ────────────────────────────────────────────────────────────
// Unified recommendation panel synced to all 3 contract types + agent intelligence

function TierBadge({ tier, inRecovery }: { tier: 1 | 2 | 0; inRecovery: boolean }) {
  if (tier === 1) return <span className="text-[8px] font-bold px-1.5 py-0.5 rounded bg-green-500/15 text-green-400 border border-green-500/20">SAFE</span>;
  if (tier === 2) return <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded border ${inRecovery ? "bg-amber-500/20 text-amber-400 border-amber-500/30" : "bg-secondary/40 text-zinc-500 border-zinc-700"}`}>RECOVERY</span>;
  return <span className="text-[8px] font-bold px-1.5 py-0.5 rounded bg-red-500/10 text-red-500 border border-red-500/20">RISKY</span>;
}

function DigitBarrierButton({
  option, isRecommended, inRecovery, onClick,
}: {
  option: { contractType: string; barrier: number; winProbability: number; expectedValue: number; payout: number; tier: number };
  isRecommended: boolean;
  inRecovery: boolean;
  onClick: () => void;
}) {
  const label = option.contractType === "DIGITOVER" ? `OVER ${option.barrier}` : `UNDER ${option.barrier}`;
  const winPct = Math.round(option.winProbability * 100);
  const evPct = (option.expectedValue * 100).toFixed(1);
  const hasEdge = option.expectedValue > 0;
  const tier = option.tier as 1 | 2 | 0;

  return (
    <button onClick={onClick}
      className={`relative flex flex-col items-center p-2 rounded-lg border text-center transition-all hover:scale-[1.03] active:scale-[0.98] ${
        isRecommended
          ? "border-primary/60 bg-primary/10 shadow-sm shadow-primary/20"
          : tier === 1 && !inRecovery
            ? "border-green-500/25 bg-green-500/5 hover:border-green-500/40"
            : tier === 2 && inRecovery
              ? "border-amber-500/30 bg-amber-500/8 hover:border-amber-500/50"
              : "border-border bg-secondary/15 hover:border-muted-foreground/25"
      }`}
    >
      {isRecommended && <span className="absolute -top-1.5 left-1/2 -translate-x-1/2 text-[7px] font-bold text-primary bg-card px-1.5 rounded-full border border-primary/30">AI ★</span>}
      <div className="text-[9px] font-mono font-bold text-muted-foreground">{label}</div>
      <div className={`text-sm font-mono font-bold mt-0.5 ${hasEdge ? "text-green-400" : "text-amber-400"}`}>{winPct}%</div>
      <div className={`text-[8px] font-mono mt-0.5 ${hasEdge ? "text-green-500/70" : "text-zinc-600"}`}>{hasEdge ? `+${evPct}%` : `${evPct}%`}</div>
      <div className="mt-1"><TierBadge tier={tier} inRecovery={inRecovery} /></div>
    </button>
  );
}

function AITradePanel({
  rec, recommendation, trendStats, digitStats, isDigitMarket, openTradeDialog,
}: {
  rec: any; recommendation: any; trendStats: any; digitStats: any;
  isDigitMarket: boolean;
  openTradeDialog: (ct: string, dir: "up" | "down", barrier?: number, duration?: number) => void;
}) {
  if (!recommendation) return null;

  // ── Extract all agent data ───────────────────────────────────────────────
  const agentOutputs = rec?.agentOutputs ?? {};
  const masterAgent = agentOutputs["masterDecision"];
  const dirAgent = agentOutputs["direction"];
  const digitAgentOutput = agentOutputs["digitDistribution"];
  const durationOpt = agentOutputs["durationOptimizer"];

  const shouldTrade = rec?.shouldTrade ?? recommendation?.shouldTrade ?? false;
  const regime = (rec?.regime ?? "unknown").replace(/_/g, " ");
  const qualityScore = rec?.qualityScore ?? recommendation?.qualityScore ?? 0;
  const recommendedDuration = durationOpt?.data?.duration ?? rec?.recommendedDuration ?? 5;
  const recommendedStake = recommendation?.stake ?? 1;

  const bestProduct: string = rec?.recommendedContractType ?? recommendation?.contractType ?? "RISE";
  const winProbability: number = rec?.winProbability ?? recommendation?.winProbability ?? 50;
  const expectedValue: number = rec?.expectedValue ?? 0;
  const payoutMultiplier: number = rec?.payoutMultiplier ?? 1.91;
  const bestBarrier: number | undefined = rec?.digitBarrier ?? recommendation?.digitBarrier;

  // Direction win probs from trendStats or direction agent
  const probUp: number = dirAgent?.data?.probUp ?? 0.5;
  const riseProb = trendStats?.winProb?.rise ?? Math.round(probUp * 100);
  const fallProb = trendStats?.winProb?.fall ?? Math.round((1 - probUp) * 100);
  const callProb = trendStats?.winProb?.call ?? riseProb;
  const putProb  = trendStats?.winProb?.put  ?? fallProb;

  // Digit tier data
  const inRecovery: boolean = digitAgentOutput?.data?.inRecovery ?? false;
  const unrecoveredLoss: number = digitAgentOutput?.data?.unrecoveredLoss ?? 0;
  const tier1Options: any[] = digitAgentOutput?.data?.tier1Options ?? [];
  const tier2Options: any[] = digitAgentOutput?.data?.tier2Options ?? [];

  // Active tier for highlighting
  const activeTier = inRecovery ? 2 : 1;
  const activeOptions = inRecovery ? tier2Options : tier1Options;

  // Best digit option (already tier-filtered by agent)
  const bestDigitOption = digitAgentOutput?.data?.bestOption ?? null;
  const isDigitBest = bestProduct?.startsWith("DIGIT");

  // Helper: is this the AI-recommended direction?
  function isRecDir(ct: string) {
    if (isDigitBest) return false;
    return rec?.recommendedContractType === ct || recommendation?.contractType === ct;
  }

  // EV formatting
  const evLabel = expectedValue > 0 ? `+$${expectedValue.toFixed(2)}` : expectedValue < 0 ? `-$${Math.abs(expectedValue).toFixed(2)}` : "$0.00";
  const evColor = expectedValue > 0 ? "text-green-400" : expectedValue < -0.01 ? "text-red-400" : "text-amber-400";

  // Best trade label
  function bestTradeLabel(): string {
    if (isDigitBest && bestBarrier !== undefined) {
      return `${bestProduct.replace("DIGIT", "")} ${bestBarrier}`;
    }
    return bestProduct;
  }

  const directionMap: Record<string, "up" | "down"> = {
    RISE: "up", CALL: "up", FALL: "down", PUT: "down",
    DIGITOVER: "up", DIGITUNDER: "down",
  };

  return (
    <Card className="bg-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity className="w-4 h-4 text-primary" />
            AI Trade Intelligence
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          </CardTitle>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${shouldTrade ? "bg-green-500/15 text-green-400 border-green-500/30" : "bg-amber-500/10 text-amber-400 border-amber-500/30"}`}>
              {shouldTrade ? "✓ TRADE" : "⏸ WAIT"}
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-secondary/40 border border-border text-muted-foreground capitalize">{regime}</span>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-secondary/40 border border-border">Q:{qualityScore}</span>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-primary/10 border border-primary/20 text-primary font-bold">{recommendedDuration}t</span>
          </div>
        </div>

        {/* Recovery mode banner */}
        {inRecovery && (
          <div className="mt-2 flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/8 border border-amber-500/25 text-xs text-amber-400">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span><span className="font-bold">Recovery Mode Active</span> — ${unrecoveredLoss.toFixed(2)} to recover · Using Tier 2 barriers (OVER 4-6 / UNDER 4-6) for higher payout</span>
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-4 pt-0">

        {/* ── HERO: Best AI recommendation ──────────────────────────────── */}
        <div className={`rounded-xl border p-4 ${shouldTrade ? "border-primary/30 bg-gradient-to-br from-primary/8 to-primary/3" : "border-border bg-secondary/20"}`}>
          <div className="flex items-start justify-between mb-3">
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold mb-1">AI Best Trade</div>
              <div className={`text-2xl font-mono font-bold ${shouldTrade ? "text-foreground" : "text-muted-foreground"}`}>{bestTradeLabel()}</div>
              <div className="text-[10px] text-muted-foreground mt-0.5">{bestProduct.includes("DIGIT") ? "Digit Over/Under" : bestProduct.includes("RISE") || bestProduct.includes("FALL") ? "Rise & Fall" : "Call & Put"}</div>
            </div>
            <div className="text-right">
              <div className="text-[10px] text-muted-foreground mb-0.5">Win Prob</div>
              <div className={`text-3xl font-mono font-bold ${winProbability >= 60 ? "text-green-400" : winProbability >= 52 ? "text-amber-400" : "text-red-400"}`}>{winProbability.toFixed(0)}%</div>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 mb-3">
            <div className="text-center">
              <div className="text-[9px] text-muted-foreground">EV</div>
              <div className={`text-sm font-mono font-bold ${evColor}`}>{evLabel}</div>
            </div>
            <div className="text-center">
              <div className="text-[9px] text-muted-foreground">Payout</div>
              <div className="text-sm font-mono font-bold">{payoutMultiplier.toFixed(2)}x</div>
            </div>
            <div className="text-center">
              <div className="text-[9px] text-muted-foreground">Stake</div>
              <div className="text-sm font-mono font-bold text-primary">${recommendedStake.toFixed(2)}</div>
            </div>
          </div>
          <button
            onClick={() => openTradeDialog(
              bestProduct,
              directionMap[bestProduct] ?? "up",
              bestBarrier,
              recommendedDuration,
            )}
            disabled={!shouldTrade}
            className={`w-full py-2.5 rounded-lg font-mono font-bold text-sm transition-all ${
              shouldTrade
                ? "bg-primary text-primary-foreground hover:bg-primary/90 active:scale-[0.98]"
                : "bg-secondary/40 text-muted-foreground cursor-not-allowed"
            }`}
          >
            {shouldTrade
              ? `▶ Execute ${bestTradeLabel()} · ${recommendedDuration} ticks · $${recommendedStake.toFixed(2)}`
              : `⏸ ${masterAgent?.data?.rejectReasons?.[0] ?? "Waiting for better setup..."}`}
          </button>
        </div>

        {/* ── Rise / Fall + Call / Put ──────────────────────────────────── */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">Direction Contracts</div>
          <div className="grid grid-cols-4 gap-1.5">
            {([
              { ct: "RISE", dir: "up" as const, label: "▲ RISE", prob: riseProb, color: "text-green-400" },
              { ct: "FALL", dir: "down" as const, label: "▼ FALL", prob: fallProb, color: "text-red-400" },
              { ct: "CALL", dir: "up" as const, label: "↑ CALL", prob: callProb, color: "text-emerald-400" },
              { ct: "PUT",  dir: "down" as const, label: "↓ PUT",  prob: putProb,  color: "text-rose-400" },
            ]).map(({ ct, dir, label, prob, color }) => {
              const isRec = isRecDir(ct);
              const p = typeof prob === "number" ? Math.round(prob) : 50;
              return (
                <button key={ct}
                  onClick={() => openTradeDialog(ct, dir, undefined, recommendedDuration)}
                  className={`flex flex-col items-center p-2.5 rounded-lg border text-center transition-all hover:scale-[1.03] active:scale-[0.97] ${
                    isRec
                      ? "border-primary/50 bg-primary/10 shadow-sm"
                      : "border-border bg-secondary/20 hover:border-muted-foreground/30"
                  }`}
                >
                  {isRec && <div className="text-[7px] font-bold text-primary mb-0.5">AI ★</div>}
                  <div className={`text-xs font-mono font-bold ${color}`}>{label}</div>
                  <div className={`text-base font-mono font-bold mt-0.5 ${p >= 55 ? "text-green-400" : p >= 48 ? "text-amber-400" : "text-red-400"}`}>{p}%</div>
                  <div className="text-[9px] text-muted-foreground">{recommendedDuration}t · ${recommendedStake.toFixed(2)}</div>
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Over/Under Digit Contracts ────────────────────────────────── */}
        {isDigitMarket && (
          <div>
            {/* Tier 1 — Safe (always shown, dimmed if in recovery) */}
            <div className="mb-2">
              <div className="flex items-center gap-2 mb-1.5">
                <div className={`text-[10px] uppercase tracking-wider font-semibold ${!inRecovery ? "text-green-400" : "text-zinc-500"}`}>
                  Tier 1 — Safe {!inRecovery ? "(Active)" : "(Suspended — recovering)"}
                </div>
                <TierBadge tier={1} inRecovery={false} />
              </div>
              <div className="grid grid-cols-6 gap-1">
                {/* OVER 1, 2, 3 */}
                {[1, 2, 3].map((b) => {
                  const opt = tier1Options.find((o: any) => o.contractType === "DIGITOVER" && o.barrier === b);
                  if (!opt) {
                    const distPct = digitStats ? Math.round(digitStats.distribution?.find((d: any) => d.digit === b)?.pct ?? 0) : 0;
                    const winPct = [80, 70, 60][b - 1] ?? 60;
                    return (
                      <button key={`o${b}`}
                        onClick={() => !inRecovery && openTradeDialog("DIGITOVER", "up", b, recommendedDuration)}
                        className={`flex flex-col items-center p-1.5 rounded-lg border text-center transition-all ${!inRecovery ? "hover:scale-[1.03] border-green-500/20 bg-green-500/5 hover:border-green-500/35" : "border-zinc-800 bg-zinc-900/20 opacity-40"}`}
                      >
                        <div className="text-[8px] text-muted-foreground font-mono">OVER {b}</div>
                        <div className="text-xs font-mono font-bold text-green-400">{winPct}%</div>
                      </button>
                    );
                  }
                  const isRec = isDigitBest && bestProduct === "DIGITOVER" && bestBarrier === b;
                  return (
                    <DigitBarrierButton key={`o${b}`} option={opt} isRecommended={isRec && !inRecovery}
                      inRecovery={false} onClick={() => !inRecovery && openTradeDialog("DIGITOVER", "up", b, recommendedDuration)} />
                  );
                })}
                {/* UNDER 7, 8, 9 */}
                {[7, 8, 9].map((b) => {
                  const opt = tier1Options.find((o: any) => o.contractType === "DIGITUNDER" && o.barrier === b);
                  if (!opt) {
                    const winPct = [70, 80, 90][b - 7] ?? 70;
                    return (
                      <button key={`u${b}`}
                        onClick={() => !inRecovery && openTradeDialog("DIGITUNDER", "down", b, recommendedDuration)}
                        className={`flex flex-col items-center p-1.5 rounded-lg border text-center transition-all ${!inRecovery ? "hover:scale-[1.03] border-green-500/20 bg-green-500/5 hover:border-green-500/35" : "border-zinc-800 bg-zinc-900/20 opacity-40"}`}
                      >
                        <div className="text-[8px] text-muted-foreground font-mono">UNDER {b}</div>
                        <div className="text-xs font-mono font-bold text-green-400">{winPct}%</div>
                      </button>
                    );
                  }
                  const isRec = isDigitBest && bestProduct === "DIGITUNDER" && bestBarrier === b;
                  return (
                    <DigitBarrierButton key={`u${b}`} option={opt} isRecommended={isRec && !inRecovery}
                      inRecovery={false} onClick={() => !inRecovery && openTradeDialog("DIGITUNDER", "down", b, recommendedDuration)} />
                  );
                })}
              </div>
            </div>

            {/* Tier 2 — Recovery */}
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <div className={`text-[10px] uppercase tracking-wider font-semibold ${inRecovery ? "text-amber-400" : "text-zinc-500"}`}>
                  Tier 2 — Recovery {inRecovery ? "(Active)" : "(Standby)"}
                </div>
                <TierBadge tier={2} inRecovery={inRecovery} />
                {inRecovery && <span className="text-[9px] text-amber-400 font-mono">−${unrecoveredLoss.toFixed(2)} to recover</span>}
              </div>
              <div className="grid grid-cols-6 gap-1">
                {/* OVER 4, 5, 6 */}
                {[4, 5, 6].map((b) => {
                  const opt = tier2Options.find((o: any) => o.contractType === "DIGITOVER" && o.barrier === b);
                  if (!opt) {
                    const winPct = [50, 40, 30][b - 4] ?? 40;
                    return (
                      <button key={`o${b}`}
                        onClick={() => inRecovery && openTradeDialog("DIGITOVER", "up", b, recommendedDuration)}
                        className={`flex flex-col items-center p-1.5 rounded-lg border text-center transition-all ${inRecovery ? "hover:scale-[1.03] border-amber-500/30 bg-amber-500/8 hover:border-amber-500/50" : "border-zinc-800 bg-zinc-900/20 opacity-35"}`}
                      >
                        <div className="text-[8px] text-muted-foreground font-mono">OVER {b}</div>
                        <div className={`text-xs font-mono font-bold ${inRecovery ? "text-amber-400" : "text-zinc-600"}`}>{winPct}%</div>
                      </button>
                    );
                  }
                  const isRec = isDigitBest && bestProduct === "DIGITOVER" && bestBarrier === b;
                  return (
                    <DigitBarrierButton key={`o${b}`} option={opt} isRecommended={isRec && inRecovery}
                      inRecovery={inRecovery} onClick={() => inRecovery && openTradeDialog("DIGITOVER", "up", b, recommendedDuration)} />
                  );
                })}
                {/* UNDER 4, 5, 6 */}
                {[4, 5, 6].map((b) => {
                  const opt = tier2Options.find((o: any) => o.contractType === "DIGITUNDER" && o.barrier === b);
                  if (!opt) {
                    const winPct = [40, 50, 60][b - 4] ?? 50;
                    return (
                      <button key={`u${b}`}
                        onClick={() => inRecovery && openTradeDialog("DIGITUNDER", "down", b, recommendedDuration)}
                        className={`flex flex-col items-center p-1.5 rounded-lg border text-center transition-all ${inRecovery ? "hover:scale-[1.03] border-amber-500/30 bg-amber-500/8 hover:border-amber-500/50" : "border-zinc-800 bg-zinc-900/20 opacity-35"}`}
                      >
                        <div className="text-[8px] text-muted-foreground font-mono">UNDER {b}</div>
                        <div className={`text-xs font-mono font-bold ${inRecovery ? "text-amber-400" : "text-zinc-600"}`}>{winPct}%</div>
                      </button>
                    );
                  }
                  const isRec = isDigitBest && bestProduct === "DIGITUNDER" && bestBarrier === b;
                  return (
                    <DigitBarrierButton key={`u${b}`} option={opt} isRecommended={isRec && inRecovery}
                      inRecovery={inRecovery} onClick={() => inRecovery && openTradeDialog("DIGITUNDER", "down", b, recommendedDuration)} />
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ── Warnings ────────────────────────────────────────────────────── */}
        {recommendation.warnings && recommendation.warnings.length > 0 && (
          <div className="space-y-1">
            {recommendation.warnings.map((w: string, i: number) => (
              <div key={i} className="flex items-center gap-2 p-2 bg-amber-500/5 border border-amber-500/15 rounded text-[10px] text-amber-400">
                <AlertTriangle className="w-3 h-3 shrink-0" />{w}
              </div>
            ))}
          </div>
        )}

        {/* ── AI reasoning ─────────────────────────────────────────────────── */}
        {recommendation.reasoning && (
          <p className="text-[10px] text-muted-foreground leading-relaxed border-t border-border pt-2">
            {recommendation.reasoning}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Digit distribution bar ─────────────────────────────────────────────────────
function DigitBar({ digit, count, pct, hot, cold, barrier, contractType }: {
  digit: number; count: number; pct: number; hot: boolean; cold: boolean; barrier?: number; contractType?: string;
}) {
  const isOver = contractType?.includes("OVER");
  const isUnder = contractType?.includes("UNDER");
  const highlighted = (isOver && digit > (barrier ?? 5)) || (isUnder && digit < (barrier ?? 5));
  const bgColor = highlighted ? "bg-primary" : hot ? "bg-amber-500" : cold ? "bg-red-500/60" : "bg-secondary";

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="text-[10px] font-mono text-muted-foreground">{pct}%</div>
      <div className="w-full flex flex-col items-center justify-end" style={{ height: "48px" }}>
        <div className={`w-full rounded-sm transition-all duration-300 ${bgColor}`} style={{ height: `${Math.max(4, pct * 2)}px` }} />
      </div>
      <div className={`text-xs font-mono font-bold ${highlighted ? "text-primary" : hot ? "text-amber-400" : "text-muted-foreground"}`}>{digit}</div>
    </div>
  );
}

// ── Rise/Fall trend analysis panel ────────────────────────────────────────────
function RiseFallPanel({ trendStats, onTrade }: { trendStats: any; onTrade: (type: string, dir: "up" | "down") => void }) {
  if (!trendStats) return null;
  const { direction, strength, winProb, streak, streakDir, momentum, samples } = trendStats;
  const isRising = direction === "up";
  const isStrong = strength > 60;
  const risingPct = winProb?.rise ?? 50;
  const fallingPct = winProb?.fall ?? 50;

  return (
    <Card className="bg-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-indigo-400" />
          Rise & Fall Analysis
          {samples > 0 && <span className="text-[10px] text-muted-foreground font-normal">({samples} ticks)</span>}
          <span className="ml-auto w-2 h-2 rounded-full bg-green-500 animate-pulse" title="Live" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Main direction indicators */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onTrade("RISE", "up")}
            className={`flex flex-col items-center p-4 rounded-xl border-2 transition-all hover:scale-[1.02] active:scale-100 cursor-pointer ${isRising && isStrong ? "border-green-500/60 bg-green-500/10" : "border-border bg-secondary/30 hover:border-green-500/30"}`}
          >
            <ArrowUp className={`w-6 h-6 mb-1.5 ${isRising && isStrong ? "text-green-400" : "text-muted-foreground"}`} />
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">RISE</div>
            <div className={`text-2xl font-mono font-bold mt-1 ${isRising ? "text-green-400" : "text-foreground"}`}>{risingPct.toFixed(0)}%</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">win probability</div>
            {isRising && isStrong && <Badge className="mt-2 text-[9px] bg-green-500/20 text-green-400 border-green-500/30">AI Favours</Badge>}
          </button>
          <button
            onClick={() => onTrade("FALL", "down")}
            className={`flex flex-col items-center p-4 rounded-xl border-2 transition-all hover:scale-[1.02] active:scale-100 cursor-pointer ${!isRising && isStrong ? "border-red-500/60 bg-red-500/10" : "border-border bg-secondary/30 hover:border-red-500/30"}`}
          >
            <ArrowDown className={`w-6 h-6 mb-1.5 ${!isRising && isStrong ? "text-red-400" : "text-muted-foreground"}`} />
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">FALL</div>
            <div className={`text-2xl font-mono font-bold mt-1 ${!isRising ? "text-red-400" : "text-foreground"}`}>{fallingPct.toFixed(0)}%</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">win probability</div>
            {!isRising && isStrong && <Badge className="mt-2 text-[9px] bg-red-500/20 text-red-400 border-red-500/30">AI Favours</Badge>}
          </button>
        </div>

        {/* Trend stats row */}
        <div className="grid grid-cols-3 gap-2">
          <div className="text-center p-2 rounded-lg bg-secondary/30">
            <div className="text-[10px] text-muted-foreground">Strength</div>
            <div className={`text-base font-mono font-bold ${strength > 60 ? "text-green-400" : strength > 40 ? "text-amber-400" : "text-red-400"}`}>{strength.toFixed(0)}%</div>
          </div>
          <div className="text-center p-2 rounded-lg bg-secondary/30">
            <div className="text-[10px] text-muted-foreground">Momentum</div>
            <div className={`text-base font-mono font-bold ${momentum > 0 ? "text-green-400" : "text-red-400"}`}>{momentum > 0 ? "+" : ""}{(momentum * 100).toFixed(2)}</div>
          </div>
          <div className="text-center p-2 rounded-lg bg-secondary/30">
            <div className="text-[10px] text-muted-foreground">Streak</div>
            <div className={`text-base font-mono font-bold ${streakDir === "up" ? "text-green-400" : "text-red-400"}`}>{streak > 0 ? `${streak} ${streakDir === "up" ? "↑" : "↓"}` : "—"}</div>
          </div>
        </div>

        <div className="p-2 rounded-lg bg-secondary/20 border border-border text-xs text-muted-foreground">
          <span className="text-foreground font-medium">Signal: </span>
          {isRising
            ? `📈 Upward momentum detected (${strength.toFixed(0)}% strength) — RISE favoured`
            : `📉 Downward momentum detected (${strength.toFixed(0)}% strength) — FALL favoured`}
          {streak >= 3 && <span className="ml-2 text-amber-400">· {streak}-tick {streakDir === "up" ? "↑" : "↓"} streak</span>}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Even / Odd analysis panel ──────────────────────────────────────────────────
function EvenOddPanel({ digitStats, onTrade }: { digitStats: any; onTrade: (type: string, dir: "up" | "down") => void }) {
  if (!digitStats) return null;
  const EVEN = [0, 2, 4, 6, 8];
  const dist: { digit: number; pct: number }[] = digitStats.distribution ?? [];
  const evenPct = dist.filter((d) => EVEN.includes(d.digit)).reduce((s, d) => s + d.pct, 0);
  const oddPct = dist.filter((d) => !EVEN.includes(d.digit)).reduce((s, d) => s + d.pct, 0);
  const isEvenHot = evenPct > 55;
  const isOddHot = oddPct > 55;
  const isEvenCold = evenPct < 45;
  const isOddCold = oddPct < 45;
  const samples = digitStats.samples ?? 0;

  return (
    <Card className="bg-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <span className="text-base leading-none">⚡</span>
          Even &amp; Odd Analysis
          {samples > 0 && <span className="text-[10px] text-muted-foreground font-normal">({samples} ticks)</span>}
          <span className="ml-auto w-2 h-2 rounded-full bg-green-500 animate-pulse" title="Live" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onTrade("DIGITEVEN", "up")}
            className={`flex flex-col items-center p-4 rounded-xl border-2 transition-all hover:scale-[1.02] active:scale-100 cursor-pointer ${isEvenHot ? "border-cyan-500/60 bg-cyan-500/10" : "border-border bg-secondary/30 hover:border-cyan-500/30"}`}
          >
            <span className={`text-2xl font-bold mb-1 ${isEvenHot ? "text-cyan-400" : "text-muted-foreground"}`}>2</span>
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">EVEN</div>
            <div className={`text-2xl font-mono font-bold mt-1 ${isEvenHot ? "text-cyan-400" : isEvenCold ? "text-red-400" : "text-foreground"}`}>{evenPct.toFixed(1)}%</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">0, 2, 4, 6, 8</div>
            {isEvenHot && <Badge className="mt-2 text-[9px] bg-cyan-500/20 text-cyan-400 border-cyan-500/30">HOT</Badge>}
          </button>
          <button
            onClick={() => onTrade("DIGITODD", "up")}
            className={`flex flex-col items-center p-4 rounded-xl border-2 transition-all hover:scale-[1.02] active:scale-100 cursor-pointer ${isOddHot ? "border-violet-500/60 bg-violet-500/10" : "border-border bg-secondary/30 hover:border-violet-500/30"}`}
          >
            <span className={`text-2xl font-bold mb-1 ${isOddHot ? "text-violet-400" : "text-muted-foreground"}`}>1</span>
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">ODD</div>
            <div className={`text-2xl font-mono font-bold mt-1 ${isOddHot ? "text-violet-400" : isOddCold ? "text-red-400" : "text-foreground"}`}>{oddPct.toFixed(1)}%</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">1, 3, 5, 7, 9</div>
            {isOddHot && <Badge className="mt-2 text-[9px] bg-violet-500/20 text-violet-400 border-violet-500/30">HOT</Badge>}
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className={`text-center p-2 rounded-lg border ${isEvenHot ? "bg-cyan-500/10 border-cyan-500/30" : "bg-secondary/30 border-border"}`}>
            <div className="text-[10px] text-muted-foreground">EVEN (last {samples} ticks)</div>
            <div className="text-base font-mono font-bold">{evenPct.toFixed(1)}%</div>
            <div className="text-[10px] text-muted-foreground">expected 50%</div>
          </div>
          <div className={`text-center p-2 rounded-lg border ${isOddHot ? "bg-violet-500/10 border-violet-500/30" : "bg-secondary/30 border-border"}`}>
            <div className="text-[10px] text-muted-foreground">ODD (last {samples} ticks)</div>
            <div className="text-base font-mono font-bold">{oddPct.toFixed(1)}%</div>
            <div className="text-[10px] text-muted-foreground">expected 50%</div>
          </div>
        </div>

        <div className="p-2 rounded-lg bg-secondary/20 border border-border text-xs text-muted-foreground">
          <span className="text-foreground font-medium">Signal: </span>
          {isEvenHot
            ? `⚡ Even digits dominant (${evenPct.toFixed(1)}%) — EVEN trade favoured`
            : isOddHot
            ? `⚡ Odd digits dominant (${oddPct.toFixed(1)}%) — ODD trade favoured`
            : "⚖ Balanced — even and odd near 50%"}
        </div>
      </CardContent>
    </Card>
  );
}

export default function MarketDetail() {
  const { symbol } = useParams();
  const queryClient = useQueryClient();
  const [tradeDialog, setTradeDialog] = useState(false);
  const [tradeDir, setTradeDir] = useState<"up" | "down">("up");
  const [tradeContract, setTradeContract] = useState("");
  const [stake, setStake] = useState("");
  const [tradeBarrier, setTradeBarrier] = useState<number | undefined>(undefined);
  const [tradeDuration, setTradeDuration] = useState(5);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [priceHistory, setPriceHistory] = useState<{ timestamp: string; price: number }[]>([]);
  const [sseConnected, setSseConnected] = useState(false);
  const [lastTickAge, setLastTickAge] = useState<number>(0);
  // Live analysis state — updated via SSE on every tick
  const [liveDigitStats, setLiveDigitStats] = useState<any | null>(null);
  const [liveTrendStats, setLiveTrendStats] = useState<any | null>(null);
  const [lastLiveDigit, setLastLiveDigit] = useState<number | null>(null);
  const [dialogCountdown, setDialogCountdown] = useState<number | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const lastTickTimeRef = useRef<number>(Date.now());

  const { data: market, isLoading, refetch } = useGetMarketDetail(symbol || "", { query: { refetchInterval: 8000, enabled: !!symbol } } as { query: any });
  const { data: rec, refetch: refetchRec } = useGetAiRecommendationForMarket(symbol || "", { query: { refetchInterval: 3000, enabled: !!symbol } } as { query: any });
  const { data: engineStatus } = useGetAiEngineStatus({ query: { refetchInterval: 5000 } } as { query: any });
  const isPaperMode = (engineStatus as any)?.paperTradeMode ?? false;
  const executeTrade = useExecuteTrade();

  // ── SSE: live ticks + live market analysis ───────────────────────────────────
  useEffect(() => {
    if (!symbol) return;

    const es = new EventSource("/api/ai/events");
    eventSourceRef.current = es;

    es.addEventListener("connected", () => setSseConnected(true));

    es.addEventListener("tick", (e) => {
      try {
        const tick = JSON.parse(e.data);
        if (tick.symbol !== symbol) return;
        lastTickTimeRef.current = Date.now();
        setLivePrice(tick.price);
        setPriceHistory((prev) => {
          const next = [...prev, { timestamp: new Date().toISOString(), price: tick.price }];
          return next.slice(-120);
        });
      } catch { /* ignore */ }
    });

    // Live digit + trend analysis from the backend on every tick
    es.addEventListener("market_analysis", (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.symbol !== symbol) return;
        if (data.digitStats) setLiveDigitStats(data.digitStats);
        if (data.trendStats) setLiveTrendStats(data.trendStats);
        // lastDigit changes on EVERY tick — show it prominently in the digit panel
        if (typeof data.lastDigit === "number") setLastLiveDigit(data.lastDigit);
      } catch { /* ignore */ }
    });

    es.addEventListener("scan_complete", () => refetchRec());

    es.onerror = () => setSseConnected(false);

    const tickAgeTimer = setInterval(() => {
      setLastTickAge(Math.round((Date.now() - lastTickTimeRef.current) / 1000));
    }, 1000);

    return () => {
      es.close();
      clearInterval(tickAgeTimer);
      setSseConnected(false);
    };
  }, [symbol, refetchRec]);

  // Seed price history + initial stats from market data
  useEffect(() => {
    if (market?.priceHistory && priceHistory.length === 0) {
      setPriceHistory(market.priceHistory);
      const lastPrice = market.priceHistory[market.priceHistory.length - 1]?.price;
      if (lastPrice) setLivePrice(lastPrice);
    }
    if (market && (market as any).digitStats) setLiveDigitStats((market as any).digitStats);
    if (market && (market as any).trendStats) setLiveTrendStats((market as any).trendStats);
  }, [market]);

  // Populate from rec on first load too
  useEffect(() => {
    if (rec) {
      if ((rec as any).digitStats) setLiveDigitStats((rec as any).digitStats);
      if ((rec as any).trendStats) setLiveTrendStats((rec as any).trendStats);
    }
  }, [rec]);

  // ── Trade dialog countdown — MUST be before any early return (Rules of Hooks) ─
  useEffect(() => {
    if (!tradeDialog) { setDialogCountdown(null); return; }
    setDialogCountdown(15);
    const iv = setInterval(() => setDialogCountdown((c) => (c !== null ? Math.max(0, c - 1) : null)), 1000);
    return () => clearInterval(iv);
  }, [tradeDialog]);

  if (isLoading || !market) {
    return (
      <div className="p-8 flex items-center gap-3 text-muted-foreground">
        <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        Loading {symbol} analysis...
      </div>
    );
  }

  const recommendation = rec ?? market.recommendation;
  // Use live stats (SSE) first, fallback to rec/market data
  const digitStats = liveDigitStats ?? (rec as any)?.digitStats ?? (market as any)?.digitStats;
  const trendStats = liveTrendStats ?? (rec as any)?.trendStats ?? null;
  const digitBarrier = (rec as any)?.digitBarrier ?? (market as any)?.digitBarrier;
  const suggestedContracts = (rec as any)?.suggestedContractTypes ?? (recommendation as any)?.suggestedContractTypes ?? [];
  const chartData = priceHistory.length > 0 ? priceHistory : market.priceHistory;
  const currentPrice = livePrice ?? chartData[chartData.length - 1]?.price ?? 0;
  const startPrice = chartData[0]?.price ?? currentPrice;
  const priceChange = startPrice > 0 ? ((currentPrice - startPrice) / startPrice) * 100 : 0;

  // Match the backend DERIV_MARKETS pipSize definitions exactly:
  // R_50, R_75, RDBULL, RDBEAR → pipSize 4 (4 decimal places)
  // R_10, R_25, R_100, 1HZ*, JD* → pipSize 2 (2 decimal places)
  const pipSize = (
    symbol?.includes("R_50") || symbol?.includes("R_75") ||
    symbol === "RDBULL" || symbol === "RDBEAR"
  ) ? 4 : (symbol === "R_25" || symbol === "1HZ25V") ? 3 : 2;

  function openTradeDialog(contractType: string, direction: "up" | "down", barrier?: number, duration?: number) {
    setTradeContract(contractType);
    setTradeDir(direction);
    setTradeBarrier(barrier);
    setTradeDuration(duration ?? (rec as any)?.recommendedDuration ?? 5);
    setStake(String(recommendation?.stake ?? 1));
    setTradeDialog(true);
  }

  function handleExecuteTrade() {
    if (!symbol || !stake) return;
    executeTrade.mutate({
      data: { symbol, contractType: tradeContract || (tradeDir === "up" ? "RISE" : "FALL"), direction: tradeDir, stake: Number(stake), duration: tradeDuration, durationUnit: "t", barrier: tradeBarrier }
    }, {
      onSuccess: (result: any) => {
        toast.success(`Trade ${result.status === "won" ? "WON 🎉" : "LOST"} — ${result.status === "won" ? "+" : ""}$${Number(result.profit ?? 0).toFixed(2)}`);
        setTradeDialog(false);
        queryClient.invalidateQueries();
        refetch();
      },
      onError: (err: any) => toast.error(err?.error || "Trade failed"),
    });
  }

  const isDigitMarket = symbol?.includes("R_") || symbol?.includes("1HZ") || symbol?.startsWith("JD");

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 md:p-6 max-w-7xl mx-auto space-y-5 pb-10">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link href="/markets">
            <button className="p-1.5 rounded-md hover:bg-secondary transition-colors">
              <ArrowLeft className="w-4 h-4" />
            </button>
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl md:text-2xl font-bold tracking-tight">{market.displayName}</h1>
              <div className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${sseConnected ? "text-green-400 border-green-500/30 bg-green-500/5" : "text-zinc-500 border-zinc-700"}`}>
                {sseConnected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                {sseConnected ? `LIVE ${lastTickAge < 3 ? "·" : `${lastTickAge}s ago`}` : "connecting..."}
              </div>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-muted-foreground text-sm font-mono">{symbol}</span>
              <Badge variant="outline" className="text-[10px] capitalize">synthetic</Badge>
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-2xl font-bold tabular-nums">
            {currentPrice > 0 ? currentPrice.toFixed(pipSize) : "—"}
          </div>
          <div className={`text-sm font-mono ${priceChange >= 0 ? "text-green-400" : "text-red-400"}`}>
            {priceChange >= 0 ? "+" : ""}{priceChange.toFixed(4)}%
          </div>
        </div>
      </div>

      {/* Live Price Chart */}
      <Card className="bg-card">
        <CardContent className="pt-4 pb-2">
          <div className="h-36 md:h-48">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="timestamp" hide />
                <YAxis domain={["auto", "auto"]} hide />
                <Tooltip
                  content={({ active, payload }) => active && payload?.[0] ? (
                    <div className="bg-card border border-border px-2 py-1 rounded text-xs font-mono">
                      {Number(payload[0].value).toFixed(pipSize)}
                    </div>
                  ) : null}
                />
                <Area type="monotone" dataKey="price" stroke="hsl(var(--primary))" fill="url(#priceGrad)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Rise & Fall Analysis — clickable trade buttons */}
      <RiseFallPanel trendStats={trendStats} onTrade={openTradeDialog} />

      {/* Even & Odd Analysis — only for digit markets */}
      {isDigitMarket && <EvenOddPanel digitStats={digitStats} onTrade={openTradeDialog} />}

      {/* Digit Analysis (OVER/UNDER) — only for digit markets */}
      {isDigitMarket && digitStats && (
        <Card className="bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Activity className="w-4 h-4 text-primary" />
              Digit Analysis — OVER/UNDER Intelligence
              {lastLiveDigit !== null && (
                <span className="ml-2 flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-primary/15 border border-primary/30">
                  <span className="text-[10px] text-muted-foreground">LAST</span>
                  <span className="text-base font-mono font-bold text-primary leading-none">{lastLiveDigit}</span>
                </span>
              )}
              <span className="ml-auto w-2 h-2 rounded-full bg-green-500 animate-pulse" title="Live" />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Last digit highlight row — updates every tick */}
            {lastLiveDigit !== null && (
              <div className="grid grid-cols-10 gap-1">
                {[0,1,2,3,4,5,6,7,8,9].map(d => (
                  <div key={d} className={`flex items-center justify-center h-7 rounded-md text-sm font-mono font-bold transition-all duration-150 ${
                    d === lastLiveDigit ? "bg-primary text-primary-foreground scale-110 shadow-md shadow-primary/30" : "bg-secondary/30 text-muted-foreground"
                  }`}>{d}</div>
                ))}
              </div>
            )}
            <div className="grid grid-cols-10 gap-1">
              {digitStats.distribution.map((d: any) => (
                <DigitBar
                  key={d.digit}
                  digit={d.digit}
                  count={d.count}
                  pct={d.pct}
                  hot={digitStats.hotDigits?.includes(d.digit)}
                  cold={digitStats.coldDigits?.includes(d.digit)}
                  barrier={digitBarrier}
                  contractType={recommendation?.contractType}
                />
              ))}
            </div>

            {/* Clickable OVER/UNDER trade buttons for each barrier */}
            <div className="grid grid-cols-5 gap-1.5">
              {[0, 1, 2, 3, 4].map((b) => {
                const overPct = digitStats.distribution
                  .filter((d: any) => d.digit > b)
                  .reduce((s: number, d: any) => s + d.pct, 0);
                const isHot = overPct > 60;
                return (
                  <button
                    key={b}
                    onClick={() => openTradeDialog("DIGITOVER", "up", b)}
                    className={`flex flex-col items-center p-2 rounded-lg border text-center transition-all hover:scale-[1.02] ${isHot ? "border-green-500/40 bg-green-500/8" : "border-border bg-secondary/20"}`}
                  >
                    <div className="text-[9px] text-muted-foreground">OVER {b}</div>
                    <div className={`text-sm font-mono font-bold ${isHot ? "text-green-400" : "text-foreground"}`}>{overPct.toFixed(0)}%</div>
                    {isHot && <div className="text-[8px] text-green-500 mt-0.5">HOT</div>}
                  </button>
                );
              })}
              {[5, 6, 7, 8, 9].map((b) => {
                const underPct = digitStats.distribution
                  .filter((d: any) => d.digit < b)
                  .reduce((s: number, d: any) => s + d.pct, 0);
                const isHot = underPct > 60;
                return (
                  <button
                    key={b}
                    onClick={() => openTradeDialog("DIGITUNDER", "down", b)}
                    className={`flex flex-col items-center p-2 rounded-lg border text-center transition-all hover:scale-[1.02] ${isHot ? "border-blue-500/40 bg-blue-500/8" : "border-border bg-secondary/20"}`}
                  >
                    <div className="text-[9px] text-muted-foreground">UNDER {b}</div>
                    <div className={`text-sm font-mono font-bold ${isHot ? "text-blue-400" : "text-foreground"}`}>{underPct.toFixed(0)}%</div>
                    {isHot && <div className="text-[8px] text-blue-500 mt-0.5">HOT</div>}
                  </button>
                );
              })}
            </div>

            <div className="grid grid-cols-3 gap-2 text-center">
              <div className={`p-2 rounded-lg border ${digitStats.bias === "under" ? "bg-primary/10 border-primary/30" : "bg-secondary/30 border-border"}`}>
                <div className="text-xs text-muted-foreground">UNDER (0-4)</div>
                <div className="text-lg font-mono font-bold">{digitStats.underPct}%</div>
                <div className="text-[10px] text-muted-foreground">expected 50%</div>
              </div>
              <div className={`p-2 rounded-lg border ${digitStats.fivePct > 12 ? "bg-amber-500/10 border-amber-500/30" : "bg-secondary/30 border-border"}`}>
                <div className="text-xs text-muted-foreground">FIVE (5)</div>
                <div className="text-lg font-mono font-bold">{digitStats.fivePct}%</div>
                <div className="text-[10px] text-muted-foreground">expected 10%</div>
              </div>
              <div className={`p-2 rounded-lg border ${digitStats.bias === "over" ? "bg-primary/10 border-primary/30" : "bg-secondary/30 border-border"}`}>
                <div className="text-xs text-muted-foreground">OVER (6-9)</div>
                <div className="text-lg font-mono font-bold">{digitStats.overPct}%</div>
                <div className="text-[10px] text-muted-foreground">expected 40%</div>
              </div>
            </div>
            <div className="p-2 rounded-lg bg-secondary/30 border border-border text-xs text-muted-foreground">
              <span className="text-foreground font-medium">AI Signal: </span>
              {digitStats.bias === "over" ? `📈 OVER bias detected — ${digitStats.overPct}% of recent ticks ended with digits 6-9` :
               digitStats.bias === "under" ? `📉 UNDER bias detected — ${digitStats.underPct}% ended with digits 0-4` :
               "⚖ Neutral — digit distribution is balanced"}
              {digitStats.streakInfo && <span className="ml-2 text-amber-400">· {digitStats.streakInfo}</span>}
            </div>
          </CardContent>
        </Card>
      )}

      {/* AI Trade Intelligence Panel */}
      <AITradePanel
        rec={rec}
        recommendation={recommendation}
        trendStats={trendStats}
        digitStats={digitStats}
        isDigitMarket={isDigitMarket}
        openTradeDialog={openTradeDialog}
      />

      {/* Agent Intelligence Panel — live 9-agent breakdown */}
      <AgentIntelligencePanel agentOutputs={(rec as any)?.agentOutputs} recommendation={recommendation} />


      {/* Trade dialog */}
      <Dialog open={tradeDialog} onOpenChange={setTradeDialog}>
        <DialogContent className="bg-card border-border max-w-sm">
          <DialogHeader>
            <DialogTitle>Place Trade — {tradeContract}</DialogTitle>
          </DialogHeader>
          {isPaperMode && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs font-medium">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span><span className="font-bold">PAPER TRADE MODE</span> — trades are simulated, not sent to Deriv. Turn off in Settings to trade live.</span>
            </div>
          )}
          <div className="space-y-3 py-2">
            <div className="p-3 bg-secondary/30 rounded-lg flex justify-between items-start">
              <div>
                <div className="text-xs text-muted-foreground mb-0.5">Market</div>
                <div className="font-medium">{market.displayName}</div>
                <div className="text-xs font-mono text-muted-foreground mt-0.5">Current: {currentPrice.toFixed(pipSize)}</div>
              </div>
              {dialogCountdown !== null && (
                <div className={`text-right text-xs font-mono font-bold ${dialogCountdown <= 5 ? "text-red-400 animate-pulse" : dialogCountdown <= 10 ? "text-amber-400" : "text-muted-foreground"}`}>
                  <div>{dialogCountdown}s</div>
                  <div className="text-[9px] font-normal">to place</div>
                </div>
              )}
            </div>
            {/* Contract type badge */}
            <div className="flex items-center gap-2 text-xs flex-wrap">
              <span className="px-2 py-1 rounded-md bg-primary/10 border border-primary/30 font-mono font-bold text-primary">
                {tradeContract.startsWith("DIGIT")
                  ? (tradeBarrier != null ? `${tradeContract.replace("DIGIT", "")} ${tradeBarrier}` : tradeContract.replace("DIGIT", ""))
                  : tradeContract}
              </span>
              {tradeBarrier != null && (
                <span className="px-2 py-1 rounded-md bg-violet-500/10 border border-violet-500/30 font-mono text-violet-400 text-[10px]">Barrier: {tradeBarrier}</span>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="stake">Stake (USD)</Label>
              <Input id="stake" type="number" value={stake} min="0.35" step="0.5" onChange={(e) => setStake(e.target.value)} className="font-mono bg-secondary/50" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ticks">Duration (ticks)</Label>
              <Input
                id="ticks"
                type="number"
                value={tradeDuration}
                min="1"
                max="15"
                step="1"
                onChange={(e) => setTradeDuration(Math.max(1, Math.min(15, Number(e.target.value))))}
                className="font-mono bg-secondary/50"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTradeDialog(false)}>Cancel</Button>
            <Button onClick={handleExecuteTrade} disabled={executeTrade.isPending}>
              {executeTrade.isPending ? "Executing…" : `Execute ${tradeContract}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
