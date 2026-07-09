import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Brain, Target, AlertTriangle, TrendingUp, CheckCircle2,
  XCircle, Lightbulb, Activity, BarChart3, Shield, Zap, Cpu,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useMemo } from "react";

// ── API helpers ───────────────────────────────────────────────────────────────

function useIntelligenceSummary() {
  return useQuery({
    queryKey: ["intelligence-summary"],
    queryFn: () => fetch("/api/ai/intelligence/summary").then(r => r.json()),
    refetchInterval: 15_000,
    staleTime: 8_000,
    refetchOnWindowFocus: true,
  });
}

function useRecentReports() {
  return useQuery({
    queryKey: ["intelligence-reports"],
    queryFn: () => fetch("/api/ai/intelligence/reports?limit=20").then(r => r.json()),
    refetchInterval: 15_000,
    staleTime: 8_000,
    refetchOnWindowFocus: true,
  });
}

function useRecentMissed() {
  return useQuery({
    queryKey: ["intelligence-missed"],
    queryFn: () => fetch("/api/ai/intelligence/missed?limit=15").then(r => r.json()),
    refetchInterval: 15_000,
    staleTime: 8_000,
    refetchOnWindowFocus: true,
  });
}

function useThresholds() {
  return useQuery({
    queryKey: ["intelligence-thresholds"],
    queryFn: () => fetch("/api/ai/intelligence/thresholds").then(r => r.json()),
    refetchInterval: 10_000,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });
}

