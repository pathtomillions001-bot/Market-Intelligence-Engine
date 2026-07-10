import { useGetDrawdownAnalysis } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { motion } from "framer-motion";
import {
  LineChart, Line, AreaChart, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, BarChart, Bar, CartesianGrid, Cell,
} from "recharts";
import { AlertTriangle, Shield, TrendingUp, TrendingDown, Activity, Calendar, Filter } from "lucide-react";
import { useMemo, useState } from "react";

const CHART_STYLE = {
  contentStyle: { backgroundColor: "#0c0c0e", border: "1px solid #27272a", borderRadius: "6px", fontSize: "11px" },
  labelStyle: { color: "#71717a" },
};

// ── Market category classification ─────────────────────────────────────────────
function classifySymbol(symbol: string): "Synthetics" | "Forex" | "Commodities" | "Derived" {
  const s = symbol.toUpperCase();
  if (/^R_\d+$/.test(s) || /^1HZ\d+(V?)$/.test(s)) return "Synthetics";
  if (/^JD\d+$/.test(s) || s.startsWith("BOOM") || s.startsWith("CRASH") || s.startsWith("STEP")) return "Synthetics";
  if (/^(FR|OTC_)?XAU|XAG|OIL|BRENT/.test(s)) return "Commodities";
  if (/^(FR)?(USD|EUR|GBP|AUD|NZD|CAD|CHF|JPY)/.test(s) && !s.startsWith("R_")) return "Forex";
  if (s.startsWith("FR") && s.length > 2) return "Forex";
  return "Derived";
}

type FilterPreset = "today" | "7d" | "30d" | "custom";

// ── Stat computation from a trade list ────────────────────────────────────────
function computeStats(trades: any[]) {
  const won = trades.filter(t => t.won);
  const lost = trades.filter(t => !t.won);
  const totalProfit = trades.reduce((s, t) => s + (t.profit ?? 0), 0);

  // Streak: newest-first
  let currentStreak = 0;
  for (const t of trades) {
    if (currentStreak === 0) currentStreak = t.won ? 1 : -1;
    else if (t.won && currentStreak > 0) currentStreak++;
    else if (!t.won && currentStreak < 0) currentStreak--;
    else break;
  }

  let longestWin = 0, longestLoss = 0, runLen = 0, runWon: boolean | null = null;
  for (const t of trades) {
    if (runWon === null || runWon !== t.won) {
      if (runWon === true)  longestWin  = Math.max(longestWin, runLen);
      if (runWon === false) longestLoss = Math.max(longestLoss, runLen);
      runLen = 1; runWon = t.won;
    } else { runLen++; }
  }
  if (runWon === true)  longestWin  = Math.max(longestWin, runLen);
  if (runWon === false) longestLoss = Math.max(longestLoss, runLen);

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayTrades = trades.filter(t => new Date(t.createdAt) >= todayStart);
  const todayWon  = todayTrades.filter(t => t.won).length;
  const todayLost = todayTrades.filter(t => !t.won).length;
  const todayProfit = Math.round(todayTrades.reduce((s, t) => s + (t.profit ?? 0), 0) * 100) / 100;

  return {
    totalTrades:      trades.length,
    wonTrades:        won.length,
    lostTrades:       lost.length,
    winRate:          trades.length > 0 ? won.length / trades.length : 0,
    totalProfit:      Math.round(totalProfit * 100) / 100,
    avgProfit:        trades.length > 0 ? Math.round((totalProfit / trades.length) * 100) / 100 : 0,
    bestTrade:        won.length  > 0 ? Math.max(...won.map(t => t.profit ?? 0))  : 0,
    worstTrade:       lost.length > 0 ? Math.min(...lost.map(t => t.profit ?? 0)) : 0,
    currentStreak,
    longestWinStreak:  longestWin,
    longestLoseStreak: longestLoss,
    todayTrades:  todayTrades.length,
    todayWon,
    todayLost,
    todayProfit,
  };
}

// ── Compute analytics from (filtered) trade list ───────────────────────────────
interface CategoryStat { name: string; wins: number; losses: number; total: number; pnl: number; winRate: number }
interface MarketStat   { symbol: string; displayName: string; wins: number; losses: number; total: number; totalProfit: number }
interface DayPoint     { date: string; dailyProfit: number; cumulativeProfit: number; tradeCount: number; wins: number; losses: number }
interface WinRatePoint { date: string; winRate: number }

