import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Brain, Target, AlertTriangle, CheckCircle2, XCircle,
  Lightbulb, Activity, BarChart3, Shield, Zap, Cpu,
  TrendingUp, TrendingDown, ArrowRight,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";

// ── Data hooks ────────────────────────────────────────────────────────────────

function useIntelligenceSummary() {
  return useQuery({
    queryKey: ["intelligence-summary"],
    queryFn: () => fetch("/api/ai/intelligence/summary").then(r => r.json()),
    refetchInterval: 15_000, staleTime: 8_000, refetchOnWindowFocus: true,
  });
}

function useRecentReports() {
  return useQuery({
    queryKey: ["intelligence-reports-5"],
    queryFn: () => fetch("/api/ai/intelligence/reports?limit=5").then(r => r.json()),
    refetchInterval: 15_000, staleTime: 8_000, refetchOnWindowFocus: true,
  });
}

function useRecentMissed() {
  return useQuery({
    queryKey: ["intelligence-missed"],
    queryFn: () => fetch("/api/ai/intelligence/missed?limit=8").then(r => r.json()),
    refetchInterval: 15_000, staleTime: 8_000, refetchOnWindowFocus: true,
  });
}

function useThresholds() {
  return useQuery({
    queryKey: ["intelligence-thresholds"],
    queryFn: () => fetch("/api/ai/intelligence/thresholds").then(r => r.json()),
    refetchInterval: 10_000, staleTime: 5_000, refetchOnWindowFocus: true,
  });
}

function useEngineStatus() {
  return useQuery({
    queryKey: ["engine-status-intel"],
    queryFn: () => fetch("/api/ai/engine/status").then(r => r.json()),
    refetchInterval: 10_000, staleTime: 5_000, refetchOnWindowFocus: true,
  });
}

// ── Constants ─────────────────────────────────────────────────────────────────

const AGENT_NAME_TO_KEY: Record<string, string> = {
  "Market Scanner":        "marketScanner",
  "Tick Intelligence":     "tickIntelligence",
  "Digit Probability":     "digitProbability",
  "Rise/Fall Model":       "riseFallAgent",
  "Market Regime":         "marketRegime",
  "Execution Timing":      "executionTiming",
  "Confidence Fusion":     "confidenceFusion",
  "Recovery Intelligence": "recoveryIntelligence",
  "Risk Intelligence":     "riskIntelligence",
  "Portfolio Manager":     "portfolioManager",
  "Learning Agent":        "learningAgent",
  "Pattern Discovery":     "patternDiscovery",
  "Trade Explainability":  "tradeExplainability",
};

const AGENT_SHORT: Record<string, string> = {
  "Market Scanner":        "Scanner",
  "Tick Intelligence":     "Ticks",
  "Digit Probability":     "Digits",
  "Rise/Fall Model":       "Rise/Fall",
  "Market Regime":         "Regime",
  "Execution Timing":      "Timing",
  "Confidence Fusion":     "Fusion",
  "Recovery Intelligence": "Recovery",
  "Risk Intelligence":     "Risk",
  "Portfolio Manager":     "Portfolio",
  "Learning Agent":        "Learning",
  "Pattern Discovery":     "Patterns",
  "Trade Explainability":  "Explainer",
};