function useEngineStatus() {
  return useQuery({
    queryKey: ["engine-status-intel"],
    queryFn: () => fetch("/api/ai/engine/status").then(r => r.json()),
    refetchInterval: 10_000,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function pct(n: number | null | undefined) {
  if (n == null) return "—";
  return `${Math.round(n)}%`;
}

function fmt2(n: number | null | undefined) {
  if (n == null) return "—";
  return n.toFixed(2);
}

function confidenceColor(assessment: string) {
  if (assessment === "too_high") return "text-red-400";
  if (assessment === "too_low")  return "text-yellow-400";
  return "text-green-400";
}

function confidenceLabel(assessment: string) {
  if (assessment === "too_high") return "Overconfident";
  if (assessment === "too_low")  return "Underconfident";
  return "Appropriate";
}

function scoreColor(score: number) {
  if (score >= 65) return "text-green-400";
  if (score >= 50) return "text-yellow-400";
  return "text-red-400";
}

// ── Section: Overview cards ────────────────────────────────────────────────────

function OverviewCards({ summary, missed }: { summary: any; missed: any }) {
  const cards = [
    {
      label: "Trades Analyzed",
      value: summary?.totalAnalyzed ?? 0,
      icon: Brain,
      color: "text-primary",
      sub: summary?.totalAnalyzed > 0 ? `${summary.winsAnalyzed}W / ${summary.lossesAnalyzed}L` : "Run trades to build intelligence",
    },
    {
      label: "Avoidable Loss Rate",
      value: summary?.totalAnalyzed > 0 ? `${summary.avoidableLossRate}%` : "—",
      icon: Shield,
      color: summary?.avoidableLossRate > 30 ? "text-red-400" : "text-green-400",
      sub: `${summary?.avoidableLosses ?? 0} of ${summary?.lossesAnalyzed ?? 0} losses`,
    },
    {
      label: "Confidence Accuracy",
      value: summary?.totalAnalyzed > 0 ? `${summary.appropriateConfidenceRate}%` : "—",
      icon: Target,
      color: summary?.appropriateConfidenceRate > 65 ? "text-green-400" : "text-yellow-400",
      sub: "Appropriately calibrated",
    },
    {
      label: "Missed Win Rate",
      value: missed?.evaluated > 0 ? `${missed.wouldHaveWonRate}%` : "—",
      icon: AlertTriangle,
      color: missed?.wouldHaveWonRate > 50 ? "text-yellow-400" : "text-green-400",
      sub: `${missed?.wouldHaveWon ?? 0} of ${missed?.evaluated ?? 0} evaluated`,
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((card, i) => (
        <motion.div key={card.label} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06 }}>
          <Card className="bg-card border-border">
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">{card.label}</span>
                <card.icon className={`w-4 h-4 ${card.color}`} />
              </div>
              <p className={`text-2xl font-bold font-mono ${card.color}`}>{card.value}</p>
              {card.sub && <p className="text-xs text-muted-foreground mt-0.5">{card.sub}</p>}
            </CardContent>
          </Card>
        </motion.div>
      ))}
    </div>
  );
}

// ── Section: 13 Agents Live Intelligence ─────────────────────────────────────

// Explicit name→agentId map matching AGENT_NAMES / AGENT_SCORE_KEYS in ai.ts
// (string normalisation would mismap "Rise/Fall Model" → "risefallModel" ≠ "riseFallAgent")
const AGENT_NAME_TO_KEY: Record<string, string> = {
  "Market Scanner":        "marketScanner",
  "Tick Intelligence":     "tickIntelligence",
  "Digit Probability":     "digitProbability",
  "Rise/Fall Model":       "riseFallAgent",
  "Market Regime":         "marketRegime",
  "Execution Timing":      "executionTiming",
  "Confidence Fusion":     "confidenceFusion",       // meta-agent, no adaptive stats by design
  "Recovery Intelligence": "recoveryIntelligence",
  "Risk Intelligence":     "riskIntelligence",
  "Portfolio Manager":     "portfolioManager",
  "Learning Agent":        "learningAgent",
  "Pattern Discovery":     "patternDiscovery",
  "Trade Explainability":  "tradeExplainability",    // meta-agent, no adaptive stats by design
};

const AGENT_DESCRIPTIONS: Record<string, string> = {
  "Market Scanner":       "Ranks all markets by opportunity quality",
  "Tick Intelligence":    "Analyses tick patterns, noise, momentum",
  "Digit Probability":    "Digit frequency, Markov chains, streaks",
  "Rise/Fall Model":      "Directional bias, trend strength",
  "Market Regime":        "Classifies trending / choppy / volatile",
  "Execution Timing":     "Optimal entry window detection",
  "Confidence Fusion":    "Weighted consensus of all agents",
  "Recovery Intelligence":"Loss-streak gating, recovery safety",
  "Risk Intelligence":    "Capital exposure, drawdown monitoring",
  "Portfolio Manager":    "Position sizing, session balance",
  "Learning Agent":       "Historical win-rate calibration per market",
  "Pattern Discovery":    "Recurring pattern detection across trades",
  "Trade Explainability": "Post-trade why-won/lost analysis",
};

function AgentLiveStatus({ engineStatus, dynamicStatus }: { engineStatus: any; dynamicStatus: any }) {
  const agentStatuses: Array<{ name: string; confidence: number }> = engineStatus?.agentStatuses ?? [];
  const agentAccuracy: Array<{ agentId: string; accuracy: number; samples: number; dynamicWeight: number }> =
    dynamicStatus?.agentStats ?? [];

  // Merge live scores with accuracy data using the explicit name→key map
  const merged = agentStatuses.map((a: any) => {
    const key = AGENT_NAME_TO_KEY[a.name as string];  // explicit — no string normalisation
    const acc = key ? (agentAccuracy.find(x => x.agentId === key) ?? null) : null;
    const isMeta = a.name === "Confidence Fusion" || a.name === "Trade Explainability";
    return { name: a.name, liveScore: a.confidence, accuracy: acc?.accuracy ?? null, samples: acc?.samples ?? 0, weight: acc?.dynamicWeight ?? 1.0, isMeta };
  });

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Cpu className="w-4 h-4 text-primary" />
          13 Agents — Live Scores &amp; Learning Status
        </CardTitle>
      </CardHeader>
      <CardContent>
        {merged.length === 0 ? (
          <p className="text-xs text-muted-foreground">Engine not running — start the autonomous engine to see live scores.</p>
        ) : (
          <div className="space-y-2.5">
            {merged.map((agent: any) => (
              <div key={agent.name}>
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-xs text-muted-foreground w-36 shrink-0 truncate">{agent.name}</span>
                  <Progress value={agent.liveScore} className="flex-1 h-1.5" />
                  <span className={`text-xs font-mono font-medium w-9 text-right shrink-0 ${scoreColor(agent.liveScore)}`}>
                    {Math.round(agent.liveScore)}
                  </span>
                  {agent.accuracy !== null ? (
                    <span className={`text-[10px] font-mono w-10 text-right shrink-0 ${agent.accuracy > 55 ? "text-green-400" : agent.accuracy > 45 ? "text-yellow-400" : "text-red-400"}`}>
                      {agent.accuracy}%✓
                    </span>
                  ) : (
                    <span className="text-[10px] text-muted-foreground w-10 text-right shrink-0">—</span>
                  )}
                </div>
                <p className="text-[9px] text-muted-foreground ml-[9.5rem] leading-tight">
                  {AGENT_DESCRIPTIONS[agent.name] ?? ""}
                  {agent.samples > 0 && (
                    <span className="ml-1 text-primary/60">{agent.samples} samples · {agent.weight}× weight</span>
                  )}
                </p>
              </div>
            ))}
          </div>
        )}
        <p className="text-[10px] text-muted-foreground mt-3 pt-2 border-t border-border">
          Live score = current market quality (0–100). Accuracy% = how often the agent correctly predicted trade outcome. Dynamic weight = how much influence this agent has in future decisions.
        </p>
      </CardContent>
    </Card>
  );
}