// Local date string — avoids UTC shift from toISOString()
function toLocalDate(d: Date): string {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, "0");
  const dy = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dy}`;
}

function buildAnalytics(trades: any[]): {
  stats: ReturnType<typeof computeStats> | null;
  profitCurve: DayPoint[];
  winRateHistory: WinRatePoint[];
  categoryBreakdown: CategoryStat[];
  marketBreakdown: MarketStat[];
} {
  if (trades.length === 0) return { stats: null, profitCurve: [], winRateHistory: [], categoryBreakdown: [], marketBreakdown: [] };

  const sorted = [...trades].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const byDate: Record<string, { wins: number; losses: number; pnl: number }> = {};
  for (const t of sorted) {
    const date = toLocalDate(new Date(t.createdAt));
    if (!byDate[date]) byDate[date] = { wins: 0, losses: 0, pnl: 0 };
    byDate[date].pnl += t.profit ?? 0;
    if (t.won) byDate[date].wins++;
    else byDate[date].losses++;
  }

  let cumulative = 0;
  const profitCurve = Object.entries(byDate).map(([date, d]) => {
    cumulative += d.pnl;
    const total = d.wins + d.losses;
    return { date, dailyProfit: Math.round(d.pnl * 100) / 100, cumulativeProfit: Math.round(cumulative * 100) / 100, tradeCount: total, wins: d.wins, losses: d.losses };
  });

  const winRateHistory = profitCurve.map((_, i) => {
    const window = profitCurve.slice(Math.max(0, i - 6), i + 1);
    const wWins  = window.reduce((s, d) => s + d.wins, 0);
    const wTotal = window.reduce((s, d) => s + d.tradeCount, 0);
    return { date: profitCurve[i].date, winRate: wTotal > 0 ? wWins / wTotal : 0 };
  });

  const catMap: Record<string, { wins: number; losses: number; pnl: number }> = {
    Synthetics: { wins: 0, losses: 0, pnl: 0 },
    Forex:      { wins: 0, losses: 0, pnl: 0 },
    Commodities:{ wins: 0, losses: 0, pnl: 0 },
    Derived:    { wins: 0, losses: 0, pnl: 0 },
  };
  for (const t of trades) {
    const cat = classifySymbol(t.symbol ?? "");
    catMap[cat].pnl += t.profit ?? 0;
    if (t.won) catMap[cat].wins++;
    else catMap[cat].losses++;
  }
  const categoryBreakdown = Object.entries(catMap)
    .map(([name, d]) => {
      const total = d.wins + d.losses;
      return { name, wins: d.wins, losses: d.losses, total, pnl: Math.round(d.pnl * 100) / 100, winRate: total > 0 ? d.wins / total : 0 };
    })
    .filter(c => c.total > 0)
    .sort((a, b) => b.pnl - a.pnl);

  const symMap: Record<string, { wins: number; losses: number; pnl: number; display: string }> = {};
  for (const t of trades) {
    if (!symMap[t.symbol]) symMap[t.symbol] = { wins: 0, losses: 0, pnl: 0, display: t.displayName ?? t.symbol };
    symMap[t.symbol].pnl += t.profit ?? 0;
    if (t.won) symMap[t.symbol].wins++;
    else symMap[t.symbol].losses++;
  }
  const marketBreakdown = Object.entries(symMap)
    .map(([symbol, d]) => ({ symbol, displayName: d.display, wins: d.wins, losses: d.losses, total: d.wins + d.losses, totalProfit: Math.round(d.pnl * 100) / 100 }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 12);

  // Trades newest-first for streak calculation
  const newestFirst = [...trades].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const stats = computeStats(newestFirst);

  return { stats, profitCurve, winRateHistory, categoryBreakdown, marketBreakdown };
}

// ── Journal data hook ─────────────────────────────────────────────────────────
// Uses the local DB as the primary source so autonomous, paper and manual trades
// are all included with accurate createdAt timestamps that the period filter relies on.
function useJournalTrades() {
  const { data: dbData, isLoading: dbLoading } = useQuery({
    queryKey: ["analytics-db-trades"],
    queryFn: () => fetch("/api/trades?limit=500").then(r => r.json()),
    refetchInterval: 20_000,
    staleTime: 10_000,
  });
  const trades: any[] = Array.isArray(dbData) ? dbData.filter((t: any) => t.status === "won" || t.status === "lost") : [];
  return { trades, isLoading: dbLoading };
}

// ── Filter helpers ────────────────────────────────────────────────────────────
function getFilterBounds(preset: FilterPreset, customFrom: string, customTo: string): { from: Date; to: Date } {
  const now = new Date();
  if (preset === "today") {
    const from = new Date(now); from.setHours(0, 0, 0, 0);
    return { from, to: now };
  }
  if (preset === "7d") {
    const from = new Date(now); from.setDate(from.getDate() - 7); from.setHours(0, 0, 0, 0);
    return { from, to: now };
  }
  if (preset === "30d") {
    const from = new Date(now); from.setDate(from.getDate() - 30); from.setHours(0, 0, 0, 0);
    return { from, to: now };
  }
  // custom
  const from = customFrom ? new Date(customFrom + "T00:00:00") : new Date(0);
  const to   = customTo   ? new Date(customTo   + "T23:59:59") : now;
  return { from, to };
}

function filterLabel(preset: FilterPreset, customFrom: string, customTo: string): string {
  if (preset === "today")  return "Today";
  if (preset === "7d")     return "Last 7 days";
  if (preset === "30d")    return "Last 30 days";
  if (customFrom && customTo) return `${customFrom} → ${customTo}`;
  return "Custom range";
}

// ── Category card colours ──────────────────────────────────────────────────────
const CAT_COLORS: Record<string, string> = {
  Synthetics: "#06b6d4",
  Forex:      "#8b5cf6",
  Commodities:"#f59e0b",
  Derived:    "#10b981",
};

// ── Filter bar ────────────────────────────────────────────────────────────────
function FilterBar({
  preset, setPreset, customFrom, setCustomFrom, customTo, setCustomTo, tradeCount,
}: {
  preset: FilterPreset;
  setPreset: (p: FilterPreset) => void;
  customFrom: string;
  setCustomFrom: (v: string) => void;
  customTo: string;
  setCustomTo: (v: string) => void;
  tradeCount: number;
}) {
  const presets: { key: FilterPreset; label: string }[] = [
    { key: "today", label: "Today" },
    { key: "7d",    label: "7 Days" },
    { key: "30d",   label: "30 Days" },
    { key: "custom",label: "Custom" },
  ];

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-1.5">
        <Filter className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground font-medium">Period:</span>
      </div>
      <div className="flex gap-1">
        {presets.map(p => (
          <button
            key={p.key}
            onClick={() => setPreset(p.key)}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
              preset === p.key
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {preset === "custom" && (
        <div className="flex items-center gap-2">
          <Calendar className="w-3.5 h-3.5 text-muted-foreground" />
          <input
            type="date"
            value={customFrom}
            onChange={e => setCustomFrom(e.target.value)}
            className="bg-secondary border border-border rounded px-2 py-1 text-xs text-foreground"
          />
          <span className="text-xs text-muted-foreground">→</span>
          <input
            type="date"
            value={customTo}
            onChange={e => setCustomTo(e.target.value)}
            className="bg-secondary border border-border rounded px-2 py-1 text-xs text-foreground"
          />
        </div>
      )}

      <span className="ml-auto text-xs text-muted-foreground">
        {tradeCount} trade{tradeCount !== 1 ? "s" : ""} in period
      </span>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function Analytics() {
  const { data: drawdown } = useGetDrawdownAnalysis({ query: { refetchInterval: 15000 } } as { query: any });
  const { trades: allTrades, isLoading } = useJournalTrades();

  // Filter state
  const [filterPreset, setFilterPreset] = useState<FilterPreset>("30d");
  const [customFrom, setCustomFrom]     = useState<string>("");
  const [customTo, setCustomTo]         = useState<string>("");

  // Apply filter to trades
  const filteredTrades = useMemo(() => {
    if (allTrades.length === 0) return [];
    const { from, to } = getFilterBounds(filterPreset, customFrom, customTo);
    return allTrades.filter(t => {
      const d = new Date(t.createdAt);
      return d >= from && d <= to;
    });
  }, [allTrades, filterPreset, customFrom, customTo]);

  // Build analytics from filtered trades
  const { stats, profitCurve, winRateHistory, categoryBreakdown, marketBreakdown } = useMemo(
    () => buildAnalytics(filteredTrades),
    [filteredTrades],
  );

  // Today's stats always computed from ALL trades so the card is correct regardless of filter
  const todayStats = useMemo(() => {
    if (allTrades.length === 0) return null;
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayTrades = allTrades.filter(t => new Date(t.createdAt) >= todayStart);
    const todayWon    = todayTrades.filter(t => t.won).length;
    const todayLost   = todayTrades.filter(t => !t.won).length;
    const todayProfit = Math.round(todayTrades.reduce((s: number, t: any) => s + (t.profit ?? 0), 0) * 100) / 100;
    return { total: todayTrades.length, won: todayWon, lost: todayLost, profit: todayProfit };
  }, [allTrades]);

  // Consecutive losses from filtered stats streak
  const consecutiveLosses = stats ? (stats.currentStreak < 0 ? Math.abs(stats.currentStreak) : 0) : null;
  const consecutiveWins   = stats ? (stats.currentStreak > 0 ? stats.currentStreak : 0) : null;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-6 max-w-7xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Performance analytics — data sourced from Trade Journal.{" "}
          {allTrades.length > 0 && (
            <span className="text-primary">{allTrades.length} total trades available.</span>
          )}
        </p>
      </div>

      {/* ── Filter bar ─────────────────────────────────────────────────────── */}
      <Card className="bg-card">
        <CardContent className="p-3">
          <FilterBar
            preset={filterPreset}
            setPreset={setFilterPreset}
            customFrom={customFrom}
            setCustomFrom={setCustomFrom}
            customTo={customTo}
            setCustomTo={setCustomTo}
            tradeCount={filteredTrades.length}
          />
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
          <Activity className="w-4 h-4 animate-spin mr-2" />
          Loading trade data…
        </div>
      ) : filteredTrades.length === 0 ? (
        <Card className="bg-card">
          <CardContent className="py-12 flex items-center justify-center">
            <p className="text-sm text-muted-foreground">No trades found in the selected period.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* ── Headline stats ─────────────────────────────────────────────── */}
          {stats && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                {
                  label: "Win Rate",
                  value: `${(stats.winRate * 100).toFixed(1)}%`,
                  sub: `${stats.wonTrades}W / ${stats.lostTrades}L · ${stats.totalTrades} trades`,
                  color: stats.winRate >= 0.55 ? "text-green-500" : stats.winRate >= 0.45 ? "text-amber-500" : "text-red-400",
                },
                {
                  label: "Net Profit",
                  value: `${stats.totalProfit >= 0 ? "+" : ""}${stats.totalProfit.toFixed(2)}`,
                  sub: `avg ${stats.avgProfit >= 0 ? "+" : ""}${stats.avgProfit.toFixed(2)}/trade`,
                  color: stats.totalProfit >= 0 ? "text-green-500" : "text-red-500",
                },
                {
                  label: "Best Trade",
                  value: `+${stats.bestTrade.toFixed(2)}`,
                  sub: `worst: ${stats.worstTrade.toFixed(2)}`,
                  color: "text-green-500",
                },
                {
                  label: "Current Streak",
                  value: stats.currentStreak === 0 ? "0" : `${stats.currentStreak > 0 ? "+" : ""}${stats.currentStreak}`,
                  sub: `longest win: ${stats.longestWinStreak}`,
                  color: stats.currentStreak > 0 ? "text-green-500" : stats.currentStreak < 0 ? "text-red-400" : "text-muted-foreground",
                },
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

          {/* ── Category performance breakdown ─────────────────────────────── */}
          {categoryBreakdown.length > 0 && (
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2 font-medium">
                Performance by Category — {filterLabel(filterPreset, customFrom, customTo)}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {(["Synthetics", "Forex", "Commodities", "Derived"] as const).map((cat) => {
                  const c = categoryBreakdown.find(x => x.name === cat);
                  const color = CAT_COLORS[cat];
                  if (!c) return (
                    <Card key={cat} className="bg-card opacity-40">
                      <CardContent className="p-4">
                        <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{cat}</div>
                        <div className="text-sm text-muted-foreground">No trades</div>
                      </CardContent>
                    </Card>
                  );
                  const wr = (c.winRate * 100).toFixed(1);
                  const pnlColor = c.pnl >= 0 ? "text-green-500" : "text-red-400";
                  return (
                    <Card key={cat} className="bg-card" style={{ borderColor: color + "30" }}>
                      <CardContent className="p-4">
                        <div className="flex items-center gap-1.5 mb-2">
                          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                          <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{cat}</div>
                        </div>
                        <div className={`text-xl font-mono font-bold ${pnlColor}`}>
                          {c.pnl >= 0 ? "+" : ""}{c.pnl.toFixed(2)}
                        </div>
                        <div className="text-[11px] text-muted-foreground">{c.total} trades · {wr}% win</div>
                        <div className="mt-2 h-1 w-full bg-secondary rounded-full overflow-hidden">
                          <div className="h-full rounded-full transition-all" style={{ width: `${c.winRate * 100}%`, backgroundColor: color }} />
                        </div>
                        <div className="flex justify-between text-[9px] text-muted-foreground mt-0.5">
                          <span>{c.wins}W</span>
                          <span>{c.losses}L</span>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── P&L curve + Win rate history ───────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="bg-card">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <TrendingUp className="w-3.5 h-3.5 text-primary" /> Cumulative P&amp;L
                </CardTitle>
              </CardHeader>
              <CardContent className="h-[200px]">
                {profitCurve.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={profitCurve} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                      <defs>
                        <linearGradient id="profitGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%"  stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <XAxis dataKey="date" hide />
                      <YAxis tick={{ fontSize: 10 }} />
                      <Tooltip {...CHART_STYLE} formatter={(v: number) => [`$${v.toFixed(2)}`, "Cumulative P&L"]} />
                      <Area type="monotone" dataKey="cumulativeProfit" stroke="hsl(var(--primary))" fill="url(#profitGrad)" strokeWidth={2} dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex items-center justify-center h-full text-muted-foreground text-sm">No data</div>
                )}
              </CardContent>
            </Card>

            <Card className="bg-card">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <Activity className="w-3.5 h-3.5 text-green-500" /> Rolling 7-Day Win Rate
                </CardTitle>
              </CardHeader>
              <CardContent className="h-[200px]">
                {winRateHistory.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={winRateHistory} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                      <XAxis dataKey="date" hide />
                      <YAxis domain={[0, 1]} tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} tick={{ fontSize: 10 }} />
                      <Tooltip {...CHART_STYLE} formatter={(v: number) => [`${(v * 100).toFixed(1)}%`, "Win Rate"]} />
                      <CartesianGrid strokeDasharray="3 3" stroke="#1c1c1e" vertical={false} />
                      <Line type="monotone" dataKey="winRate" stroke="#10b981" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex items-center justify-center h-full text-muted-foreground text-sm">No data</div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* ── Market breakdown + Drawdown ─────────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card className="lg:col-span-2 bg-card">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">P&amp;L by Market (Top 12)</CardTitle>
              </CardHeader>
              <CardContent className="h-[250px]">
                {marketBreakdown.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={marketBreakdown} margin={{ top: 5, right: 5, left: -20, bottom: 24 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1c1c1e" vertical={false} />
                      <XAxis dataKey="symbol" tick={{ fontSize: 9, fill: "#71717a" }} angle={-35} textAnchor="end" />
                      <YAxis tick={{ fontSize: 10 }} />
                      <Tooltip {...CHART_STYLE} formatter={(v: number) => [`$${v.toFixed(2)}`, "P&L"]} />
                      <Bar dataKey="totalProfit" radius={[3, 3, 0, 0]}>
                        {marketBreakdown.map((entry, i) => (
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
                  <Shield className="w-3.5 h-3.5" /> Risk Monitor
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {drawdown ? (
                  <>
                    {drawdown.isAtRisk && (
                      <div className="flex items-center gap-2 p-2 rounded bg-red-500/10 border border-red-500/20">
                        <AlertTriangle className="w-3.5 h-3.5 text-red-500" />
                        <span className="text-xs text-red-400">Approaching drawdown limit</span>
                      </div>
                    )}
                    {[
                      { label: "Current Drawdown", value: drawdown.currentDrawdown, limit: drawdown.drawdownLimit, color: "bg-red-500" },
                      { label: "Max Drawdown",     value: drawdown.maxDrawdown,     limit: drawdown.drawdownLimit, color: "bg-amber-500" },
                      { label: "Risk Exposure",    value: drawdown.riskExposure,    limit: 100,                    color: "bg-orange-500" },
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

                    {stats && (
                      <div className="pt-3 border-t border-border grid grid-cols-2 gap-3">
                        <div>
                          <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Consec. Losses</div>
                          <div className="flex items-baseline gap-1.5">
                            <span className={`text-2xl font-mono font-bold ${consecutiveLosses! >= drawdown.consecutiveLossLimit ? "text-red-500" : consecutiveLosses! > 0 ? "text-amber-500" : "text-muted-foreground"}`}>
                              {consecutiveLosses}
                            </span>
                            <span className="text-xs text-muted-foreground">/ {drawdown.consecutiveLossLimit}</span>
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Consec. Wins</div>
                          <div className="flex items-baseline gap-1.5">
                            <span className={`text-2xl font-mono font-bold ${consecutiveWins! > 0 ? "text-green-500" : "text-muted-foreground"}`}>
                              {consecutiveWins}
                            </span>
                            <span className="text-xs text-muted-foreground">streak</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-sm text-muted-foreground py-4">Loading risk data…</div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* ── Daily P&L breakdown + Today's Summary ──────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="bg-card">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <TrendingUp className="w-3.5 h-3.5 text-primary" /> Daily P&amp;L Breakdown
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1 max-h-52 overflow-y-auto">
                  {[...profitCurve].reverse().slice(0, 30).map((day) => (
                    <div key={day.date} className="flex items-center gap-3 py-1.5 border-b border-border/40 last:border-0">
                      <span className="text-[10px] font-mono text-muted-foreground w-20 shrink-0">{day.date}</span>
                      <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${day.dailyProfit >= 0 ? "bg-green-500" : "bg-red-500"}`}
                          style={{ width: `${Math.min(100, Math.abs(day.dailyProfit) * 8)}%` }} />
                      </div>
                      <div className="flex gap-2 items-center shrink-0">
                        <span className="text-[9px] text-muted-foreground">{day.tradeCount}t</span>
                        <span className={`text-[10px] font-mono w-14 text-right ${day.dailyProfit >= 0 ? "text-green-400" : "text-red-400"}`}>
                          {day.dailyProfit >= 0 ? "+" : ""}{day.dailyProfit.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card className="bg-card">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <TrendingDown className="w-3.5 h-3.5 text-amber-500" /> Today's Summary
                </CardTitle>
              </CardHeader>
              <CardContent>
                {todayStats && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-3 gap-3 text-center">
                      {[
                        { label: "Trades", value: todayStats.total,  color: "text-foreground" },
                        { label: "Won",    value: todayStats.won,    color: "text-green-500" },
                        { label: "Lost",   value: todayStats.lost,   color: "text-red-400" },
                      ].map(s => (
                        <div key={s.label} className="p-2 rounded-lg bg-secondary/30 border border-border">
                          <div className="text-[10px] text-muted-foreground mb-0.5">{s.label}</div>
                          <div className={`text-2xl font-mono font-bold ${s.color}`}>{s.value}</div>
                        </div>
                      ))}
                    </div>
                    <div className="p-3 rounded-lg bg-secondary/30 border border-border text-center">
                      <div className="text-[10px] text-muted-foreground mb-0.5">Today's P&L</div>
                      <div className={`text-3xl font-mono font-bold ${todayStats.profit >= 0 ? "text-green-500" : "text-red-400"}`}>
                        {todayStats.profit >= 0 ? "+" : ""}{todayStats.profit.toFixed(2)}
                      </div>
                    </div>
                    {todayStats.total > 0 && (
                      <div>
                        <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
                          <span>Today's win rate</span>
                          <span>{((todayStats.won / todayStats.total) * 100).toFixed(1)}%</span>
                        </div>
                        <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                          <div className="h-full rounded-full bg-green-500" style={{ width: `${(todayStats.won / todayStats.total) * 100}%` }} />
                        </div>
                      </div>
                    )}
                    {/* Period summary vs today */}
                    {filterPreset !== "today" && (
                      <div className="pt-2 border-t border-border text-center">
                        <div className="text-[10px] text-muted-foreground mb-1">
                          {filterLabel(filterPreset, customFrom, customTo)} total
                        </div>
                        <div className={`text-lg font-mono font-bold ${stats.totalProfit >= 0 ? "text-green-500" : "text-red-400"}`}>
                          {stats.totalProfit >= 0 ? "+" : ""}{stats.totalProfit.toFixed(2)}
                        </div>
                        <div className="text-[10px] text-muted-foreground">{stats.totalTrades} trades · {(stats.winRate * 100).toFixed(1)}% win rate</div>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </motion.div>
  );
}