const AGENT_ICON_COLORS: Record<string, string> = {
  "Market Scanner":        "#06b6d4",
  "Tick Intelligence":     "#8b5cf6",
  "Digit Probability":     "#f59e0b",
  "Rise/Fall Model":       "#10b981",
  "Market Regime":         "#3b82f6",
  "Execution Timing":      "#ec4899",
  "Confidence Fusion":     "hsl(var(--primary))",
  "Recovery Intelligence": "#ef4444",
  "Risk Intelligence":     "#f97316",
  "Portfolio Manager":     "#14b8a6",
  "Learning Agent":        "#a855f7",
  "Pattern Discovery":     "#eab308",
  "Trade Explainability":  "#64748b",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function pct(n: number | null | undefined) {
  return n == null ? "—" : `${Math.round(n)}%`;
}
function fmt2(n: number) {
  return isNaN(n) ? "0.00" : n.toFixed(2);
}
function scoreGrade(s: number): { ring: string; text: string; bg: string } {
  if (s >= 70) return { ring: "border-green-500/40",  text: "text-green-400",  bg: "bg-green-500" };
  if (s >= 50) return { ring: "border-yellow-500/40", text: "text-yellow-400", bg: "bg-yellow-500" };
  return           { ring: "border-red-500/40",    text: "text-red-400",    bg: "bg-red-500" };
}
function confLabel(a: string) {
  if (a === "too_high") return { text: "Overconfident",  cls: "border-red-500/40 text-red-400" };
  if (a === "too_low")  return { text: "Underconfident", cls: "border-yellow-500/40 text-yellow-400" };
  return                       { text: "Calibrated",     cls: "border-green-500/40 text-green-400" };
}

// ── KPI bar ───────────────────────────────────────────────────────────────────

function KpiBar({ summary, missed }: { summary: any; missed: any }) {
  const kpis = [
    {
      icon: Brain,
      label: "Analyzed",
      value: summary?.totalAnalyzed ?? 0,
      sub: summary?.totalAnalyzed > 0 ? `${summary.winsAnalyzed}W · ${summary.lossesAnalyzed}L` : "No data yet",
      color: "text-primary",
      accent: "from-primary/20",
    },
    {
      icon: Shield,
      label: "Avoidable Losses",
      value: summary?.totalAnalyzed > 0 ? `${summary.avoidableLossRate}%` : "—",
      sub: `${summary?.avoidableLosses ?? 0} of ${summary?.lossesAnalyzed ?? 0} losses`,
      color: (summary?.avoidableLossRate ?? 0) > 30 ? "text-red-400" : "text-green-400",
      accent: "from-green-500/10",
    },
    {
      icon: Target,
      label: "Confidence Accuracy",
      value: summary?.totalAnalyzed > 0 ? `${summary.appropriateConfidenceRate}%` : "—",
      sub: "Properly calibrated trades",
      color: (summary?.appropriateConfidenceRate ?? 0) > 65 ? "text-green-400" : "text-yellow-400",
      accent: "from-yellow-500/10",
    },
    {
      icon: AlertTriangle,
      label: "Rejected Win Rate",
      value: missed?.evaluated > 0 ? `${missed.wouldHaveWonRate}%` : "—",
      sub: `${missed?.wouldHaveWon ?? 0} of ${missed?.evaluated ?? 0} evaluated`,
      color: (missed?.wouldHaveWonRate ?? 0) > 50 ? "text-yellow-400" : "text-green-400",
      accent: "from-yellow-500/10",
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {kpis.map((k, i) => (
        <motion.div
          key={k.label}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.05 }}
        >
          <Card className={`bg-gradient-to-br ${k.accent} to-card border-border overflow-hidden`}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">{k.label}</p>
                  <p className={`text-2xl font-bold font-mono ${k.color}`}>{k.value}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">{k.sub}</p>
                </div>
                <div className={`p-2 rounded-lg bg-card/60`}>
                  <k.icon className={`w-4 h-4 ${k.color}`} />
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      ))}
    </div>
  );
}

// ── Agent tile grid ───────────────────────────────────────────────────────────