// ── Section: Top findings ─────────────────────────────────────────────────────

function TopFindings({ findings, loading }: { findings: Array<{ finding: string; count: number }>; loading: boolean }) {
  if (loading) {
    return (
      <Card className="bg-card border-border">
        <CardHeader className="pb-3"><CardTitle className="text-sm font-semibold flex items-center gap-2"><Lightbulb className="w-4 h-4 text-yellow-400" /> Recurring Patterns Found</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground animate-pulse">Loading patterns…</p></CardContent>
      </Card>
    );
  }

  if (!findings || findings.length === 0) {
    return (
      <Card className="bg-card border-border">
        <CardHeader className="pb-3"><CardTitle className="text-sm font-semibold flex items-center gap-2"><Lightbulb className="w-4 h-4 text-yellow-400" /> Recurring Patterns Found</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">No patterns yet — more trades are needed to identify recurring signals.</p></CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Lightbulb className="w-4 h-4 text-yellow-400" />
          Recurring Patterns Found
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {findings.map((f, i) => (
          <div key={i} className="flex items-start gap-3 p-2 rounded bg-secondary/40">
            <span className="text-xs font-mono font-bold text-primary mt-0.5 flex-shrink-0">{f.count}×</span>
            <p className="text-xs text-foreground leading-relaxed">{f.finding}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ── Section: Recent trade reports ────────────────────────────────────────────

function RecentReports({ reports, loading }: { reports: any[]; loading: boolean }) {
  if (loading) {
    return (
      <Card className="bg-card border-border">
        <CardHeader className="pb-3"><CardTitle className="text-sm font-semibold flex items-center gap-2"><Brain className="w-4 h-4 text-primary" /> Recent Trade Analysis</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground animate-pulse">Loading analysis reports…</p></CardContent>
      </Card>
    );
  }

  if (!reports || reports.length === 0) {
    return (
      <Card className="bg-card border-border">
        <CardHeader className="pb-3"><CardTitle className="text-sm font-semibold flex items-center gap-2"><Brain className="w-4 h-4 text-primary" /> Recent Trade Analysis</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">No trade intelligence reports yet — run some trades to generate analysis.</p></CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Brain className="w-4 h-4 text-primary" />
          Recent Trade Analysis ({reports.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {reports.map((r: any) => (
          <div key={r.id} className={`p-3 rounded-lg border ${r.won ? "border-green-500/20 bg-green-500/5" : "border-red-500/20 bg-red-500/5"}`}>
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                {r.won
                  ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
                  : <XCircle    className="w-3.5 h-3.5 text-red-400   flex-shrink-0" />
                }
                <span className="text-xs font-semibold font-mono">
                  {r.symbol} · {r.contractType}{r.barrier != null ? ` @${r.barrier}` : ""}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                {r.couldHaveAvoided && (
                  <Badge variant="outline" className="text-[9px] border-yellow-500/50 text-yellow-400 px-1 py-0">Avoidable</Badge>
                )}
                <Badge variant="outline" className={`text-[9px] px-1 py-0 ${confidenceColor(r.confidenceAssessment)} border-current/30`}>
                  {confidenceLabel(r.confidenceAssessment)}
                </Badge>
                <span className={`text-xs font-mono font-bold ${r.won ? "text-green-400" : "text-red-400"}`}>
                  {r.won ? "+" : ""}{fmt2(Number(r.profit))}
                </span>
              </div>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {r.won ? r.whyWon : r.whyLost}
            </p>
            {r.avoidanceReason && (
              <p className="text-xs text-yellow-400/80 mt-1 leading-relaxed">⚠ {r.avoidanceReason}</p>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ── Section: Missed Opportunities ────────────────────────────────────────────

function MissedOpportunities({ summary, records, loading }: { summary: any; records: any[]; loading: boolean }) {
  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-yellow-400" />
            Missed Opportunity Analysis
            {loading && <Activity className="w-3 h-3 animate-spin text-muted-foreground ml-1" />}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading && !summary ? (
            <p className="text-sm text-muted-foreground animate-pulse">Loading missed opportunity data…</p>
          ) : (
            <>
              {/* Stats row */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: "Correct Rejections", value: pct(summary?.correctRejectionRate), color: "text-green-400" },
                  { label: "Too Strict",          value: pct(summary?.strictFilterRate),     color: "text-yellow-400" },
                  { label: "Would've Won",         value: pct(summary?.wouldHaveWonRate),     color: "text-primary" },
                ].map(stat => (
                  <div key={stat.label} className="text-center">
                    <p className={`text-xl font-bold font-mono ${stat.color}`}>{stat.value}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight">{stat.label}</p>
                  </div>
                ))}
              </div>

              {summary?.totalTracked === 0 && (
                <p className="text-xs text-muted-foreground italic">
                  No rejected trades tracked yet. When the engine rejects a trade, it monitors the outcome and reports here.
                </p>
              )}

              {/* Top blocking filters */}
              {summary?.topBlockingFilters?.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Top Blocking Filters</p>
                  <div className="space-y-1.5">
                    {summary.topBlockingFilters.slice(0, 5).map((f: any, i: number) => (
                      <div key={i} className="flex items-center gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-foreground truncate">{f.filter}</p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {f.tooStrictCount > 0 && (
                            <span className="text-[9px] text-yellow-400 font-mono">{f.tooStrictCount} too strict</span>
                          )}
                          <Badge variant="outline" className="text-[9px] px-1 py-0">{f.count}×</Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Recent missed */}
              {records && records.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                    Recent Rejected Trades ({records.length})
                  </p>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {records.slice(0, 10).map((r: any) => (
                      <div key={r.id} className="flex items-center gap-2 p-2 rounded bg-secondary/40">
                        <div className="flex-1 min-w-0">
                          <span className="text-xs font-mono">{r.symbol} · {r.contractType}{r.barrier != null ? ` @${r.barrier}` : ""}</span>
                          {r.evaluatedAt && (
                            <span className={`ml-2 text-[10px] font-medium ${r.wouldHaveWon ? "text-yellow-400" : "text-green-400"}`}>
                              {r.wouldHaveWon ? "Would've WON" : "Would've LOST"}
                            </span>
                          )}
                          {!r.evaluatedAt && (
                            <span className="ml-2 text-[10px] text-muted-foreground">Pending evaluation…</span>
                          )}
                        </div>
                        <span className="text-[10px] text-muted-foreground truncate max-w-[120px]">{r.rejectReason?.slice(0, 40)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Section: Adaptive Thresholds ─────────────────────────────────────────────

function AdaptiveThresholds({ status, loading }: { status: any; loading: boolean }) {
  if (loading && !status) {
    return (
      <Card className="bg-card border-border">
        <CardHeader className="pb-3"><CardTitle className="text-sm font-semibold flex items-center gap-2"><Zap className="w-4 h-4 text-primary" /> Dynamic Confidence Engine</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground animate-pulse">Loading thresholds…</p></CardContent>
      </Card>
    );
  }
  if (!status) return null;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Zap className="w-4 h-4 text-primary" />
          Dynamic Confidence Engine
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Confidence Threshold", value: fmt2(status.confidenceThreshold), unit: "pts" },
            { label: "EV Threshold",          value: `${(Number(status.evThreshold) * 100).toFixed(1)}`, unit: "%" },
            { label: "Recent Win Rate",       value: status.recentWinRate != null ? `${status.recentWinRate}` : "—", unit: status.recentWinRate != null ? "%" : "" },
          ].map(t => (
            <div key={t.label} className="text-center">
              <p className="text-lg font-bold font-mono text-primary">{t.value}<span className="text-xs text-muted-foreground ml-0.5">{t.unit}</span></p>
              <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight">{t.label}</p>
            </div>
          ))}
        </div>

        <div className="text-xs text-muted-foreground flex items-center gap-1">
          <Activity className="w-3 h-3" />
          <span>{status.tradesAnalyzed} trades analyzed · {status.recentSampleSize} in recent window</span>
        </div>

        {status.agentStats && status.agentStats.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Agent Prediction Accuracy</p>
            <div className="space-y-1.5">
              {status.agentStats
                .filter((a: any) => a.samples > 0)
                .sort((a: any, b: any) => b.accuracy - a.accuracy)
                .map((agent: any) => (
                  <div key={agent.agentId} className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-36 flex-shrink-0 truncate capitalize">
                      {agent.agentId.replace(/([A-Z])/g, " $1").trim()}
                    </span>
                    <Progress value={agent.accuracy} className="flex-1 h-1.5" />
                    <span className={`text-xs font-mono font-medium w-10 text-right flex-shrink-0 ${agent.accuracy > 55 ? "text-green-400" : agent.accuracy > 45 ? "text-yellow-400" : "text-red-400"}`}>
                      {agent.accuracy}%
                    </span>
                    <span className="text-[10px] text-muted-foreground w-12 text-right flex-shrink-0">
                      {agent.dynamicWeight}×
                    </span>
                  </div>
                ))}
            </div>
          </div>
        )}

        {status.tradesAnalyzed < 10 && (
          <p className="text-xs text-muted-foreground italic">
            Dynamic weights activate after 5+ predictions per agent. Currently using base weights.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Section: Confidence calibration chart ────────────────────────────────────

function ConfidenceBreakdown({ summary, loading }: { summary: any; loading: boolean }) {
  if (loading && !summary) return null;
  if (!summary || summary.totalAnalyzed === 0) return null;

  const bars = [
    { label: "Appropriate",   value: summary.appropriateConfidenceRate, color: "bg-green-500" },
    { label: "Overconfident", value: summary.overconfidentRate,          color: "bg-red-500" },
    { label: "Underconfident",value: summary.underconfidentRate,          color: "bg-yellow-500" },
  ];

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-primary" />
          Confidence Calibration
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {bars.map(bar => (
          <div key={bar.label} className="space-y-1">
            <div className="flex justify-between items-center">
              <span className="text-xs text-muted-foreground">{bar.label}</span>
              <span className="text-xs font-mono font-semibold">{bar.value}%</span>
            </div>
            <div className="w-full bg-secondary rounded-full h-1.5">
              <div className={`${bar.color} h-1.5 rounded-full transition-all duration-500`} style={{ width: `${bar.value}%` }} />
            </div>
          </div>
        ))}
        <div className="pt-1 border-t border-border">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Avg agent agreement</span>
            <span className="font-mono font-semibold text-foreground">{summary.avgAgentAgreement}/100</span>
          </div>
          <div className="flex justify-between text-xs text-muted-foreground mt-1">
            <span>Timing issues</span>
            <span className="font-mono font-semibold text-foreground">{summary.timingIssueRate}%</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Learning data flow card ───────────────────────────────────────────────────

function LearningDataFlow({ tradesAnalyzed }: { tradesAnalyzed: number }) {
  const steps = [
    { label: "Trade executes", detail: "Manual or autonomous engine", done: true },
    { label: "13-agent output recorded", detail: "Scores, confidence, reasoning captured", done: true },
    { label: "Intelligence analysis runs", detail: "Why won/lost, avoidability, confidence calibration", done: true },
    { label: "Dynamic weights updated", detail: "Agents that predicted correctly get more influence", done: tradesAnalyzed >= 5 },
    { label: "Confidence threshold adapts", detail: "Auto-tightens when losing, relaxes when winning", done: tradesAnalyzed >= 10 },
  ];

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-green-400" />
          Learning Data Flow
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {steps.map((step, i) => (
          <div key={i} className="flex items-start gap-2.5">
            <div className={`mt-0.5 w-4 h-4 rounded-full flex-shrink-0 flex items-center justify-center text-[9px] font-bold ${step.done ? "bg-green-500/20 text-green-400" : "bg-secondary text-muted-foreground"}`}>
              {step.done ? "✓" : i + 1}
            </div>
            <div>
              <p className={`text-xs font-medium ${step.done ? "text-foreground" : "text-muted-foreground"}`}>{step.label}</p>
              <p className="text-[10px] text-muted-foreground">{step.detail}</p>
            </div>
          </div>
        ))}
        <div className="pt-2 border-t border-border">
          <p className="text-[10px] text-muted-foreground">
            {tradesAnalyzed === 0
              ? "Start trading to begin the learning cycle."
              : `${tradesAnalyzed} trades analyzed. ${tradesAnalyzed < 5 ? `${5 - tradesAnalyzed} more needed for dynamic weights.` : "Dynamic weights active."}`}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Intelligence() {
  const { data: summaryData,    isLoading: summaryLoading }    = useIntelligenceSummary();
  const { data: reportsData,    isLoading: reportsLoading }    = useRecentReports();
  const { data: missedData,     isLoading: missedLoading }     = useRecentMissed();
  const { data: thresholdsData, isLoading: thresholdsLoading } = useThresholds();
  const { data: engineData }                                    = useEngineStatus();

  const summary        = summaryData?.summary;
  const missedSummary  = summaryData?.missedSummary;
  const dynamicStatus  = summaryData?.dynamicStatus ?? thresholdsData;
  const reports        = Array.isArray(reportsData) ? reportsData : [];
  const missed         = Array.isArray(missedData)  ? missedData  : [];
  const tradesAnalyzed = dynamicStatus?.tradesAnalyzed ?? 0;

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Brain className="w-6 h-6 text-primary" />
          Trade Intelligence
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Self-learning AI — all 13 agents feed outcomes back into this system after every trade
        </p>
      </div>

      {/* Overview KPI row — always visible once summary loads */}
      {(summaryLoading && !summaryData) ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[1,2,3,4].map(i => (
            <Card key={i} className="bg-card border-border animate-pulse">
              <CardContent className="p-4 h-20" />
            </Card>
          ))}
        </div>
      ) : (
        <OverviewCards summary={summary} missed={missedSummary} />
      )}

      {/* Main grid — each column loads independently */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: recent reports + findings */}
        <div className="lg:col-span-2 space-y-6">
          <RecentReports reports={reports} loading={reportsLoading} />
          <TopFindings findings={summary?.topFindings ?? []} loading={summaryLoading && !summaryData} />
        </div>

        {/* Right: adaptive engine + calibration + learning flow */}
        <div className="space-y-6">
          <AdaptiveThresholds status={dynamicStatus} loading={thresholdsLoading && !thresholdsData} />
          <ConfidenceBreakdown summary={summary} loading={summaryLoading && !summaryData} />
          <LearningDataFlow tradesAnalyzed={tradesAnalyzed} />
        </div>
      </div>

      {/* Full-width: 13-agent live status */}
      <AgentLiveStatus engineStatus={engineData} dynamicStatus={dynamicStatus} />

      {/* Full-width: missed opportunities */}
      <MissedOpportunities summary={missedSummary} records={missed} loading={missedLoading} />
    </div>
  );
}
