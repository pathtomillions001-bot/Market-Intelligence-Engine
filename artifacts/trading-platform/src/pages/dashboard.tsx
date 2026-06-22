import { useState, useEffect } from "react";
import {
  useGetDailySummary,
  useGetTopMarket,
  useGetAiEngineStatus,
  useGetTradeStats,
  useGetAiInsights,
  useGetAccount,
  useExecuteTrade,
  useToggleAutonomousEngine,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { motion, AnimatePresence } from "framer-motion";
import { Link } from "wouter";
import { TrendingUp, TrendingDown, Activity, Zap, Shield, AlertTriangle, Target, ChevronRight, Clock, RefreshCw } from "lucide-react";
import { toast } from "sonner";

function ConfidenceRing({ value, size = 56 }: { value: number; size?: number }) {
  const r = size / 2 - 6;
  const circ = 2 * Math.PI * r;
  const offset = circ - (value / 100) * circ;
  const color = value >= 70 ? "#10b981" : value >= 50 ? "#f59e0b" : "#ef4444";
  return (
    <svg width={size} height={size} className="rotate-[-90deg]">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#27272a" strokeWidth={5} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={5}
        strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
        style={{ transition: "stroke-dashoffset 0.6s ease" }} />
      <text x="50%" y="50%" dominantBaseline="middle" textAnchor="middle"
        fill={color} fontSize={size * 0.22} fontFamily="monospace"
        style={{ transform: "rotate(90deg)", transformOrigin: "center" }}>
        {value.toFixed(0)}%
      </text>
    </svg>
  );
}

export default function Dashboard() {
  const { data: summary } = useGetDailySummary({ query: { refetchInterval: 5000 } } as { query: any });
  const { data: topMarket } = useGetTopMarket({ query: { refetchInterval: 8000 } } as { query: any });
  const { data: engine, refetch: refetchEngine } = useGetAiEngineStatus({ query: { refetchInterval: 3000 } } as { query: any });
  const { data: stats } = useGetTradeStats({ query: { refetchInterval: 10000 } } as { query: any });
  const { data: insights } = useGetAiInsights({ query: { refetchInterval: 30000 } } as { query: any });
  const { data: account } = useGetAccount();
  const executeTrade = useExecuteTrade();
  const toggleEngine = useToggleAutonomousEngine();

  // Live countdown to next autonomous trade
  const [countdown, setCountdown] = useState<number | null>(null);
  useEffect(() => {
    if (!engine?.isRunning || !engine?.nextScanIn) { setCountdown(null); return; }
    setCountdown(engine.nextScanIn);
    const iv = setInterval(() => {
      setCountdown((c) => {
        if (c === null || c <= 1) { refetchEngine(); return null; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [engine?.isRunning, engine?.nextScanIn]);

  const targetPct = summary ? Math.max(0, Math.min(100, (summary.totalProfit / summary.dailyTarget) * 100)) : 0;
  const isProfit = (summary?.totalProfit ?? 0) >= 0;

  const handleQuickTrade = () => {
    if (!topMarket) return;
    executeTrade.mutate({
      data: {
        symbol: topMarket.symbol,
        contractType: topMarket.recommendation?.contractType ?? "CALL",
        stake: topMarket.recommendation?.stake ?? 1,
        direction: topMarket.recommendation?.direction ?? "up",
      }
    }, {
      onSuccess: (trade) => toast.success(`${trade.status === "won" ? "Won" : "Lost"} $${Math.abs(trade.profit ?? 0).toFixed(2)} on ${trade.symbol}`),
      onError: () => toast.error("Trade failed — check account settings"),
    });
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-6 max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <header className="flex justify-between items-end">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <div className="flex items-center gap-2 mt-1">
            <div className={`w-1.5 h-1.5 rounded-full ${engine?.isRunning ? "bg-green-500 animate-pulse" : "bg-zinc-600"}`} />
            <p className="text-muted-foreground font-mono text-xs">
              {engine?.isRunning ? "ENGINE ONLINE" : "ENGINE STANDBY"} &bull; {engine?.mode?.toUpperCase() ?? "MANUAL"} MODE
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {account ? (
            <div className="text-right">
              <div className="text-xs text-muted-foreground font-mono">{account.loginId}</div>
              <div className="font-mono font-bold">{account.currency} {account.balance.toFixed(2)}</div>
            </div>
          ) : (
            <Link href="/connect">
              <Badge variant="outline" className="cursor-pointer border-amber-500/50 text-amber-500 hover:bg-amber-500/10">
                Demo Mode — Connect Account
              </Badge>
            </Link>
          )}
        </div>
      </header>

      {/* Stat strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="bg-card">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Today P&L</div>
            <div className={`text-2xl font-mono font-bold ${isProfit ? "text-green-500" : "text-red-500"}`}>
              {isProfit ? "+" : ""}{summary?.totalProfit?.toFixed(2) ?? "0.00"}
            </div>
            <div className="text-xs text-muted-foreground mt-1">{summary?.wonCount ?? 0}W / {summary?.lostCount ?? 0}L today</div>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Win Rate</div>
            <div className="text-2xl font-mono font-bold">{stats?.winRate ? (stats.winRate * 100).toFixed(1) : "—"}%</div>
            <div className="text-xs text-muted-foreground mt-1">{stats?.totalTrades ?? 0} total trades</div>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Streak</div>
            <div className={`text-2xl font-mono font-bold ${(stats?.currentStreak ?? 0) >= 0 ? "text-green-500" : "text-red-500"}`}>
              {(stats?.currentStreak ?? 0) > 0 ? "+" : ""}{stats?.currentStreak ?? 0}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {(stats?.currentStreak ?? 0) >= 0 ? "winning" : "losing"} streak
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Total Profit</div>
            <div className={`text-2xl font-mono font-bold ${(stats?.totalProfit ?? 0) >= 0 ? "text-green-500" : "text-red-500"}`}>
              {(stats?.totalProfit ?? 0) >= 0 ? "+" : ""}{stats?.totalProfit?.toFixed(2) ?? "0.00"}
            </div>
            <div className="text-xs text-muted-foreground mt-1">best: +{stats?.bestTrade?.toFixed(2) ?? "0.00"}</div>
          </CardContent>
        </Card>
      </div>

      {/* Daily target + Top opportunity */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <Target className="w-3.5 h-3.5" /> Daily Target
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between items-end">
              <span className={`text-xl font-mono font-bold ${isProfit ? "text-green-500" : "text-red-500"}`}>
                {isProfit ? "+" : ""}{summary?.totalProfit?.toFixed(2) ?? "0.00"}
              </span>
              <span className="text-sm text-muted-foreground font-mono">/ ${summary?.dailyTarget?.toFixed(0) ?? "50"}</span>
            </div>
            <div className="h-2 w-full bg-secondary rounded-full overflow-hidden">
              <motion.div
                className={`h-full rounded-full ${targetPct >= 100 ? "bg-green-500" : targetPct >= 50 ? "bg-primary" : "bg-amber-500"}`}
                initial={{ width: 0 }}
                animate={{ width: `${targetPct}%` }}
                transition={{ duration: 0.6 }}
              />
            </div>
            <div className="text-xs text-muted-foreground">
              {targetPct >= 100 ? "Target reached!" : `${targetPct.toFixed(0)}% of daily target`}
            </div>
            {summary?.isLossLimitHit && (
              <Badge variant="outline" className="text-red-500 border-red-500/30 text-xs w-full justify-center">
                Loss limit hit — trading paused
              </Badge>
            )}
          </CardContent>
        </Card>

        <Card className="md:col-span-2 bg-card border-primary/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-primary" /> Best Opportunity Now
            </CardTitle>
          </CardHeader>
          <CardContent>
            {topMarket ? (
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <ConfidenceRing value={topMarket.recommendation?.confidence ?? 0} size={64} />
                  <div>
                    <div className="font-bold text-lg">{topMarket.displayName}</div>
                    <div className="text-xs text-muted-foreground font-mono">{topMarket.symbol}</div>
                    <div className="flex gap-2 mt-1">
                      <Badge variant="outline" className={`text-[10px] px-2 ${topMarket.recommendation?.direction === "up" ? "text-green-500 border-green-500/30" : "text-red-500 border-red-500/30"}`}>
                        {topMarket.recommendation?.direction?.toUpperCase()} {topMarket.recommendation?.contractType}
                      </Badge>
                      <Badge variant="outline" className="text-[10px] px-2 text-muted-foreground border-border">
                        {topMarket.category}
                      </Badge>
                    </div>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <div className="text-right">
                    <div className="text-xs text-muted-foreground">Stake</div>
                    <div className="font-mono font-bold">${topMarket.recommendation?.stake?.toFixed(2) ?? "—"}</div>
                  </div>
                  <Button size="sm" onClick={handleQuickTrade} disabled={executeTrade.isPending || !topMarket.recommendation?.shouldTrade}
                    className="bg-primary/20 text-primary border border-primary/40 hover:bg-primary/30 text-xs px-4">
                    {executeTrade.isPending ? "Executing..." : topMarket.recommendation?.shouldTrade ? "Execute Trade" : "Low Confidence"}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-muted-foreground py-4">
                <Activity className="w-4 h-4 animate-pulse" />
                <span className="text-sm">Scanning markets for best opportunity...</span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Engine toggle + Agent grid */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Activity className="w-4 h-4 text-primary" /> AI Engine — 8 Agents
            </CardTitle>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground font-mono">
                {engine?.tradesExecutedToday ?? 0} trades today
              </span>
              <Button
                size="sm"
                variant="outline"
                className={`text-xs h-7 px-3 ${engine?.isRunning ? "border-green-500/40 text-green-500 hover:bg-green-500/10" : "border-border text-muted-foreground hover:text-foreground"}`}
                onClick={() => toggleEngine.mutate({ data: { running: !engine?.isRunning } })}
                disabled={toggleEngine.isPending}
              >
                {engine?.isRunning ? "STOP ENGINE" : "START ENGINE"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Autonomous loop status bar */}
          <AnimatePresence>
            {engine?.isRunning && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="flex items-center gap-4 p-3 rounded-lg bg-green-500/5 border border-green-500/20 overflow-hidden"
              >
                <div className="flex items-center gap-2 flex-1">
                  <RefreshCw className="w-3.5 h-3.5 text-green-500 animate-spin" />
                  <span className="text-xs text-green-400 font-mono">
                    {engine.currentMarket ? `Scanning ${engine.currentMarket}` : "Scanning markets…"}
                  </span>
                </div>
                {countdown !== null && (
                  <div className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground">
                    <Clock className="w-3 h-3" />
                    <span>Next trade in <span className="text-foreground font-bold">{countdown}s</span></span>
                  </div>
                )}
                <div className="text-[10px] text-muted-foreground font-mono">
                  every {(engine as any).loopIntervalSec ?? 30}s
                </div>
              </motion.div>
            )}
            {!engine?.isRunning && engine?.stopReasons && engine.stopReasons.length > 0 && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/5 border border-amber-500/20"
              >
                <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                <span className="text-xs text-amber-400">{engine.stopReasons[0]}</span>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {engine?.agentStatuses.map((agent) => {
              const conf = agent.confidence;
              const color = conf >= 70 ? "text-green-500" : conf >= 50 ? "text-amber-500" : "text-red-500";
              const bg = conf >= 70 ? "bg-green-500/10 border-green-500/20" : conf >= 50 ? "bg-amber-500/10 border-amber-500/20" : "bg-red-500/10 border-red-500/20";
              return (
                <div key={agent.name} className={`p-3 rounded-lg border ${bg} relative overflow-hidden`}>
                  <div className="flex justify-between items-start mb-1.5">
                    <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide leading-tight pr-2">{agent.name}</div>
                    <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 mt-0.5 ${agent.isActive ? "bg-green-500 animate-pulse" : "bg-zinc-600"}`} />
                  </div>
                  <div className={`text-xl font-mono font-bold ${color}`}>{conf.toFixed(1)}%</div>
                  <div className="mt-1.5 h-0.5 w-full bg-black/20 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${conf >= 70 ? "bg-green-500" : conf >= 50 ? "bg-amber-500" : "bg-red-500"}`}
                      style={{ width: `${conf}%`, transition: "width 0.4s ease" }} />
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* AI Insights */}
      {insights && insights.length > 0 && (
        <Card className="bg-card">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Shield className="w-4 h-4 text-primary" /> AI Insights
              </CardTitle>
              <Link href="/analytics">
                <span className="text-xs text-muted-foreground hover:text-foreground cursor-pointer flex items-center gap-1">
                  View analytics <ChevronRight className="w-3 h-3" />
                </span>
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {insights.slice(0, 3).map((insight) => (
                <div key={insight.id} className={`flex items-start gap-3 p-3 rounded-lg border ${
                  insight.priority === "critical" ? "border-red-500/30 bg-red-500/5" :
                  insight.priority === "high" ? "border-amber-500/30 bg-amber-500/5" :
                  "border-border bg-secondary/20"
                }`}>
                  {insight.priority === "critical" || insight.priority === "high" ? (
                    <AlertTriangle className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${insight.priority === "critical" ? "text-red-500" : "text-amber-500"}`} />
                  ) : (
                    <TrendingUp className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-primary" />
                  )}
                  <div>
                    <div className="text-xs font-semibold">{insight.title}</div>
                    <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{insight.description}</div>
                  </div>
                  <Badge variant="outline" className="ml-auto text-[10px] flex-shrink-0 capitalize">{insight.priority}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </motion.div>
  );
}