function AgentGrid({ engineStatus, dynamicStatus }: { engineStatus: any; dynamicStatus: any }) {
  const statuses: any[] = engineStatus?.agentStatuses ?? [];
  const accList: any[]  = dynamicStatus?.agentStats   ?? [];

  if (statuses.length === 0) {
    return (
      <Card className="bg-card border-border h-full">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Cpu className="w-4 h-4 text-primary" />
            13 Agents · Live Intelligence
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-center py-12">
          <div className="text-center">
            <Cpu className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-xs text-muted-foreground">
              Engine not running — start the autonomous engine to see live agent scores.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const merged = statuses.map((a: any) => {
    const key = AGENT_NAME_TO_KEY[a.name as string];
    const acc = key ? (accList.find((x: any) => x.agentId === key) ?? null) : null;
    const isMeta = a.name === "Confidence Fusion" || a.name === "Trade Explainability";
    const color = AGENT_ICON_COLORS[a.name] ?? "#71717a";
    const grade = scoreGrade(a.confidence);
    return { name: a.name, short: AGENT_SHORT[a.name] ?? a.name, score: a.confidence, accuracy: acc?.accuracy ?? null, samples: acc?.samples ?? 0, weight: acc?.dynamicWeight ?? 1.0, isMeta, color, grade };
  });

  return (
    <Card className="bg-card border-border h-full">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Cpu className="w-4 h-4 text-primary" />
            13 Agents · Live Intelligence
          </CardTitle>
          <span className="text-[10px] text-muted-foreground">Score · Accuracy · Weight</span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
          {merged.map((agent, i) => (
            <motion.div
              key={agent.name}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: i * 0.03 }}
              className={`relative rounded-xl border p-3 ${agent.grade.ring} bg-secondary/20 overflow-hidden`}
            >
              {/* colour accent strip */}
              <div
                className="absolute top-0 left-0 right-0 h-0.5 rounded-t-xl"
                style={{ backgroundColor: agent.color }}
              />

              <div className="flex items-start justify-between mb-2 mt-0.5">
                <div>
                  <p className="text-[10px] text-muted-foreground font-medium leading-tight">{agent.short}</p>
                  {agent.isMeta && (
                    <span className="text-[8px] text-muted-foreground/60 uppercase tracking-wider">meta</span>
                  )}
                </div>
                <span className={`text-lg font-mono font-bold leading-none ${agent.grade.text}`}>
                  {Math.round(agent.score)}
                </span>
              </div>

              {/* Score bar */}
              <div className="w-full h-1 bg-secondary rounded-full overflow-hidden mb-2">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${agent.grade.bg}`}
                  style={{ width: `${agent.score}%` }}
                />
              </div>

              {/* Accuracy + weight */}
              <div className="flex items-center justify-between">
                {agent.accuracy !== null ? (
                  <span className={`text-[10px] font-mono ${agent.accuracy > 55 ? "text-green-400" : agent.accuracy > 45 ? "text-yellow-400" : "text-red-400"}`}>
                    {agent.accuracy}% ✓
                  </span>
                ) : (
                  <span className="text-[10px] text-muted-foreground/50">—</span>
                )}
                {agent.samples > 0 && (
                  <span className="text-[9px] text-muted-foreground">{agent.weight}×</span>
                )}
              </div>
            </motion.div>
          ))}
        </div>

        <p className="text-[10px] text-muted-foreground mt-3 pt-2.5 border-t border-border/60 flex items-center gap-1.5">
          <Activity className="w-3 h-3" />
          Score = current market quality (0–100) · Accuracy = correct outcome predictions · Weight = adaptive influence
        </p>
      </CardContent>
    </Card>
  );
}

// ── Confidence engine panel ───────────────────────────────────────────────────

function EnginePanel({ status, summary, loading }: { status: any; summary: any; loading: boolean }) {
  if (loading && !status) {
    return (
      <Card className="bg-card border-border h-full">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Zap className="w-4 h-4 text-primary" /> Confidence Engine
          </CardTitle>
        </CardHeader>
        <CardContent><p className="text-xs text-muted-foreground animate-pulse">Loading…</p></CardContent>
      </Card>
    );
  }

  const calBars = summary ? [
    { label: "Calibrated",    value: summary.appropriateConfidenceRate ?? 0, color: "bg-green-500" },
    { label: "Overconfident", value: summary.overconfidentRate ?? 0,          color: "bg-red-500" },
    { label: "Under",         value: summary.underconfidentRate ?? 0,          color: "bg-yellow-500" },
  ] : [];

  return (
    <Card className="bg-card border-border h-full">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Zap className="w-4 h-4 text-primary" />
          Confidence Engine
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">

        {/* Threshold trio */}
        {status && (
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              { label: "Min Score",  value: fmt2(status.confidenceThreshold), unit: "pts" },
              { label: "Min EV",     value: `${(Number(status.evThreshold) * 100).toFixed(1)}`, unit: "%" },
              { label: "Win Rate",   value: status.recentWinRate != null ? `${status.recentWinRate}` : "—", unit: status.recentWinRate != null ? "%" : "" },
            ].map(t => (
              <div key={t.label} className="rounded-lg bg-secondary/40 py-2.5 px-1">
                <p className="text-base font-bold font-mono text-primary leading-none">
                  {t.value}<span className="text-[9px] text-muted-foreground ml-0.5">{t.unit}</span>
                </p>
                <p className="text-[9px] text-muted-foreground mt-1 leading-tight">{t.label}</p>
              </div>
            ))}
          </div>
        )}

        {status && (
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Activity className="w-3 h-3 shrink-0" />
            {status.tradesAnalyzed} analyzed · {status.recentSampleSize} recent
          </div>
        )}

        {/* Calibration bars */}
        {calBars.length > 0 && (
          <div className="space-y-2">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-1.5">
              <BarChart3 className="w-3 h-3" /> Calibration
            </p>
            {calBars.map(b => (
              <div key={b.label}>
                <div className="flex justify-between text-[10px] mb-0.5">
                  <span className="text-muted-foreground">{b.label}</span>
                  <span className="font-mono font-semibold">{b.value}%</span>
                </div>
                <div className="h-1 w-full bg-secondary rounded-full overflow-hidden">
                  <div className={`${b.color} h-full rounded-full transition-all duration-500`} style={{ width: `${b.value}%` }} />
                </div>
              </div>
            ))}
            {summary && (
              <div className="flex justify-between text-[10px] text-muted-foreground pt-1 border-t border-border/60">
                <span>Avg agreement</span>
                <span className="font-mono font-semibold text-foreground">{summary.avgAgentAgreement}/100</span>
              </div>
            )}
          </div>
        )}

        {/* Agent accuracy (compact — top 6 only) */}
        {status?.agentStats?.filter((a: any) => a.samples > 0).length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Top Agent Accuracy</p>
            {status.agentStats
              .filter((a: any) => a.samples > 0)
              .sort((a: any, b: any) => b.accuracy - a.accuracy)
              .slice(0, 6)
              .map((agent: any) => (
                <div key={agent.agentId} className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground w-24 shrink-0 truncate">
                    {agent.agentId.replace(/([A-Z])/g, " $1").trim()}
                  </span>
                  <Progress value={agent.accuracy} className="flex-1 h-1" />
                  <span className={`text-[10px] font-mono w-8 text-right shrink-0 ${agent.accuracy > 55 ? "text-green-400" : agent.accuracy > 45 ? "text-yellow-400" : "text-red-400"}`}>
                    {agent.accuracy}%
                  </span>
                </div>
              ))}
          </div>
        )}

        {status?.tradesAnalyzed < 10 && (
          <p className="text-[10px] text-muted-foreground italic">
            Dynamic weights activate after 5+ predictions per agent.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Recent trades (5) ─────────────────────────────────────────────────────────

function RecentTrades({ reports, loading }: { reports: any[]; loading: boolean }) {
  return (
    <Card className="bg-card border-border h-full">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Brain className="w-4 h-4 text-primary" />
          Last 5 Trades
          {loading && !reports.length && <Activity className="w-3 h-3 animate-spin text-muted-foreground" />}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!reports.length ? (
          <div className="flex flex-col items-center justify-center py-8 gap-2">
            <Brain className="w-7 h-7 text-muted-foreground/25" />
            <p className="text-xs text-muted-foreground text-center">
              {loading ? "Loading…" : "No trade intelligence yet — run some trades."}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {reports.slice(0, 5).map((r: any, i: number) => {
              const conf = confLabel(r.confidenceAssessment ?? "");
              const profit = Number(r.profit);
              return (
                <motion.div
                  key={r.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.04 }}
                  className={`rounded-lg border p-3 ${r.won ? "border-green-500/20 bg-green-500/5" : "border-red-500/20 bg-red-500/5"}`}
                >
                  {/* Top row */}
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {r.won
                        ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" />
                        : <XCircle      className="w-3.5 h-3.5 text-red-400   shrink-0" />
                      }
                      <span className="text-xs font-mono font-semibold truncate">
                        {r.symbol} · {r.contractType}{r.barrier != null ? ` @${r.barrier}` : ""}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0 ml-2">
                      {r.couldHaveAvoided && (
                        <Badge variant="outline" className="text-[8px] border-yellow-500/40 text-yellow-400 px-1 py-0 h-4">Avoidable</Badge>
                      )}
                      <Badge variant="outline" className={`text-[8px] px-1 py-0 h-4 ${conf.cls}`}>
                        {conf.text}
                      </Badge>
                      <span className={`text-xs font-mono font-bold ${r.won ? "text-green-400" : "text-red-400"}`}>
                        {r.won ? "+" : ""}{fmt2(profit)}
                      </span>
                    </div>
                  </div>

                  {/* Reason */}
                  <p className="text-[11px] text-muted-foreground leading-snug line-clamp-2">
                    {r.won ? r.whyWon : r.whyLost}
                  </p>
                  {r.avoidanceReason && (
                    <p className="text-[10px] text-yellow-400/80 mt-0.5 leading-snug line-clamp-1">⚠ {r.avoidanceReason}</p>
                  )}
                </motion.div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Top findings ──────────────────────────────────────────────────────────────

function TopFindings({ findings, loading }: { findings: any[]; loading: boolean }) {
  return (
    <Card className="bg-card border-border h-full">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Lightbulb className="w-4 h-4 text-yellow-400" />
          Recurring Patterns
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading && !findings.length ? (
          <p className="text-xs text-muted-foreground animate-pulse">Detecting patterns…</p>
        ) : findings.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 gap-2">
            <Lightbulb className="w-7 h-7 text-muted-foreground/25" />
            <p className="text-xs text-muted-foreground text-center">
              Patterns emerge after more trades are analyzed.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {findings.slice(0, 6).map((f: any, i: number) => (
              <motion.div
                key={i}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: i * 0.05 }}
                className="flex items-start gap-2.5 p-2.5 rounded-lg bg-secondary/30"
              >
                <span className="text-xs font-mono font-bold text-primary shrink-0 mt-0.5 w-5 text-right">{f.count}×</span>
                <p className="text-xs text-foreground leading-relaxed">{f.finding}</p>
              </motion.div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Missed opportunities (compact) ────────────────────────────────────────────

function MissedCompact({ summary, records, loading }: { summary: any; records: any[]; loading: boolean }) {
  return (
    <Card className="bg-card border-border h-full">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-yellow-400" />
          Rejected Trades
          {loading && <Activity className="w-3 h-3 animate-spin text-muted-foreground" />}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">

        {/* Stat trio */}
        <div className="grid grid-cols-3 gap-2 text-center">
          {[
            { label: "Correct", value: pct(summary?.correctRejectionRate), color: "text-green-400" },
            { label: "Too Strict", value: pct(summary?.strictFilterRate),  color: "text-yellow-400" },
            { label: "Won Rate",  value: pct(summary?.wouldHaveWonRate),   color: "text-primary" },
          ].map(s => (
            <div key={s.label} className="rounded-lg bg-secondary/40 py-2.5 px-1">
              <p className={`text-base font-bold font-mono leading-none ${s.color}`}>{s.value}</p>
              <p className="text-[9px] text-muted-foreground mt-1 leading-tight">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Empty hint */}
        {(!summary || summary.totalTracked === 0) && (
          <div className="flex flex-col items-center justify-center py-4 gap-1.5">
            <Shield className="w-6 h-6 text-muted-foreground/25" />
            <p className="text-[11px] text-muted-foreground text-center">
              Rejected trades appear here once the engine starts filtering.
            </p>
          </div>
        )}

        {/* Top blocking filters */}
        {summary?.topBlockingFilters?.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Top Filters</p>
            {summary.topBlockingFilters.slice(0, 4).map((f: any, i: number) => (
              <div key={i} className="flex items-center gap-2">
                <p className="text-[10px] text-foreground flex-1 truncate">{f.filter}</p>
                <div className="flex items-center gap-1.5 shrink-0">
                  {f.tooStrictCount > 0 && (
                    <span className="text-[9px] text-yellow-400">{f.tooStrictCount}×⚠</span>
                  )}
                  <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">{f.count}</Badge>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Recent rejected trades */}
        {records && records.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Recent</p>
            {records.slice(0, 5).map((r: any) => (
              <div key={r.id} className="flex items-center gap-2 py-1 border-b border-border/40 last:border-0">
                <div className="flex-1 min-w-0">
                  <span className="text-[10px] font-mono">{r.symbol} · {r.contractType}{r.barrier != null ? ` @${r.barrier}` : ""}</span>
                </div>
                {r.evaluatedAt ? (
                  <span className={`text-[9px] font-semibold shrink-0 ${r.wouldHaveWon ? "text-yellow-400" : "text-green-400"}`}>
                    {r.wouldHaveWon ? "W↑" : "L↓"}
                  </span>
                ) : (
                  <span className="text-[9px] text-muted-foreground shrink-0">…</span>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Learning pipeline strip ───────────────────────────────────────────────────

function LearningPipeline({ tradesAnalyzed }: { tradesAnalyzed: number }) {
  const steps = [
    { icon: TrendingUp,  label: "Trade executes",           detail: "Manual or autonomous",              done: true },
    { icon: Cpu,         label: "13 agents score",          detail: "Confidence, EV, regime captured",   done: true },
    { icon: Brain,       label: "Intelligence analysis",    detail: "Why won/lost, calibration check",   done: true },
    { icon: BarChart3,   label: "Dynamic weights update",   detail: "Accurate agents gain influence",    done: tradesAnalyzed >= 5 },
    { icon: Zap,         label: "Threshold adapts",         detail: "Tightens on losses, relaxes on wins", done: tradesAnalyzed >= 10 },
  ];

  return (
    <Card className="bg-card border-border">
      <CardContent className="p-4">
        <div className="flex items-center gap-1 mb-3">
          <TrendingUp className="w-3.5 h-3.5 text-green-400" />
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium ml-1">
            Self-Learning Pipeline
          </span>
          <span className="ml-auto text-[10px] text-muted-foreground">
            {tradesAnalyzed === 0
              ? "Waiting for first trade"
              : `${tradesAnalyzed} trades analyzed · ${tradesAnalyzed >= 10 ? "All stages active" : tradesAnalyzed >= 5 ? "Stage 4 active" : "Stages 1–3 active"}`}
          </span>
        </div>
        <div className="flex items-stretch gap-0">
          {steps.map((step, i) => (
            <div key={i} className="flex items-stretch flex-1 min-w-0">
              {/* Step card */}
              <div className={`flex-1 rounded-lg p-2.5 flex flex-col items-center text-center gap-1.5 border transition-colors ${
                step.done
                  ? "border-green-500/30 bg-green-500/5"
                  : "border-border bg-secondary/20"
              }`}>
                <div className={`w-7 h-7 rounded-full flex items-center justify-center ${
                  step.done ? "bg-green-500/20" : "bg-secondary"
                }`}>
                  <step.icon className={`w-3.5 h-3.5 ${step.done ? "text-green-400" : "text-muted-foreground"}`} />
                </div>
                <p className={`text-[10px] font-semibold leading-tight ${step.done ? "text-foreground" : "text-muted-foreground"}`}>
                  {step.label}
                </p>
                <p className="text-[9px] text-muted-foreground leading-tight hidden sm:block">{step.detail}</p>
              </div>
              {/* Connector arrow */}
              {i < steps.length - 1 && (
                <div className="flex items-center px-1 shrink-0">
                  <ArrowRight className={`w-3 h-3 ${step.done ? "text-green-500/50" : "text-muted-foreground/30"}`} />
                </div>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Intelligence() {
  const { data: summaryData,    isLoading: summaryLoading }    = useIntelligenceSummary();
  const { data: reportsData,    isLoading: reportsLoading }    = useRecentReports();
  const { data: missedData,     isLoading: missedLoading }     = useRecentMissed();
  const { data: thresholdsData, isLoading: thresholdsLoading } = useThresholds();
  const { data: engineData }                                    = useEngineStatus();

  const summary       = summaryData?.summary;
  const missedSummary = summaryData?.missedSummary;
  const dynamicStatus = summaryData?.dynamicStatus ?? thresholdsData;
  const reports       = Array.isArray(reportsData) ? reportsData : [];
  const missed        = Array.isArray(missedData)  ? missedData  : [];
  const tradesAnalyzed = dynamicStatus?.tradesAnalyzed ?? 0;

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-5">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2.5">
            <Brain className="w-6 h-6 text-primary" />
            Trade Intelligence
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Self-learning AI — 13 agents adapt after every trade
          </p>
        </div>
        {tradesAnalyzed > 0 && (
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Analyzed</p>
            <p className="text-2xl font-mono font-bold text-primary">{tradesAnalyzed}</p>
          </div>
        )}
      </div>

      {/* ── KPI bar ────────────────────────────────────────────────────── */}
      {summaryLoading && !summaryData ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[1,2,3,4].map(i => (
            <Card key={i} className="bg-card border-border animate-pulse">
              <CardContent className="p-4 h-[88px]" />
            </Card>
          ))}
        </div>
      ) : (
        <KpiBar summary={summary} missed={missedSummary} />
      )}

      {/* ── Row 2: Agent grid (hero) + Engine panel ─────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2">
          <AgentGrid engineStatus={engineData} dynamicStatus={dynamicStatus} />
        </div>
        <div>
          <EnginePanel
            status={dynamicStatus}
            summary={summary}
            loading={thresholdsLoading && !thresholdsData}
          />
        </div>
      </div>

      {/* ── Row 3: Last 5 trades · Patterns · Rejected trades ──────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <RecentTrades reports={reports} loading={reportsLoading} />
        <TopFindings  findings={summary?.topFindings ?? []} loading={summaryLoading && !summaryData} />
        <MissedCompact summary={missedSummary} records={missed} loading={missedLoading} />
      </div>

      {/* ── Row 4: Learning pipeline (full-width) ──────────────────────── */}
      <LearningPipeline tradesAnalyzed={tradesAnalyzed} />

    </div>
  );
}
