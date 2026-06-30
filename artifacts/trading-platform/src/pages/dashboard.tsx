import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useGetTopMarket,
  useGetAiEngineStatus,
  useGetAiInsights,
  useGetAccount,
  useGetDailySummary,
  useExecuteTrade,
  useToggleAutonomousEngine,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { motion, AnimatePresence } from "framer-motion";
import { Link } from "wouter";
import { TrendingUp, Activity, Shield, AlertTriangle, Target, ChevronRight, Clock, RefreshCw, TimerOff } from "lucide-react";
import { toast } from "sonner";
import { MarketOpportunityFlashCard } from "@/components/flash-card-3d";

interface JournalStats {
  totalTrades: number;
  wonTrades: number;
  lostTrades: number;
  winRate: number;
  totalProfit: number;
  todayProfit: number;
  currentStreak: number;
}

function formatCooldown(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

export default function Dashboard() {
  const { data: summary } = useGetDailySummary({ query: { refetchInterval: 5000 } } as { query: any });
  const { data: topMarket } = useGetTopMarket({ query: { refetchInterval: 8000 } } as { query: any });
  const { data: engine, refetch: refetchEngine } = useGetAiEngineStatus({ query: { refetchInterval: 3000 } } as { query: any });
  const { data: insights } = useGetAiInsights({ query: { refetchInterval: 30000 } } as { query: any });
  const { data: account } = useGetAccount();
  const executeTrade = useExecuteTrade();
  const toggleEngine = useToggleAutonomousEngine();

  const queryClient = useQueryClient();

  // Journal stats — same source as the Trade Journal mini dashboard
  const { data: journalData } = useQuery({
    queryKey: ["derivJournal"],
    queryFn: () => fetch("/api/trades/deriv-journal").then(r => r.json()),
    refetchInterval: 60000,
    staleTime: 30000,
  });
  const stats: JournalStats | undefined = (journalData as any)?.stats;

  // SSE: invalidate journal + daily-summary immediately whenever the journal manager refreshes
  const sseRef = useRef<EventSource | null>(null);
  useEffect(() => {
    const es = new EventSource("/api/ai/events");
    sseRef.current = es;
    es.addEventListener("journal_refreshed", () => {
      queryClient.invalidateQueries({ queryKey: ["derivJournal"] });
      queryClient.invalidateQueries({ queryKey: ["getDailySummary"] });
    });
    return () => { es.close(); sseRef.current = null; };
  }, [queryClient]);

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

  // Cooldown countdown — counts down until engine auto-resumes
  const [cooldownSecs, setCooldownSecs] = useState<number | null>(null);
  useEffect(() => {
    const cooldownUntilStr = (engine as any)?.cooldownUntil;
    if (!cooldownUntilStr) { setCooldownSecs(null); return; }
    const target = new Date(cooldownUntilStr).getTime();
    const update = () => {
      const remaining = Math.max(0, Math.ceil((target - Date.now()) / 1000));
      setCooldownSecs(remaining > 0 ? remaining : null);
    };
    update();
    const iv = setInterval(update, 1000);
    return () => clearInterval(iv);
  }, [(engine as any)?.cooldownUntil]);

  const targetPct = summary ? Math.max(0, Math.min(100, (summary.totalProfit / summary.dailyTarget) * 100)) : 0;
  const isProfit = (summary?.totalProfit ?? 0) >= 0;


  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-6 max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <header className="flex justify-between items-end">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <div className="flex items-center gap-2 mt-1">
            <div className={`w-1.5 h-1.5 rounded-full ${engine?.isRunning ? "bg-green-500 animate-pulse" : cooldownSecs ? "bg-amber-500 animate-pulse" : "bg-zinc-600"}`} />
            <p className="text-muted-foreground font-mono text-xs">
              {engine?.isRunning ? "ENGINE ONLINE" : cooldownSecs ? "COOLDOWN" : "ENGINE STANDBY"} &bull; {engine?.mode?.toUpperCase() ?? "MANUAL"} MODE
              {(engine as any)?.paperTradeMode && " · PAPER"}
              {(engine as any)?.tickHealth?.usingSimulated && " · SIM DATA"}
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
              <Badge variant="outline" className="cursor-pointer border-primary/50 text-primary hover:bg-primary/10">
                Connect Deriv Account
              </Badge>
            </Link>
          )}
        </div>
      </header>

      {/* Cooldown banner — shown when engine is in cooldown after consecutive losses */}
      <AnimatePresence>
        {cooldownSecs !== null && !engine?.isRunning && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="flex items-center gap-4 p-4 rounded-xl bg-amber-500/8 border border-amber-500/30"
          >
            <div className="flex items-center gap-2 flex-1">
              <TimerOff className="w-4 h-4 text-amber-400 flex-shrink-0" />
              <div>
                <div className="text-sm font-medium text-amber-300">Engine in Cooldown</div>
                <div className="text-xs text-amber-400/70 mt-0.5">
                  {engine?.stopReasons?.[0] ?? "Consecutive losses triggered a safety pause"}
                </div>
              </div>
            </div>
            <div className="flex flex-col items-end gap-1">
              <div className="text-2xl font-mono font-bold text-amber-300 tabular-nums">
                {formatCooldown(cooldownSecs)}
              </div>
              <div className="text-[10px] font-mono text-amber-500/60 uppercase tracking-wider">until auto-resume</div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="text-xs h-7 px-3 border-amber-500/40 text-amber-400 hover:bg-amber-500/10 flex-shrink-0"
              onClick={() => toggleEngine.mutate({ data: { running: true } })}
              disabled={toggleEngine.isPending}
            >
              Resume Now
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Stat strip — mirrors the Trade Journal mini dashboard */}
      <div className="space-y-2">
        <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Performance</span>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card className="bg-card">
            <CardContent className="p-4">
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Win Rate</div>
              <div className={`text-2xl font-mono font-bold ${(stats?.winRate ?? 0) >= 0.55 ? "text-green-500" : (stats?.winRate ?? 0) >= 0.45 ? "text-amber-500" : "text-red-500"}`}>
                {stats ? `${(stats.winRate * 100).toFixed(1)}%` : "—"}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {stats ? `${stats.wonTrades}W / ${stats.lostTrades}L` : "no trades yet"}
              </div>
            </CardContent>
          </Card>
          <Card className="bg-card">
            <CardContent className="p-4">
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Total Profit</div>
              <div className={`text-2xl font-mono font-bold ${(stats?.totalProfit ?? 0) >= 0 ? "text-green-500" : "text-red-500"}`}>
                {stats ? `${stats.totalProfit >= 0 ? "+" : ""}${stats.totalProfit.toFixed(2)}` : "—"}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                today: {stats ? `${stats.todayProfit >= 0 ? "+" : ""}${stats.todayProfit.toFixed(2)}` : "—"}
              </div>
            </CardContent>
          </Card>
          <Card className="bg-card">
            <CardContent className="p-4">
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Streak</div>
              <div className={`text-2xl font-mono font-bold ${(stats?.currentStreak ?? 0) >= 0 ? "text-green-500" : "text-red-500"}`}>
                {stats ? `${stats.currentStreak > 0 ? "+" : ""}${stats.currentStreak}` : "—"}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {stats ? ((stats.currentStreak ?? 0) >= 0 ? "winning streak" : "losing streak") : "no data"}
              </div>
            </CardContent>
          </Card>
          <Card className="bg-card">
            <CardContent className="p-4">
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Total Trades</div>
              <div className="text-2xl font-mono font-bold">
                {stats?.totalTrades ?? "—"}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {stats ? `${(stats.winRate * 100).toFixed(1)}% win rate` : "no trades yet"}
              </div>
            </CardContent>
          </Card>
        </div>
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

        <div className="md:col-span-2">
          <MarketOpportunityFlashCard />
        </div>
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
            {!engine?.isRunning && !cooldownSecs && engine?.stopReasons && engine.stopReasons.length > 0 && (
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
            {(engine?.agentStatuses ?? []).map((agent) => {
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
