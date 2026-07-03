import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Brain, Target, AlertTriangle, TrendingUp, TrendingDown, CheckCircle2,
  XCircle, Lightbulb, Activity, BarChart3, Shield, Zap, Clock,
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
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

function useRecentReports() {
  return useQuery({
    queryKey: ["intelligence-reports"],
    queryFn: () => fetch("/api/ai/intelligence/reports?limit=10").then(r => r.json()),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

function useRecentMissed() {
  return useQuery({
    queryKey: ["intelligence-missed"],
    queryFn: () => fetch("/api/ai/intelligence/missed?limit=10").then(r => r.json()),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

function useThresholds() {
  return useQuery({
    queryKey: ["intelligence-thresholds"],
    queryFn: () => fetch("/api/ai/intelligence/thresholds").then(r => r.json()),
    refetchInterval: 15_000,
    staleTime: 8_000,
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
  if (assessment === "too_low") return "text-yellow-400";
  return "text-green-400";
}

function confidenceLabel(assessment: string) {
  if (assessment === "too_high") return "Overconfident";
  if (assessment === "too_low") return "Underconfident";
  return "Appropriate";
}

// ── Section: Overview cards ────────────────────────────────────────────────────

function OverviewCards({ summary, missed }: { summary: any; missed: any }) {
  const cards = [
    {
      label: "Trades Analyzed",
      value: summary?.totalAnalyzed ?? 0,
      icon: Brain,
      color: "text-primary",
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
        <motion.div
          key={card.label}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.06 }}
        >
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

// ── Section: Top findings ─────────────────────────────────────────────────────

function TopFindings({ findings }: { findings: Array<{ finding: string; count: number }> }) {
  if (!findings || findings.length === 0) {
    return (
      <Card className="bg-card border-border">
        <CardHeader className="pb-3"><CardTitle className="text-sm font-semibold flex items-center gap-2"><Lightbulb className="w-4 h-4 text-yellow-400" /> Top Findings</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">No findings yet — run some trades to generate intelligence reports.</p></CardContent>
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

function RecentReports({ reports }: { reports: any[] }) {
  if (!reports || reports.length === 0) {
    return (
      <Card className="bg-card border-border">
        <CardHeader className="pb-3"><CardTitle className="text-sm font-semibold flex items-center gap-2"><Brain className="w-4 h-4 text-primary" /> Recent Trade Analysis</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">No trade intelligence reports yet.</p></CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Brain className="w-4 h-4 text-primary" />
          Recent Trade Analysis
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {reports.map((r: any) => (
          <div key={r.id} className={`p-3 rounded-lg border ${r.won ? "border-green-500/20 bg-green-500/5" : "border-red-500/20 bg-red-500/5"}`}>
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                {r.won
                  ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
                  : <XCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
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

function MissedOpportunities({ summary, records }: { summary: any; records: any[] }) {
  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-yellow-400" />
            Missed Opportunity Analysis
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Stats row */}
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "Correct Rejections", value: pct(summary?.correctRejectionRate), color: "text-green-400" },
              { label: "Too Strict", value: pct(summary?.strictFilterRate), color: "text-yellow-400" },
              { label: "Would've Won", value: pct(summary?.wouldHaveWonRate), color: "text-primary" },
            ].map(stat => (
              <div key={stat.label} className="text-center">
                <p className={`text-xl font-bold font-mono ${stat.color}`}>{stat.value}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight">{stat.label}</p>
              </div>
            ))}
          </div>

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
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Recent Rejected Trades</p>
              <div className="space-y-2">
                {records.slice(0, 5).map((r: any) => (
                  <div key={r.id} className="flex items-center gap-2 p-2 rounded bg-secondary/40">
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-mono">{r.symbol} · {r.contractType}{r.barrier != null ? ` @${r.barrier}` : ""}</span>
                      {r.evaluatedAt && (
                        <span className={`ml-2 text-[10px] font-medium ${r.wouldHaveWon ? "text-yellow-400" : "text-green-400"}`}>
                          {r.wouldHaveWon ? "Would've WON" : "Would've LOST"}
                        </span>
                      )}
                    </div>
                    <span className="text-[10px] text-muted-foreground truncate max-w-[120px]">{r.rejectReason?.slice(0, 40)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Section: Adaptive Thresholds ─────────────────────────────────────────────

function AdaptiveThresholds({ status }: { status: any }) {
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
        {/* Current thresholds */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Confidence Threshold", value: fmt2(status.confidenceThreshold), unit: "pts" },
            { label: "EV Threshold", value: `${(Number(status.evThreshold) * 100).toFixed(1)}`, unit: "%" },
            { label: "Recent Win Rate", value: status.recentWinRate != null ? `${status.recentWinRate}` : "—", unit: status.recentWinRate != null ? "%" : "" },
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

        {/* Agent accuracy table */}
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

function ConfidenceBreakdown({ summary }: { summary: any }) {
  if (!summary || summary.totalAnalyzed === 0) return null;

  const bars = [
    { label: "Appropriate", value: summary.appropriateConfidenceRate, color: "bg-green-500" },
    { label: "Overconfident", value: summary.overconfidentRate, color: "bg-red-500" },
    { label: "Underconfident", value: summary.underconfidentRate, color: "bg-yellow-500" },
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

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Intelligence() {
  const { data: summaryData, isLoading: summaryLoading } = useIntelligenceSummary();
  const { data: reportsData, isLoading: reportsLoading } = useRecentReports();
  const { data: missedData, isLoading: missedLoading } = useRecentMissed();
  const { data: thresholdsData } = useThresholds();

  const summary = summaryData?.summary;
  const missedSummary = summaryData?.missedSummary;
  const dynamicStatus = summaryData?.dynamicStatus ?? thresholdsData;
  const reports = Array.isArray(reportsData) ? reportsData : [];
  const missed = Array.isArray(missedData) ? missedData : [];

  const isLoading = summaryLoading || reportsLoading;

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Brain className="w-6 h-6 text-primary" />
          Trade Intelligence
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Self-learning AI analysis — why trades win or lose, missed opportunities, and adaptive thresholds
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
          <Activity className="w-4 h-4 animate-spin mr-2" />
          Loading intelligence data…
        </div>
      ) : (
        <>
          {/* Overview KPI row */}
          <OverviewCards summary={summary} missed={missedSummary} />

          {/* Main grid */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left column: trade reports + findings */}
            <div className="lg:col-span-2 space-y-6">
              <RecentReports reports={reports} />
              <TopFindings findings={summary?.topFindings ?? []} />
            </div>

            {/* Right column: adaptive engine + calibration + missed opps */}
            <div className="space-y-6">
              <AdaptiveThresholds status={dynamicStatus} />
              <ConfidenceBreakdown summary={summary} />
            </div>
          </div>

          {/* Full-width missed opportunities section */}
          <MissedOpportunities summary={missedSummary} records={missed} />
        </>
      )}
    </div>
  );
}
