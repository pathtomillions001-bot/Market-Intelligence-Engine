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
function RiseFallPanel({ trendStats, agentData, onTrade }: {
  trendStats: any;
  agentData?: { probUp: number; probDown: number; weightedScore: number; shouldTrade: boolean; recommendedDuration: number };
  onTrade: (type: string, dir: "up" | "down", barrier?: number, duration?: number) => void;
}) {
  if (!trendStats) return null;
  const {
    direction, strength, winProb, streak, streakDir, momentum, samples,
    recommendRise = false, recommendFall = false,
    recentRisePct = 50, recentFallPct = 50,
    risePct = 50, fallPct = 50,
    rsi = 50, hotStreak = 0, hotDirection = "none", streakInfo = "",
    bias = "neutral",
  } = trendStats;

  // Blend 9-agent direction probabilities (65%) with statistical win prob (35%)
  const agentProbUp = agentData?.probUp ?? null;
  const agentProbDown = agentData?.probDown ?? null;
  const risingPct = agentProbUp !== null
    ? Math.round(agentProbUp * 100 * 0.65 + (winProb?.rise ?? 50) * 0.35)
    : winProb?.rise ?? 50;
  const fallingPct = agentProbDown !== null
    ? Math.round(agentProbDown * 100 * 0.65 + (winProb?.fall ?? 50) * 0.35)
    : winProb?.fall ?? 50;

  // Agent-driven recommendation overrides statistical signals when available
  const isRiseRecommended = agentData
    ? (agentData.probUp > 0.52 && agentData.shouldTrade && agentData.probUp >= agentData.probDown)
    : recommendRise;
  const isFallRecommended = agentData
    ? (agentData.probDown > 0.52 && agentData.shouldTrade && agentData.probDown > agentData.probUp)
    : recommendFall;
  const isHotStreak = hotStreak >= 3;
  const rsiOverbought = rsi > 70;
  const rsiOversold   = rsi < 30;
  const agentDuration = agentData?.recommendedDuration ?? 5;
  const wscore = agentData?.weightedScore ?? 0;

  return (
    <Card className="bg-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-indigo-400" />
          Rise &amp; Fall Analysis
          {samples > 0 && <span className="text-[10px] text-muted-foreground font-normal">({samples} ticks)</span>}
          {(rsiOverbought || rsiOversold) && (
            <span className={`text-[9px] px-1.5 py-0.5 rounded border font-bold ${rsiOverbought ? "bg-red-500/10 border-red-500/30 text-red-400" : "bg-green-500/10 border-green-500/30 text-green-400"}`}>
              RSI {rsi} {rsiOverbought ? "OB" : "OS"}
            </span>
          )}
          <span className="ml-auto w-2 h-2 rounded-full bg-green-500 animate-pulse" title="Live" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">

        {/* Main action buttons */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onTrade("CALL", "up", undefined, agentDuration)}
            className={`flex flex-col items-center p-4 rounded-xl border-2 transition-all hover:scale-[1.02] active:scale-100 cursor-pointer ${
              isRiseRecommended ? "border-green-500/60 bg-green-500/10" : "border-border bg-secondary/30 hover:border-green-500/30"
            }`}
          >
            <ArrowUp className={`w-6 h-6 mb-1.5 ${isRiseRecommended ? "text-green-400" : "text-muted-foreground"}`} />
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Rise</div>
            <div className={`text-2xl font-mono font-bold mt-1 ${isRiseRecommended ? "text-green-400" : "text-foreground"}`}>{risingPct.toFixed(0)}%</div>
            <div className="text-[9px] text-muted-foreground">{agentProbUp !== null ? "9-agent win prob" : "win probability"}</div>
            {isRiseRecommended && <Badge className="mt-1.5 text-[9px] bg-green-500/20 text-green-400 border-green-500/30">AI FAVOURS · {agentDuration}t</Badge>}
          </button>
          <button
            onClick={() => onTrade("PUT", "down", undefined, agentDuration)}
            className={`flex flex-col items-center p-4 rounded-xl border-2 transition-all hover:scale-[1.02] active:scale-100 cursor-pointer ${
              isFallRecommended ? "border-red-500/60 bg-red-500/10" : "border-border bg-secondary/30 hover:border-red-500/30"
            }`}
          >
            <ArrowDown className={`w-6 h-6 mb-1.5 ${isFallRecommended ? "text-red-400" : "text-muted-foreground"}`} />
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Fall</div>
            <div className={`text-2xl font-mono font-bold mt-1 ${isFallRecommended ? "text-red-400" : "text-foreground"}`}>{fallingPct.toFixed(0)}%</div>
            <div className="text-[9px] text-muted-foreground">{agentProbDown !== null ? "9-agent win prob" : "win probability"}</div>
            {isFallRecommended && <Badge className="mt-1.5 text-[9px] bg-red-500/20 text-red-400 border-red-500/30">AI FAVOURS · {agentDuration}t</Badge>}
          </button>
        </div>

        {/* 9-Agent consensus bar — shown when agent data is available */}
        {agentData && (
          <div className="p-2.5 rounded-lg bg-secondary/20 border border-border">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[9px] text-muted-foreground uppercase tracking-wider font-medium">13-Agent Consensus</span>
              <div className="flex items-center gap-2">
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${agentData.shouldTrade ? "bg-green-500/15 text-green-400 border-green-500/30" : "bg-amber-500/10 text-amber-400 border-amber-500/30"}`}>
                  {agentData.shouldTrade ? "✓ TRADE" : "⏸ WAIT"}
                </span>
                <span className={`text-xs font-mono font-bold ${wscore >= 70 ? "text-green-400" : wscore >= 50 ? "text-amber-400" : "text-red-400"}`}>{wscore.toFixed(0)}/100</span>
              </div>
            </div>
            <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all duration-700"
                style={{ width: `${wscore}%`, background: wscore >= 70 ? "linear-gradient(90deg,#16a34a,#22c55e)" : wscore >= 50 ? "linear-gradient(90deg,#d97706,#f59e0b)" : "linear-gradient(90deg,#b91c1c,#ef4444)" }}
              />
            </div>
            <div className="text-[8px] text-muted-foreground mt-1">Optimal duration: {agentDuration}t · click Rise or Fall to auto-fill stake &amp; ticks</div>
          </div>
        )}

        {/* Multi-window frequency table — matching EvenOdd style */}
        <div className="grid grid-cols-2 gap-1.5 text-center">
          {[
            { label: "Last 20 ticks", rise: recentRisePct, fall: recentFallPct },
            { label: "Last 100 ticks", rise: risePct,       fall: fallPct },
          ].map(({ label, rise, fall }) => {
            const dominantRise = rise > 53;
            const dominantFall = fall > 53;
            return (
              <div key={label} className="p-2 rounded-lg bg-secondary/30 border border-border">
                <div className="text-[9px] text-muted-foreground mb-1">{label}</div>
                <div className={`text-xs font-mono font-bold ${dominantRise ? "text-green-400" : "text-muted-foreground"}`}>↑ Rise {rise.toFixed(0)}%</div>
                <div className={`text-xs font-mono font-bold ${dominantFall ? "text-red-400" : "text-muted-foreground"}`}>↓ Fall {fall.toFixed(0)}%</div>
              </div>
            );
          })}
        </div>

        {/* RSI + Momentum + Streak stats */}
        <div className="grid grid-cols-3 gap-1.5">
          <div className={`p-2 rounded-lg border text-center ${rsiOverbought ? "border-red-500/30 bg-red-500/5" : rsiOversold ? "border-green-500/30 bg-green-500/5" : "border-border bg-secondary/20"}`}>
            <div className="text-[9px] text-muted-foreground mb-0.5">RSI (14)</div>
            <div className={`text-sm font-mono font-bold ${rsiOverbought ? "text-red-400" : rsiOversold ? "text-green-400" : "text-muted-foreground"}`}>{rsi}</div>
            <div className="text-[8px] text-muted-foreground mt-0.5">{rsiOverbought ? "overbought → fall" : rsiOversold ? "oversold → rise" : "neutral"}</div>
          </div>
          <div className="p-2 rounded-lg border border-border bg-secondary/20 text-center">
            <div className="text-[9px] text-muted-foreground mb-0.5">Momentum</div>
            <div className={`text-sm font-mono font-bold ${momentum > 0 ? "text-green-400" : momentum < 0 ? "text-red-400" : "text-muted-foreground"}`}>
              {momentum > 0 ? "+" : ""}{(momentum * 100).toFixed(2)}
            </div>
            <div className="text-[8px] text-muted-foreground mt-0.5">{momentum > 0.001 ? "bullish" : momentum < -0.001 ? "bearish" : "flat"}</div>
          </div>
          <div className={`p-2 rounded-lg border text-center ${isHotStreak ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-secondary/20"}`}>
            <div className="text-[9px] text-muted-foreground mb-0.5">Hot Streak</div>
            <div className={`text-sm font-mono font-bold ${hotDirection === "rise" ? "text-green-400" : hotDirection === "fall" ? "text-red-400" : "text-muted-foreground"}`}>
              {hotStreak > 0 ? `${hotStreak}× ${hotDirection === "rise" ? "↑" : "↓"}` : "—"}
            </div>
            {isHotStreak && (
              <div className="text-[8px] text-amber-400 mt-0.5">→ expect reversal</div>
            )}
          </div>
        </div>

        {/* Statistical edge bar */}
        <div className="p-2 rounded-lg bg-secondary/20 border border-border">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[9px] text-muted-foreground uppercase tracking-wide">Signal Strength</span>
            <span className={`text-[10px] font-mono font-bold ${strength > 60 ? "text-green-400" : strength > 40 ? "text-amber-400" : "text-muted-foreground"}`}>{strength.toFixed(0)}%</span>
          </div>
          <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${strength > 60 ? "bg-green-400" : strength > 40 ? "bg-amber-400" : "bg-secondary-foreground/20"}`}
              style={{ width: `${Math.min(100, strength)}%` }}
            />
          </div>
        </div>

        {/* AI Signal summary */}
        <div className="p-2 rounded-lg bg-secondary/20 border border-border text-xs text-muted-foreground">
          <span className="text-foreground font-medium">AI Signal: </span>
          {isRiseRecommended
            ? `📈 RISE recommended — ${rsiOversold ? `RSI oversold (${rsi})` : recentFallPct > 65 ? `mean-reversion after ${recentFallPct}% recent falls` : `${risePct}% long-run rise bias`}`
            : isFallRecommended
            ? `📉 FALL recommended — ${rsiOverbought ? `RSI overbought (${rsi})` : recentRisePct > 65 ? `mean-reversion after ${recentRisePct}% recent rises` : `${fallPct}% long-run fall bias`}`
            : isHotStreak
            ? `⚠ ${hotStreak}× ${hotDirection.toUpperCase()} streak — reversal possible but not confirmed`
            : "⚖ Balanced — no clear edge. Wait for a stronger signal before trading Rise/Fall."}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Even / Odd analysis panel ──────────────────────────────────────────────────
function EvenOddPanel({ digitStats, agentData, onTrade }: {
  digitStats: any;
  agentData?: { weightedScore: number; shouldTrade: boolean; recommendedDuration: number };
  onTrade: (type: string, dir: "up" | "down", barrier?: number, duration?: number) => void;
}) {
  if (!digitStats) return null;

  const eoStats = digitStats.evenOddStats;
  const EVEN_DIGITS = [0, 2, 4, 6, 8];
  const dist: { digit: number; pct: number }[] = digitStats.distribution ?? [];

  // Frequency data — fixed window labels (always 20/50/100)
  const evenPct100 = eoStats?.evenPct ?? dist.filter((d) => EVEN_DIGITS.includes(d.digit)).reduce((s: number, d: any) => s + d.pct, 0);
  const oddPct100  = eoStats?.oddPct  ?? (100 - evenPct100);
  const evenPct20  = eoStats?.recentEvenPct   ?? evenPct100;
  const oddPct20   = eoStats?.recentOddPct    ?? oddPct100;
  const evenPct50  = eoStats?.recent50EvenPct ?? evenPct100;
  const oddPct50   = eoStats?.recent50OddPct  ?? oddPct100;

  // Core signals
  const bias: "even" | "odd" | "neutral" = eoStats?.bias ?? "neutral";
  const recommendEven = eoStats?.recommendEven ?? false;
  const recommendOdd  = eoStats?.recommendOdd  ?? false;
  const streak        = eoStats?.currentStreak ?? 0;
  const streakType    = eoStats?.currentStreakType ?? "even";
  const chiSig        = eoStats?.chiSquareSignificant ?? false;
  const chiPval       = eoStats?.chiSquarePvalue ?? 0.5;
  const edge          = eoStats?.edge ?? 0;
  const s100 = eoStats?.samples100 ?? digitStats.samples ?? 0;

  // Markov chain data — primary win probability signal
  const markovEvenGivenEven  = eoStats?.markovEvenGivenEven ?? 0.5;
  const markovEvenGivenOdd   = eoStats?.markovEvenGivenOdd  ?? 0.5;
  const markovNextEvenProb   = eoStats?.markovNextEvenProb  ?? 0.5;
  const markovSignal         = eoStats?.markovSignal ?? "neutral";
  const streakReversalSignal = eoStats?.streakReversalSignal ?? "neutral";

  const isEvenRecommended = recommendEven;
  const isOddRecommended  = recommendOdd;

  // Streak reversal label
  const isStrongStreak = streak >= 4;
  const reversalSide = streakType === "even" ? "ODD" : "EVEN";

  const agentDuration = agentData?.recommendedDuration ?? 5;
  const wscore = agentData?.weightedScore ?? 0;

  // Primary win probabilities driven by Markov chain (part of agent pipeline)
  const evenWinPct = (markovNextEvenProb * 100);
  const oddWinPct  = ((1 - markovNextEvenProb) * 100);

  return (
    <Card className="bg-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <span className="text-base leading-none">⚡</span>
          Even &amp; Odd Analysis
          <span className="text-[10px] text-muted-foreground font-normal">({s100} ticks)</span>
          {chiSig && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-400 font-bold">
              χ² p&lt;{chiPval}
            </span>
          )}
          {agentData && (
            <span className={`ml-auto text-[9px] px-1.5 py-0.5 rounded-full border font-mono ${wscore >= 70 ? "bg-green-500/10 border-green-500/30 text-green-400" : wscore >= 50 ? "bg-amber-500/10 border-amber-500/30 text-amber-400" : "bg-zinc-800 border-zinc-700 text-zinc-400"}`}>
              13-Agents {wscore.toFixed(0)}/100
            </span>
          )}
          <span className={`${agentData ? "" : "ml-auto"} w-2 h-2 rounded-full bg-green-500 animate-pulse`} title="Live" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">

        {/* Trade buttons */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onTrade("DIGITEVEN", "up", undefined, agentDuration)}
            className={`flex flex-col items-center p-4 rounded-xl border-2 transition-all hover:scale-[1.02] active:scale-100 cursor-pointer ${
              isEvenRecommended ? "border-cyan-500/60 bg-cyan-500/10" : "border-border bg-secondary/30 hover:border-cyan-500/30"
            }`}
          >
            <span className={`text-xs font-mono font-bold tracking-widest mb-1 ${isEvenRecommended ? "text-cyan-400" : "text-muted-foreground"}`}>0·2·4·6·8</span>
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">EVEN</div>
            <div className={`text-2xl font-mono font-bold mt-1 ${isEvenRecommended ? "text-cyan-400" : "text-foreground"}`}>{evenWinPct.toFixed(1)}%</div>
            <div className="text-[9px] text-muted-foreground">Markov probability</div>
            {isEvenRecommended && <Badge className="mt-1.5 text-[9px] bg-cyan-500/20 text-cyan-400 border-cyan-500/30">AI FAVOURS · {agentDuration}t</Badge>}
          </button>
          <button
            onClick={() => onTrade("DIGITODD", "down", undefined, agentDuration)}
            className={`flex flex-col items-center p-4 rounded-xl border-2 transition-all hover:scale-[1.02] active:scale-100 cursor-pointer ${
              isOddRecommended ? "border-violet-500/60 bg-violet-500/10" : "border-border bg-secondary/30 hover:border-violet-500/30"
            }`}
          >
            <span className={`text-xs font-mono font-bold tracking-widest mb-1 ${isOddRecommended ? "text-violet-400" : "text-muted-foreground"}`}>1·3·5·7·9</span>
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">ODD</div>
            <div className={`text-2xl font-mono font-bold mt-1 ${isOddRecommended ? "text-violet-400" : "text-foreground"}`}>{oddWinPct.toFixed(1)}%</div>
            <div className="text-[9px] text-muted-foreground">Markov probability</div>
            {isOddRecommended && <Badge className="mt-1.5 text-[9px] bg-violet-500/20 text-violet-400 border-violet-500/30">AI FAVOURS · {agentDuration}t</Badge>}
          </button>
        </div>

        {/* 9-Agent consensus bar */}
        {agentData && (
          <div className="p-2.5 rounded-lg bg-secondary/20 border border-border">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[9px] text-muted-foreground uppercase tracking-wider font-medium">13-Agent Consensus</span>
              <div className="flex items-center gap-2">
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${agentData.shouldTrade ? "bg-green-500/15 text-green-400 border-green-500/30" : "bg-amber-500/10 text-amber-400 border-amber-500/30"}`}>
                  {agentData.shouldTrade ? "✓ TRADE" : "⏸ WAIT"}
                </span>
                <span className={`text-xs font-mono font-bold ${wscore >= 70 ? "text-green-400" : wscore >= 50 ? "text-amber-400" : "text-red-400"}`}>{wscore.toFixed(0)}/100</span>
              </div>
            </div>
            <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all duration-700"
                style={{ width: `${wscore}%`, background: wscore >= 70 ? "linear-gradient(90deg,#16a34a,#22c55e)" : wscore >= 50 ? "linear-gradient(90deg,#d97706,#f59e0b)" : "linear-gradient(90deg,#b91c1c,#ef4444)" }}
              />
            </div>
            <div className="text-[8px] text-muted-foreground mt-1">Optimal duration: {agentDuration}t · click Even or Odd to auto-fill stake &amp; ticks</div>
          </div>
        )}

        {/* Multi-window frequency table — fixed labels (always 20 / 50 / 100) */}
        <div className="grid grid-cols-3 gap-1.5 text-center">
          {[
            { label: "Last 20",  even: evenPct20,  odd: oddPct20 },
            { label: "Last 50",  even: evenPct50,  odd: oddPct50 },
            { label: "Last 100", even: evenPct100, odd: oddPct100 },
          ].map(({ label, even, odd }) => {
            const dominantEven = even > 53;
            const dominantOdd  = odd  > 53;
            return (
              <div key={label} className="p-2 rounded-lg bg-secondary/30 border border-border">
                <div className="text-[9px] text-muted-foreground mb-1">{label}</div>
                <div className={`text-xs font-mono font-bold ${dominantEven ? "text-cyan-400" : "text-muted-foreground"}`}>E {even.toFixed(1)}%</div>
                <div className={`text-xs font-mono font-bold ${dominantOdd  ? "text-violet-400" : "text-muted-foreground"}`}>O {odd.toFixed(1)}%</div>
              </div>
            );
          })}
        </div>

        {/* Markov Chain Analysis */}
        <div className="grid grid-cols-2 gap-1.5">
          <div className="p-2 rounded-lg border border-border bg-secondary/20">
            <div className="text-[9px] text-muted-foreground mb-1">Markov P(even|prev=even)</div>
            <div className={`text-sm font-mono font-bold ${markovEvenGivenEven > 0.55 ? "text-cyan-400" : markovEvenGivenEven < 0.45 ? "text-violet-400" : "text-muted-foreground"}`}>
              {(markovEvenGivenEven * 100).toFixed(1)}%
            </div>
            <div className="text-[8px] text-muted-foreground mt-0.5">
              {markovEvenGivenEven > 0.55 ? "momentum ↗" : markovEvenGivenEven < 0.45 ? "reversal ↩" : "neutral"}
            </div>
          </div>
          <div className="p-2 rounded-lg border border-border bg-secondary/20">
            <div className="text-[9px] text-muted-foreground mb-1">Markov P(even|prev=odd)</div>
            <div className={`text-sm font-mono font-bold ${markovEvenGivenOdd > 0.55 ? "text-cyan-400" : markovEvenGivenOdd < 0.45 ? "text-violet-400" : "text-muted-foreground"}`}>
              {(markovEvenGivenOdd * 100).toFixed(1)}%
            </div>
            <div className="text-[8px] text-muted-foreground mt-0.5">
              {markovEvenGivenOdd > 0.55 ? "even likely ↗" : markovEvenGivenOdd < 0.45 ? "odd likely ↩" : "neutral"}
            </div>
          </div>
        </div>

        {/* Streak + chi-square info */}
        <div className="grid grid-cols-2 gap-1.5">
          <div className={`p-2 rounded-lg border text-center ${isStrongStreak ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-secondary/20"}`}>
            <div className="text-[9px] text-muted-foreground mb-0.5">Streak</div>
            <div className={`text-sm font-mono font-bold ${isStrongStreak ? "text-amber-400" : "text-foreground"}`}>
              {streak > 0 ? `${streak}× ${streakType.toUpperCase()}` : "—"}
            </div>
            {isStrongStreak && (
              <div className="text-[8px] text-amber-400 mt-0.5">→ bet {reversalSide}</div>
            )}
          </div>
          <div className={`p-2 rounded-lg border text-center ${chiSig ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-secondary/20"}`}>
            <div className="text-[9px] text-muted-foreground mb-0.5">Chi-Square Test</div>
            <div className={`text-sm font-mono font-bold ${chiSig ? "text-amber-400" : "text-muted-foreground"}`}>
              {chiSig ? `p<${chiPval} ✓` : "p>0.10 neutral"}
            </div>
          </div>
        </div>

        {/* Edge bar */}
        <div className="p-2 rounded-lg bg-secondary/20 border border-border">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[9px] text-muted-foreground uppercase tracking-wide">Statistical Edge</span>
            <span className={`text-[10px] font-mono font-bold ${edge > 5 ? "text-amber-400" : "text-muted-foreground"}`}>{edge.toFixed(1)}%</span>
          </div>
          <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all duration-500 ${edge > 8 ? "bg-amber-400" : edge > 4 ? "bg-amber-500/60" : "bg-secondary-foreground/20"}`}
              style={{ width: `${Math.min(100, edge * 5)}%` }} />
          </div>
        </div>

        {/* AI Signal summary — based on Markov + streak reversal logic */}
        <div className="p-2 rounded-lg bg-secondary/20 border border-border text-xs text-muted-foreground">
          <span className="text-foreground font-medium">AI Signal: </span>
          {isEvenRecommended
            ? `🎯 EVEN recommended — ${
                streakReversalSignal === "even" ? `reversal after ${streak}× ODD streak`
                : markovSignal === "even" ? `Markov P(even|last)=${(markovNextEvenProb * 100).toFixed(0)}%`
                : chiSig ? `χ² confirmed bias (${evenPct100.toFixed(1)}%)` : "multi-signal consensus"
              }`
            : isOddRecommended
            ? `🎯 ODD recommended — ${
                streakReversalSignal === "odd" ? `reversal after ${streak}× EVEN streak`
                : markovSignal === "odd" ? `Markov P(odd|last)=${((1-markovNextEvenProb) * 100).toFixed(0)}%`
                : chiSig ? `χ² confirmed bias (${oddPct100.toFixed(1)}%)` : "multi-signal consensus"
              }`
            : isStrongStreak
            ? `⚠ ${streak}× ${streakType.toUpperCase()} streak — reversal to ${reversalSide} possible but not confirmed`
            : "⚖ Balanced — no clear edge. Avoid trading Even/Odd until a signal forms."}
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

  const isDigitMarket = !!(symbol?.includes("R_") || symbol?.includes("1HZ") || symbol?.startsWith("JD"));

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

      {/* Extract 13-agent outputs from coordinator recommendation */}
      {(() => {
        const agentOutputs = (rec as any)?.agentOutputs ?? {};
        const dirAgent = agentOutputs?.direction?.data ?? agentOutputs?.riseFallAgent?.data;
        const masterAgent = agentOutputs?.masterDecision?.data ?? agentOutputs?.confidenceFusion?.data;
        const durationAgent = agentOutputs?.durationOptimizer?.data ?? agentOutputs?.executionTiming?.data;
        const agentRecommendedDuration = durationAgent?.duration ?? (rec as any)?.recommendedDuration ?? 5;

        const rfAgentData = dirAgent ? {
          probUp: dirAgent.probUp ?? 0.5,
          probDown: dirAgent.probDown ?? 0.5,
          weightedScore: masterAgent?.weightedScore ?? 0,
          shouldTrade: masterAgent?.shouldTrade ?? false,
          recommendedDuration: agentRecommendedDuration,
        } : undefined;

        const eoAgentData = masterAgent ? {
          weightedScore: masterAgent.weightedScore ?? 0,
          shouldTrade: masterAgent.shouldTrade ?? false,
          recommendedDuration: agentRecommendedDuration,
        } : undefined;

        // All 13 agent keys with human-readable names
        const AGENT_META: Array<{ key: string; label: string; icon: string }> = [
          { key: "marketScanner",       label: "Market Scanner",      icon: "📡" },
          { key: "tickIntelligence",    label: "Tick Intelligence",   icon: "🕐" },
          { key: "digitProbability",    label: "Digit Probability",   icon: "🔢" },
          { key: "riseFallAgent",       label: "Rise/Fall Model",     icon: "📈" },
          { key: "marketRegime",        label: "Market Regime",       icon: "🌊" },
          { key: "executionTiming",     label: "Execution Timing",    icon: "⏱" },
          { key: "confidenceFusion",    label: "Confidence Fusion",   icon: "🧠" },
          { key: "recoveryIntelligence",label: "Recovery Intel",      icon: "🛡" },
          { key: "riskIntelligence",    label: "Risk Intelligence",   icon: "⚠" },
          { key: "portfolioManager",    label: "Portfolio Manager",   icon: "💼" },
          { key: "learningAgent",       label: "Learning Agent",      icon: "🎓" },
          { key: "patternDiscovery",    label: "Pattern Discovery",   icon: "🔍" },
          { key: "tradeExplainability", label: "Trade Explainability",icon: "💡" },
        ];

        const agentCards = AGENT_META.filter(a => agentOutputs[a.key]);

        return (
          <>
            {/* Rise & Fall Analysis — 13-agent driven win probabilities */}
            <RiseFallPanel trendStats={trendStats} agentData={rfAgentData} onTrade={openTradeDialog} />
            {/* Even & Odd Analysis — only for digit markets */}
            {isDigitMarket && <EvenOddPanel digitStats={digitStats} agentData={eoAgentData} onTrade={openTradeDialog} />}

          </>
        );
      })()}

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
                    key={`ov${b}`}
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
                    key={`un${b}`}
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
                  : tradeContract === "CALL" ? "Rise (CALL)"
                  : tradeContract === "PUT" ? "Fall (PUT)"
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
