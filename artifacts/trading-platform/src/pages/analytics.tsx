import { useGetPerformanceAnalytics, useGetDrawdownAnalysis, useGetMarketBreakdown, useGetTradeStats, useGetAiInsights } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { motion } from "framer-motion";
import {
  LineChart, Line, AreaChart, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, BarChart, Bar, CartesianGrid, Cell,
} from "recharts";
import { AlertTriangle, TrendingUp, Shield } from "lucide-react";

const CHART_STYLE = {
  contentStyle: { backgroundColor: "#0c0c0e", border: "1px solid #27272a", borderRadius: "6px", fontSize: "11px" },
  labelStyle: { color: "#71717a" },
};

export default function Analytics() {
  const { data: performance } = useGetPerformanceAnalytics({ days: 30 }, { query: { refetchInterval: 30000 } } as { query: any });
  const { data: drawdown } = useGetDrawdownAnalysis({ query: { refetchInterval: 15000 } } as { query: any });
  const { data: marketBreakdown } = useGetMarketBreakdown({ query: { refetchInterval: 30000 } } as { query: any });
  const { data: stats } = useGetTradeStats({ query: { refetchInterval: 15000 } } as { query: any });
  const { data: insights } = useGetAiInsights({ query: { refetchInterval: 60000 } } as { query: any });

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-6 max-w-7xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
        <p className="text-muted-foreground text-sm mt-0.5">Deep performance analysis and risk monitoring.</p>
      </div>

      {/* Headline stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: "Win Rate", value: `${(stats.winRate * 100).toFixed(1)}%`, sub: `${stats.wonTrades}W / ${stats.lostTrades}L`, color: stats.winRate >= 0.55 ? "text-green-500" : "text-amber-500" },
            { label: "Net Profit", value: `${stats.totalProfit >= 0 ? "+" : ""}${stats.totalProfit.toFixed(2)}`, sub: `avg ${stats.avgProfit >= 0 ? "+" : ""}${stats.avgProfit.toFixed(2)}/trade`, color: stats.totalProfit >= 0 ? "text-green-500" : "text-red-500" },
            { label: "Best Trade", value: `+${stats.bestTrade.toFixed(2)}`, sub: `worst: ${stats.worstTrade.toFixed(2)}`, color: "text-green-500" },
            { label: "Longest Win Streak", value: `${stats.longestWinStreak}`, sub: `current: ${stats.currentStreak >= 0 ? "+" : ""}${stats.currentStreak}`, color: "text-primary" },
          ].map((s) => (
            <Card key={s.label} className="bg-card">
              <CardContent className="p-4">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{s.label}</div>
                <div className={`text-2xl font-mono font-bold ${s.color}`}>{s.value}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">{s.sub}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Confidence accuracy */}
      {stats && (
        <Card className="bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">AI Confidence Accuracy</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-6">
              <div>
                <div className="text-xs text-muted-foreground mb-1.5">Avg confidence on winning trades</div>
                <div className="flex items-center gap-3">
                  <div className="text-xl font-mono font-bold text-green-500">
                    {performance?.avgConfidenceByOutcome?.avgConfidenceWon?.toFixed(1) ?? "—"}%
                  </div>
                  <div className="flex-1 h-2 bg-secondary rounded-full overflow-hidden">
                    <div className="h-full bg-green-500 rounded-full" style={{ width: `${performance?.avgConfidenceByOutcome?.avgConfidenceWon ?? 0}%` }} />
                  </div>
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1.5">Avg confidence on losing trades</div>
                <div className="flex items-center gap-3">
                  <div className="text-xl font-mono font-bold text-red-500">
                    {performance?.avgConfidenceByOutcome?.avgConfidenceLost?.toFixed(1) ?? "—"}%
                  </div>
                  <div className="flex-1 h-2 bg-secondary rounded-full overflow-hidden">
                    <div className="h-full bg-red-500 rounded-full" style={{ width: `${performance?.avgConfidenceByOutcome?.avgConfidenceLost ?? 0}%` }} />
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Profit curve + Win rate */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Cumulative P&L (30d)</CardTitle>
          </CardHeader>
          <CardContent className="h-[220px]">
            {performance?.profitCurve ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={performance.profitCurve} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="profitGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" hide />
                  <YAxis />
                  <Tooltip {...CHART_STYLE} formatter={(v: number) => [`$${v.toFixed(2)}`, "Profit"]} />
                  <Area type="monotone" dataKey="cumulativeProfit" stroke="hsl(var(--primary))" fill="url(#profitGrad)" strokeWidth={2} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm">No data yet</div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Win Rate History (30d)</CardTitle>
          </CardHeader>
          <CardContent className="h-[220px]">
            {performance?.winRateHistory ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={performance.winRateHistory} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                  <XAxis dataKey="date" hide />
                  <YAxis domain={[0, 1]} tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} />
                  <Tooltip {...CHART_STYLE} formatter={(v: number) => [`${(v * 100).toFixed(1)}%`, "Win Rate"]} />
                  <Line type="monotone" dataKey="winRate" stroke="#10b981" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm">No data yet</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Market breakdown + Drawdown */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">P&L by Market</CardTitle>
          </CardHeader>
          <CardContent className="h-[250px]">
            {marketBreakdown && marketBreakdown.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={marketBreakdown.slice(0, 10)} margin={{ top: 5, right: 5, left: -20, bottom: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1c1c1e" vertical={false} />
                  <XAxis dataKey="symbol" tick={{ fontSize: 10, fill: "#71717a" }} angle={-30} textAnchor="end" />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip {...CHART_STYLE} formatter={(v: number) => [`$${v.toFixed(2)}`, "P&L"]} />
                  <Bar dataKey="totalProfit" radius={[3, 3, 0, 0]}>
                    {marketBreakdown.slice(0, 10).map((entry, i) => (
                      <Cell key={i} fill={entry.totalProfit >= 0 ? "#10b981" : "#ef4444"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm">No trade data yet</div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5" /> Drawdown Risk
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {drawdown ? (
              <>
                {drawdown.isAtRisk && (
                  <div className="flex items-center gap-2 p-2 rounded bg-red-500/10 border border-red-500/20 mb-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-red-500" />
                    <span className="text-xs text-red-400">Approaching drawdown limit</span>
                  </div>
                )}
                {[
                  { label: "Current Drawdown", value: drawdown.currentDrawdown, limit: drawdown.drawdownLimit, color: "bg-red-500" },
                  { label: "Max Drawdown", value: drawdown.maxDrawdown, limit: drawdown.drawdownLimit, color: "bg-amber-500" },
                  { label: "Risk Exposure", value: drawdown.riskExposure, limit: 100, color: "bg-orange-500" },
                ].map((item) => (
                  <div key={item.label}>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-muted-foreground">{item.label}</span>
                      <span className="font-mono">{item.value.toFixed(2)}%</span>
                    </div>
                    <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${item.color}`}
                        style={{ width: `${Math.min((item.value / item.limit) * 100, 100)}%`, transition: "width 0.4s ease" }} />
                    </div>
                  </div>
                ))}
                <div className="pt-3 border-t border-border">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Consecutive Losses</div>
                  <div className="flex items-baseline gap-1.5">
                    <span className={`text-2xl font-mono font-bold ${drawdown.consecutiveLosses >= drawdown.consecutiveLossLimit ? "text-red-500" : drawdown.consecutiveLosses > 0 ? "text-amber-500" : "text-muted-foreground"}`}>
                      {drawdown.consecutiveLosses}
                    </span>
                    <span className="text-xs text-muted-foreground">/ {drawdown.consecutiveLossLimit} limit</span>
                  </div>
                </div>
              </>
            ) : (
              <div className="text-sm text-muted-foreground py-4">Loading risk data...</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* AI Insights */}
      {insights && insights.length > 0 && (
        <Card className="bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <TrendingUp className="w-3.5 h-3.5 text-primary" /> AI-Generated Improvement Suggestions
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {insights.map((insight) => (
                <div key={insight.id} className={`p-3 rounded-lg border ${
                  insight.priority === "critical" ? "border-red-500/30 bg-red-500/5"
                  : insight.priority === "high" ? "border-amber-500/30 bg-amber-500/5"
                  : "border-border bg-secondary/10"
                }`}>
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <div className="text-xs font-semibold">{insight.title}</div>
                    <Badge variant="outline" className={`text-[9px] px-1.5 flex-shrink-0 capitalize ${
                      insight.priority === "critical" ? "text-red-500 border-red-500/30"
                      : insight.priority === "high" ? "text-amber-500 border-amber-500/30"
                      : "text-muted-foreground border-border"
                    }`}>{insight.priority}</Badge>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">{insight.description}</p>
                  {insight.relatedMarket && (
                    <div className="mt-2 text-[10px] text-primary font-mono">{insight.relatedMarket}</div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </motion.div>
  );
}
