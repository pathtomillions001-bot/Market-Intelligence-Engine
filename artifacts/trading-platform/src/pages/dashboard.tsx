import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useGetTopMarket,
  useGetAiEngineStatus,
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
import { TrendingUp, Activity, AlertTriangle, Target, Clock, RefreshCw, TimerOff, Zap, ArrowRight } from "lucide-react";
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

interface PendingResult {
  won: boolean;
  profit: number;
  createdAt: string;
}

function formatCooldown(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

// ── AI Opportunity Scanner — replaces the ranked signal list ─────────────────
function AIOpportunityScanner() {
  const { data: allMarkets } = useQuery<any[]>({
    queryKey: ["markets-top-signals"],
    queryFn: () => fetch("/api/markets?limit=50").then(r => r.json()),
    refetchInterval: 8000,
    staleTime: 4000,
  });

  const CONTRACT_COLORS: Record<string, string> = {
    CALL: "#10b981", PUT: "#ef4444",
    DIGITOVER: "#06b6d4", DIGITUNDER: "#f59e0b",
    DIGITEVEN: "#8b5cf6", DIGITODD: "#ec4899",
  };
  const CONTRACT_LABELS: Record<string, string> = {
    CALL: "RISE", PUT: "FALL",
    DIGITOVER: "OVER", DIGITUNDER: "UNDER",
    DIGITEVEN: "EVEN", DIGITODD: "ODD",
  };

  const topMarkets = (allMarkets ?? []).slice(0, 6);

  return (
    <Card className="bg-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Zap className="w-4 h-4 text-primary" />
            AI Opportunity Scanner
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
          </CardTitle>
          <Link href="/markets">
            <span className="text-xs text-muted-foreground hover:text-foreground cursor-pointer flex items-center gap-1">
              All markets <ArrowRight className="w-3 h-3" />
            </span>
          </Link>
        </div>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Top 6 markets by AI quality score — 9-agent ensemble · click to view &amp; trade
        </p>
      </CardHeader>
      <CardContent>
        {topMarkets.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4 text-center">Scanning markets…</div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2.5">
            {topMarkets.map((market: any, idx: number) => {
              const ct = market.recommendedContractType ?? "CALL";
              const color = CONTRACT_COLORS[ct] ?? "#00ffff";
              const label = CONTRACT_LABELS[ct] ?? ct;
              const score = market.confidenceScore ?? market.qualityScore ?? 0;
              const winPct = market.winProbability ?? score;
              const ev: number = market.expectedValue ?? 0;
              const hasSig: boolean = !!market.shouldTrade;
              const isTop = idx === 0;

              return (
                <Link key={market.symbol} href={`/markets/${market.symbol}`}>
                  <div
                    className={`relative p-3 rounded-xl border-2 transition-all hover:scale-[1.02] active:scale-100 cursor-pointer h-full ${
                      hasSig && score >= 70 ? "bg-card" : "bg-secondary/15 border-border"
                    }`}
                    style={hasSig && score >= 70 ? { borderColor: `${color}50`, background: `${color}06` } : {}}
                  >
                    {isTop && (
                      <div className="absolute -top-2 left-3">
                        <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-primary text-primary-foreground">TOP</span>
                      </div>
                    )}

                    {/* Contract type + signal */}
                    <div className="flex items-center justify-between mb-2">
                      <span
                        className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border"
                        style={{ color, borderColor: `${color}50`, background: `${color}15` }}
                      >
                        {label}
                      </span>
                      {hasSig && <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: color }} />}
                    </div>

                    {/* Market name */}
                    <div className="text-[11px] font-semibold leading-tight truncate">{market.displayName}</div>
                    <div className="text-[8px] font-mono text-muted-foreground mb-2">{market.symbol}</div>

                    {/* Win probability — big number */}
                    <div className={`text-xl font-mono font-bold leading-none ${score >= 70 ? "text-green-400" : score >= 50 ? "text-amber-400" : "text-muted-foreground"}`}>
                      {winPct.toFixed(0)}%
                    </div>
                    <div className="text-[8px] text-muted-foreground mb-1.5">win prob</div>

                    {/* Expected value */}
                    <div className={`text-[9px] font-mono ${ev > 0 ? "text-green-500/70" : "text-zinc-600"}`}>
                      EV {ev > 0 ? "+" : ""}{(ev * 100).toFixed(1)}%
                    </div>

                    {/* Score bar */}
                    <div className="mt-2 h-0.5 w-full bg-black/20 rounded-full overflow-hidden">
                      <div className="h-full rounded-full"
                        style={{ width: `${Math.min(100, score)}%`, background: score >= 70 ? "#10b981" : score >= 50 ? "#f59e0b" : "#71717a", transition: "width 0.4s ease" }}
                      />
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const { data: summary } = useGetDailySummary({ query: { refetchInterval: 5000 } } as { query: any });
  const { data: topMarket } = useGetTopMarket({ query: { refetchInterval: 8000 } } as { query: any });
  const { data: engine, refetch: refetchEngine } = useGetAiEngineStatus({ query: { refetchInterval: 3000 } } as { query: any });
  const { data: account } = useGetAccount();
  const executeTrade = useExecuteTrade();
  const toggleEngine = useToggleAutonomousEngine();

  const queryClient = useQueryClient();

  // Journal stats — tighter polling so new trades appear quickly
  const { data: journalData } = useQuery({
    queryKey: ["derivJournal"],
    queryFn: () => fetch("/api/trades/deriv-journal").then(r => r.json()),
    refetchInterval: 10000,
    staleTime: 5000,
  });
  const stats: JournalStats | undefined = (journalData as any)?.stats;

  // Optimistic trade results — applied immediately when trade_completed SSE fires
  const [pendingResults, setPendingResults] = useState<PendingResult[]>([]);

  // SSE: journal_refreshed syncs journal; trade_completed applies immediate stat delta
  const sseRef = useRef<EventSource | null>(null);
  useEffect(() => {
    const es = new EventSource("/api/ai/events");
    sseRef.current = es;

    es.addEventListener("trade_completed", (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data);
        const trade = payload?.trade;
        if (trade) {
          setPendingResults(prev => [...prev.slice(-9), {
            won: !!trade.won,
            profit: trade.profit ?? 0,
            createdAt: trade.createdAt ?? new Date().toISOString(),
          }]);
          queryClient.invalidateQueries({ queryKey: ["getDailySummary"] });
        }
      } catch {}
    });

    es.addEventListener("journal_refreshed", () => {
      queryClient.invalidateQueries({ queryKey: ["derivJournal"] });
      queryClient.invalidateQueries({ queryKey: ["getDailySummary"] });
      setPendingResults([]);
    });

    return () => { es.close(); sseRef.current = null; };
  }, [queryClient]);

  // Merge server stats with optimistic pending results for <1s display latency
  const displayStats = useMemo((): JournalStats | undefined => {
    if (!stats) return undefined;
    if (pendingResults.length === 0) return stats;

    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const pendingToday = pendingResults.filter(t => new Date(t.createdAt) >= todayStart);

    const addedWins = pendingResults.filter(t => t.won).length;
    const addedLosses = pendingResults.length - addedWins;
    const addedProfit = pendingResults.reduce((s, t) => s + t.profit, 0);
    const addedTodayProfit = pendingToday.reduce((s, t) => s + t.profit, 0);

    const newTotal = stats.totalTrades + pendingResults.length;
    const newWins = stats.wonTrades + addedWins;

    let newStreak = stats.currentStreak;
    for (const t of pendingResults) {
      if (t.won) newStreak = newStreak >= 0 ? newStreak + 1 : 1;
      else newStreak = newStreak <= 0 ? newStreak - 1 : -1;
    }

    return {
      ...stats,
      totalTrades: newTotal,
      wonTrades: newWins,
      lostTrades: stats.lostTrades + addedLosses,
      winRate: newTotal > 0 ? newWins / newTotal : 0,
      totalProfit: Math.round((stats.totalProfit + addedProfit) * 100) / 100,
      todayProfit: Math.round(((stats.todayProfit ?? 0) + addedTodayProfit) * 100) / 100,
      currentStreak: newStreak,
    };
  }, [stats, pendingResults]);

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

      {/* Stat strip — displayStats applies pending optimistic updates instantly */}
      <div className="space-y-2">
        <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Performance</span>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card className="bg-card">
            <CardContent className="p-4">
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Win Rate</div>
              <div className={`text-2xl font-mono font-bold ${(displayStats?.winRate ?? 0) >= 0.55 ? "text-green-500" : (displayStats?.winRate ?? 0) >= 0.45 ? "text-amber-500" : "text-red-500"}`}>
                {displayStats ? `${(displayStats.winRate * 100).toFixed(1)}%` : "—"}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {displayStats ? `${displayStats.wonTrades}W / ${displayStats.lostTrades}L` : "no trades yet"}
              </div>
            </CardContent>
          </Card>
          <Card className="bg-card">
            <CardContent className="p-4">
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Total Profit</div>
              <div className={`text-2xl font-mono font-bold ${(displayStats?.totalProfit ?? 0) >= 0 ? "text-green-500" : "text-red-500"}`}>
                {displayStats ? `${displayStats.totalProfit >= 0 ? "+" : ""}${displayStats.totalProfit.toFixed(2)}` : "—"}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                today: {displayStats ? `${displayStats.todayProfit >= 0 ? "+" : ""}${displayStats.todayProfit.toFixed(2)}` : "—"}
              </div>
            </CardContent>
          </Card>
          <Card className="bg-card">
            <CardContent className="p-4">
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Streak</div>
              <div className={`text-2xl font-mono font-bold ${(displayStats?.currentStreak ?? 0) >= 0 ? "text-green-500" : "text-red-500"}`}>
                {displayStats ? `${displayStats.currentStreak > 0 ? "+" : ""}${displayStats.currentStreak}` : "—"}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {displayStats ? ((displayStats.currentStreak ?? 0) >= 0 ? "winning streak" : "losing streak") : "no data"}
              </div>
            </CardContent>
          </Card>
          <Card className="bg-card">
            <CardContent className="p-4">
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Total Trades</div>
              <div className="text-2xl font-mono font-bold">
                {displayStats?.totalTrades ?? "—"}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {displayStats ? `${(displayStats.winRate * 100).toFixed(1)}% win rate` : "no trades yet"}
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
          <MarketOpportunityFlashCard currentStreak={displayStats?.currentStreak ?? 0} />
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
            {(engine?.agentStatuses ?? []).map((agent: any) => {
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

      {/* AI Opportunity Scanner — 2x3 market grid with win prob + EV per market */}
      <AIOpportunityScanner />
    </motion.div>
  );
}
