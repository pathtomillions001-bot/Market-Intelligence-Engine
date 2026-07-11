import { useGetDrawdownAnalysis } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, BarChart, Bar, CartesianGrid, Cell,
  LineChart, Line, ReferenceLine,
} from "recharts";
import {
  TrendingUp, TrendingDown, Activity, Calendar, Shield,
  AlertTriangle, Zap, Target, BarChart3,
} from "lucide-react";
import { useMemo, useState } from "react";

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

type FilterPreset = "today" | "week" | "month" | "custom";

function toLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function getFilterBounds(preset: FilterPreset, customFrom: string, customTo: string): { from: Date; to: Date } {
  const now = new Date();
  if (preset === "today") {
    const from = new Date(now); from.setHours(0, 0, 0, 0);
    return { from, to: now };
  }
  if (preset === "week") {
    const from = new Date(now); from.setDate(from.getDate() - 7); from.setHours(0, 0, 0, 0);
    return { from, to: now };
  }
  if (preset === "month") {
    const from = new Date(now); from.setDate(from.getDate() - 30); from.setHours(0, 0, 0, 0);
    return { from, to: now };
  }
  const from = customFrom ? new Date(customFrom + "T00:00:00") : new Date(0);
  const to   = customTo   ? new Date(customTo   + "T23:59:59") : now;
  return { from, to };
}

function filterLabel(preset: FilterPreset, customFrom: string, customTo: string): string {
  if (preset === "today")  return "Today";
  if (preset === "week")   return "Last 7 days";
  if (preset === "month")  return "Last 30 days";
  if (customFrom && customTo) return `${customFrom} → ${customTo}`;
  return "Custom range";
}

// ── Stats computation ─────────────────────────────────────────────────────────
function computeStats(trades: any[]) {
  const won = trades.filter(t => t.won);
  const lost = trades.filter(t => !t.won);
  const totalProfit = trades.reduce((s, t) => s + (t.profit ?? 0), 0);

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
    } else runLen++;
  }
  if (runWon === true)  longestWin  = Math.max(longestWin, runLen);
  if (runWon === false) longestLoss = Math.max(longestLoss, runLen);

  return {
    totalTrades: trades.length, wonTrades: won.length, lostTrades: lost.length,
    winRate: trades.length > 0 ? won.length / trades.length : 0,
    totalProfit: Math.round(totalProfit * 100) / 100,
    avgProfit: trades.length > 0 ? Math.round((totalProfit / trades.length) * 100) / 100 : 0,
    bestTrade:  won.length  > 0 ? Math.max(...won.map(t => t.profit ?? 0))  : 0,
    worstTrade: lost.length > 0 ? Math.min(...lost.map(t => t.profit ?? 0)) : 0,
    currentStreak, longestWinStreak: longestWin, longestLoseStreak: longestLoss,
  };
}

function buildAnalytics(trades: any[]) {
  if (trades.length === 0) return { stats: null, profitCurve: [], winRateHistory: [], categoryBreakdown: [], marketBreakdown: [] };

  const sorted = [...trades].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const byDate: Record<string, { wins: number; losses: number; pnl: number }> = {};
  for (const t of sorted) {
    const date = toLocalDate(new Date(t.createdAt));
    if (!byDate[date]) byDate[date] = { wins: 0, losses: 0, pnl: 0 };
    byDate[date].pnl += t.profit ?? 0;
    if (t.won) byDate[date].wins++; else byDate[date].losses++;
  }

  let cumulative = 0;
  const profitCurve = Object.entries(byDate).map(([date, d]) => {
    cumulative += d.pnl;
    return { date, dailyProfit: Math.round(d.pnl*100)/100, cumulativeProfit: Math.round(cumulative*100)/100, tradeCount: d.wins+d.losses, wins: d.wins, losses: d.losses };
  });

  const winRateHistory = profitCurve.map((_, i) => {
    const window = profitCurve.slice(Math.max(0, i - 6), i + 1);
    const wW = window.reduce((s, d) => s + d.wins, 0);
    const wT = window.reduce((s, d) => s + d.tradeCount, 0);
    return { date: profitCurve[i].date, winRate: wT > 0 ? Math.round(wW/wT*100) : 0 };
  });

  const catMap: Record<string, { wins: number; losses: number; pnl: number }> = {
    Synthetics: { wins:0,losses:0,pnl:0 }, Forex: { wins:0,losses:0,pnl:0 },
    Commodities: { wins:0,losses:0,pnl:0 }, Derived: { wins:0,losses:0,pnl:0 },
  };
  for (const t of trades) {
    const cat = classifySymbol(t.symbol ?? "");
    catMap[cat].pnl += t.profit ?? 0;
    if (t.won) catMap[cat].wins++; else catMap[cat].losses++;
  }
  const categoryBreakdown = Object.entries(catMap)
    .map(([name, d]) => { const total = d.wins+d.losses; return { name, wins: d.wins, losses: d.losses, total, pnl: Math.round(d.pnl*100)/100, winRate: total > 0 ? d.wins/total : 0 }; })
    .filter(c => c.total > 0).sort((a,b) => b.pnl - a.pnl);

  const symMap: Record<string, { wins:number;losses:number;pnl:number;display:string }> = {};
  for (const t of trades) {
    if (!symMap[t.symbol]) symMap[t.symbol] = { wins:0,losses:0,pnl:0,display:t.displayName??t.symbol };
    symMap[t.symbol].pnl += t.profit ?? 0;
    if (t.won) symMap[t.symbol].wins++; else symMap[t.symbol].losses++;
  }
  const marketBreakdown = Object.entries(symMap)
    .map(([symbol, d]) => ({ symbol, displayName: d.display, wins: d.wins, losses: d.losses, total: d.wins+d.losses, totalProfit: Math.round(d.pnl*100)/100 }))
    .sort((a,b) => b.total - a.total).slice(0, 12);

  const newestFirst = [...trades].sort((a,b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const stats = computeStats(newestFirst);

  return { stats, profitCurve, winRateHistory, categoryBreakdown, marketBreakdown };
}

// ── Trade data hook ───────────────────────────────────────────────────────────
function useJournalTrades() {
  const { data: dbData, isLoading: dbLoading } = useQuery({
    queryKey: ["analytics-db-trades"],
    queryFn: () => fetch("/api/trades?limit=500").then(r => r.json()),
    refetchInterval: 20_000, staleTime: 10_000,
  });
  const trades: any[] = Array.isArray(dbData) ? dbData.filter((t: any) => t.status === "won" || t.status === "lost") : [];
  return { trades, isLoading: dbLoading };
}

// ── Chart tooltip style ───────────────────────────────────────────────────────
const TOOLTIP = {
  contentStyle: { backgroundColor: "#0c0c0e", border: "1px solid #27272a", borderRadius: "8px", fontSize: "11px", padding: "8px 12px" },
  labelStyle: { color: "#52525b", marginBottom: "4px" },
  cursor: { stroke: "hsl(var(--primary))", strokeWidth: 1, strokeDasharray: "4 2" },
};

// ── Category colors ───────────────────────────────────────────────────────────
const CAT_COLORS: Record<string, string> = {
  Synthetics: "#06b6d4", Forex: "#8b5cf6", Commodities: "#f59e0b", Derived: "#10b981",
};

// ── Period selector ───────────────────────────────────────────────────────────
function PeriodSelector({
  preset, setPreset, customFrom, setCustomFrom, customTo, setCustomTo, tradeCount,
}: {
  preset: FilterPreset; setPreset: (p: FilterPreset) => void;
  customFrom: string; setCustomFrom: (v: string) => void;
  customTo: string; setCustomTo: (v: string) => void;
  tradeCount: number;
}) {
  const tabs: { key: FilterPreset; label: string }[] = [
    { key: "today", label: "Daily" },
    { key: "week",  label: "Weekly" },
    { key: "month", label: "Monthly" },
    { key: "custom",label: "Custom" },
  ];

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Tab row */}
      <div className="flex rounded-lg border border-border/50 overflow-hidden">
        {tabs.map(p => (
          <button
            key={p.key}
            onClick={() => setPreset(p.key)}
            className={`px-4 py-1.5 text-xs font-semibold transition-colors ${
              preset === p.key
                ? "bg-primary text-primary-foreground"
                : "bg-secondary/30 text-muted-foreground hover:text-foreground hover:bg-secondary/60"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {preset === "custom" && (
        <div className="flex items-center gap-2">
          <Calendar className="w-3.5 h-3.5 text-muted-foreground" />
          <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
            className="bg-secondary border border-border rounded-lg px-2.5 py-1.5 text-xs text-foreground" />
          <span className="text-xs text-muted-foreground">→</span>
          <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
            className="bg-secondary border border-border rounded-lg px-2.5 py-1.5 text-xs text-foreground" />
        </div>
      )}

      <span className="ml-auto text-xs text-muted-foreground font-mono">
        {tradeCount} trade{tradeCount !== 1 ? "s" : ""}
      </span>
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, color, icon: Icon, accent }: {
  label: string; value: string; sub?: string; color: string;
  icon: React.ComponentType<{ className?: string }>; accent: string;
}) {
  return (
    <div className={`rounded-xl border border-border/60 p-4 bg-gradient-to-br ${accent} to-card/80`}>
      <div className="flex items-start justify-between mb-2">
        <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-medium">{label}</p>
        <Icon className={`w-4 h-4 ${color}`} />
      </div>
      <p className={`text-2xl font-mono font-bold leading-none ${color}`}>{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground mt-1.5 leading-snug">{sub}</p>}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Analytics() {
  const { data: drawdown } = useGetDrawdownAnalysis({ query: { refetchInterval: 15000 } } as { query: any });
  const { trades: allTrades, isLoading } = useJournalTrades();

  const [filterPreset, setFilterPreset] = useState<FilterPreset>("month");
  const [customFrom, setCustomFrom]     = useState<string>("");
  const [customTo, setCustomTo]         = useState<string>("");

  const filteredTrades = useMemo(() => {
    if (allTrades.length === 0) return [];
    const { from, to } = getFilterBounds(filterPreset, customFrom, customTo);
    return allTrades.filter(t => { const d = new Date(t.createdAt); return d >= from && d <= to; });
  }, [allTrades, filterPreset, customFrom, customTo]);

  const { stats, profitCurve, winRateHistory, categoryBreakdown, marketBreakdown } = useMemo(
    () => buildAnalytics(filteredTrades), [filteredTrades],
  );

  const todayStats = useMemo(() => {
    if (allTrades.length === 0) return null;
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const t = allTrades.filter(t => new Date(t.createdAt) >= todayStart);
    const won = t.filter(t => t.won).length;
    return { total: t.length, won, lost: t.length - won, profit: Math.round(t.reduce((s,x)=>s+(x.profit??0),0)*100)/100 };
  }, [allTrades]);

  const consecutiveLosses = stats ? (stats.currentStreak < 0 ? Math.abs(stats.currentStreak) : 0) : 0;
  const consecutiveWins   = stats ? (stats.currentStreak > 0 ? stats.currentStreak : 0) : 0;

  const periodLabel = filterLabel(filterPreset, customFrom, customTo);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 md:p-6 max-w-7xl mx-auto space-y-5">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2.5">
            <BarChart3 className="w-6 h-6 text-primary" />
            Analytics
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {allTrades.length > 0
              ? <><span className="text-primary font-medium">{allTrades.length}</span> trades in database · {periodLabel}</>
              : "Performance analytics — data sourced from Trade Journal"
            }
          </p>
        </div>
        {todayStats && todayStats.total > 0 && (
          <div className="text-right">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Today</p>
            <p className={`text-2xl font-mono font-bold ${todayStats.profit >= 0 ? "text-green-400" : "text-red-400"}`}>
              {todayStats.profit >= 0 ? "+" : ""}{todayStats.profit.toFixed(2)}
            </p>
            <p className="text-[10px] text-muted-foreground">{todayStats.won}W · {todayStats.lost}L</p>
          </div>
        )}
      </div>

      {/* ── Period selector ─────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border/50 bg-secondary/10 p-3">
        <PeriodSelector
          preset={filterPreset} setPreset={setFilterPreset}
          customFrom={customFrom} setCustomFrom={setCustomFrom}
          customTo={customTo} setCustomTo={setCustomTo}
          tradeCount={filteredTrades.length}
        />
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-48 text-muted-foreground text-sm gap-2">
          <Activity className="w-4 h-4 animate-spin" />
          Loading trade data…
        </div>
      ) : filteredTrades.length === 0 ? (
        <div className="rounded-xl border border-border/50 bg-card py-16 flex flex-col items-center justify-center gap-3">
          <BarChart3 className="w-10 h-10 text-muted-foreground/20" />
          <p className="text-sm text-muted-foreground">No trades found in the selected period.</p>
          <button onClick={() => setFilterPreset("month")} className="text-xs text-primary hover:underline">
            Switch to Monthly view
          </button>
        </div>
      ) : (
        <>
          {/* ── Key metrics row ──────────────────────────────────────────── */}
          {stats && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard
                label="Win Rate" icon={Target}
                value={`${(stats.winRate * 100).toFixed(1)}%`}
                sub={`${stats.wonTrades}W / ${stats.lostTrades}L · ${stats.totalTrades} trades`}
                color={stats.winRate >= 0.55 ? "text-green-400" : stats.winRate >= 0.45 ? "text-amber-400" : "text-red-400"}
                accent={stats.winRate >= 0.55 ? "from-green-500/8" : "from-amber-500/8"}
              />
              <StatCard
                label="Net Profit" icon={stats.totalProfit >= 0 ? TrendingUp : TrendingDown}
                value={`${stats.totalProfit >= 0 ? "+" : ""}${stats.totalProfit.toFixed(2)}`}
                sub={`avg ${stats.avgProfit >= 0 ? "+" : ""}${stats.avgProfit.toFixed(2)} per trade`}
                color={stats.totalProfit >= 0 ? "text-green-400" : "text-red-400"}
                accent={stats.totalProfit >= 0 ? "from-green-500/8" : "from-red-500/8"}
              />
              <StatCard
                label="Best Trade" icon={Zap}
                value={`+${stats.bestTrade.toFixed(2)}`}
                sub={`worst: ${stats.worstTrade.toFixed(2)}`}
                color="text-primary"
                accent="from-primary/8"
              />
              <StatCard
                label="Streak" icon={Activity}
                value={stats.currentStreak === 0 ? "0" : `${stats.currentStreak > 0 ? "+" : ""}${stats.currentStreak}`}
                sub={`Best win streak: ${stats.longestWinStreak}`}
                color={stats.currentStreak > 0 ? "text-green-400" : stats.currentStreak < 0 ? "text-red-400" : "text-muted-foreground"}
                accent={stats.currentStreak > 0 ? "from-green-500/8" : stats.currentStreak < 0 ? "from-red-500/8" : "from-secondary/20"}
              />
            </motion.div>
          )}

          {/* ── P&L curve + Win rate ─────────────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* P&L area chart */}
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}
              className="rounded-xl border border-border/50 bg-card p-4">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <p className="text-xs font-semibold text-foreground">Cumulative P&amp;L</p>
                  <p className="text-[10px] text-muted-foreground">{periodLabel}</p>
                </div>
                {stats && (
                  <span className={`text-sm font-mono font-bold ${stats.totalProfit >= 0 ? "text-green-400" : "text-red-400"}`}>
                    {stats.totalProfit >= 0 ? "+" : ""}{stats.totalProfit.toFixed(2)}
                  </span>
                )}
              </div>
              <div className="h-[180px]">
                {profitCurve.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={profitCurve} margin={{ top: 4, right: 4, left: -22, bottom: 0 }}>
                      <defs>
                        <linearGradient id="pnlUp" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%"   stopColor="#10b981" stopOpacity={0.3} />
                          <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="pnlDown" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%"   stopColor="#ef4444" stopOpacity={0.3} />
                          <stop offset="100%" stopColor="#ef4444" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <XAxis dataKey="date" hide />
                      <YAxis tick={{ fontSize: 9, fill: "#52525b" }} />
                      <Tooltip {...TOOLTIP} formatter={(v: number) => [`$${v.toFixed(2)}`, "P&L"]} />
                      <ReferenceLine y={0} stroke="#3f3f46" strokeDasharray="3 3" />
                      <Area type="monotone" dataKey="cumulativeProfit"
                        stroke={stats && stats.totalProfit >= 0 ? "#10b981" : "#ef4444"}
                        fill={stats && stats.totalProfit >= 0 ? "url(#pnlUp)" : "url(#pnlDown)"}
                        strokeWidth={2} dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex items-center justify-center h-full text-muted-foreground/50 text-xs">No data</div>
                )}
              </div>
            </motion.div>

            {/* Win rate line chart */}
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.15 }}
              className="rounded-xl border border-border/50 bg-card p-4">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <p className="text-xs font-semibold text-foreground">Win Rate Trend</p>
                  <p className="text-[10px] text-muted-foreground">7-session rolling average</p>
                </div>
                {stats && (
                  <span className={`text-sm font-mono font-bold ${stats.winRate >= 0.55 ? "text-green-400" : stats.winRate >= 0.45 ? "text-amber-400" : "text-red-400"}`}>
                    {(stats.winRate * 100).toFixed(1)}%
                  </span>
                )}
              </div>
              <div className="h-[180px]">
                {winRateHistory.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={winRateHistory} margin={{ top: 4, right: 4, left: -22, bottom: 0 }}>
                      <XAxis dataKey="date" hide />
                      <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: "#52525b" }}
                        tickFormatter={v => `${v}%`} />
                      <Tooltip {...TOOLTIP} formatter={(v: number) => [`${v}%`, "Win Rate"]} />
                      <CartesianGrid strokeDasharray="3 3" stroke="#1c1c1e" vertical={false} />
                      <ReferenceLine y={50} stroke="#3f3f46" strokeDasharray="4 2" />
                      <Line type="monotone" dataKey="winRate" stroke="#06b6d4" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex items-center justify-center h-full text-muted-foreground/50 text-xs">No data</div>
                )}
              </div>
            </motion.div>
          </div>

          {/* ── Category performance ─────────────────────────────────────── */}
          {categoryBreakdown.length > 0 && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }}>
              <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-medium mb-3">
                Performance by Market Category — {periodLabel}
              </p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {(["Synthetics", "Forex", "Commodities", "Derived"] as const).map(cat => {
                  const c = categoryBreakdown.find(x => x.name === cat);
                  const color = CAT_COLORS[cat];
                  if (!c) return (
                    <div key={cat} className="rounded-xl border border-border/30 bg-card/50 p-4 opacity-40">
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{cat}</div>
                      <div className="text-xs text-muted-foreground">No trades</div>
                    </div>
                  );
                  return (
                    <div key={cat} className="rounded-xl border bg-card p-4 transition-all"
                      style={{ borderColor: color + "30", background: color + "06" }}>
                      <div className="flex items-center gap-1.5 mb-2">
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{cat}</span>
                      </div>
                      <div className={`text-xl font-mono font-bold ${c.pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                        {c.pnl >= 0 ? "+" : ""}{c.pnl.toFixed(2)}
                      </div>
                      <div className="text-[10px] text-muted-foreground mt-0.5">{c.total} trades · {(c.winRate*100).toFixed(1)}% win</div>
                      <div className="mt-2 h-1.5 w-full bg-secondary/50 rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${c.winRate*100}%`, backgroundColor: color }} />
                      </div>
                      <div className="flex justify-between text-[9px] text-muted-foreground mt-0.5">
                        <span>{c.wins}W</span><span>{c.losses}L</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          )}

          {/* ── Market breakdown + Risk ──────────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Bar chart */}
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.25 }}
              className="lg:col-span-2 rounded-xl border border-border/50 bg-card p-4">
              <p className="text-xs font-semibold text-foreground mb-1">P&amp;L by Market</p>
              <p className="text-[10px] text-muted-foreground mb-4">Top 12 most-traded symbols</p>
              <div className="h-[220px]">
                {marketBreakdown.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={marketBreakdown} margin={{ top: 4, right: 4, left: -22, bottom: 28 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1c1c1e" vertical={false} />
                      <XAxis dataKey="symbol" tick={{ fontSize: 8, fill: "#71717a" }} angle={-35} textAnchor="end" />
                      <YAxis tick={{ fontSize: 9, fill: "#52525b" }} />
                      <Tooltip {...TOOLTIP} formatter={(v: number) => [`$${v.toFixed(2)}`, "P&L"]} />
                      <ReferenceLine y={0} stroke="#3f3f46" />
                      <Bar dataKey="totalProfit" radius={[3, 3, 0, 0]}>
                        {marketBreakdown.map((entry, i) => (
                          <Cell key={i} fill={entry.totalProfit >= 0 ? "#10b981" : "#ef4444"} opacity={0.85} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex items-center justify-center h-full text-muted-foreground/50 text-xs">No data</div>
                )}
              </div>
            </motion.div>

            {/* Risk & streak panel */}
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }}
              className="rounded-xl border border-border/50 bg-card p-4 space-y-4">
              <div>
                <div className="flex items-center gap-1.5 mb-3">
                  <Shield className="w-3.5 h-3.5 text-muted-foreground" />
                  <p className="text-xs font-semibold text-foreground">Risk Monitor</p>
                </div>
                {drawdown ? (
                  <div className="space-y-3">
                    {drawdown.isAtRisk && (
                      <div className="flex items-center gap-2 p-2 rounded-lg bg-red-500/10 border border-red-500/20">
                        <AlertTriangle className="w-3.5 h-3.5 text-red-500 shrink-0" />
                        <span className="text-[10px] text-red-400">Approaching drawdown limit</span>
                      </div>
                    )}
                    {[
                      { label: "Current Drawdown", value: drawdown.currentDrawdown, limit: drawdown.drawdownLimit, color: "bg-red-500" },
                      { label: "Max Drawdown",     value: drawdown.maxDrawdown,     limit: drawdown.drawdownLimit, color: "bg-amber-500" },
                      { label: "Risk Exposure",    value: drawdown.riskExposure,    limit: 100,                    color: "bg-orange-500" },
                    ].map(item => (
                      <div key={item.label}>
                        <div className="flex justify-between text-[10px] mb-1">
                          <span className="text-muted-foreground">{item.label}</span>
                          <span className="font-mono font-semibold">{item.value.toFixed(2)}%</span>
                        </div>
                        <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${item.color}`}
                            style={{ width: `${Math.min((item.value/item.limit)*100, 100)}%`, transition: "width 0.4s ease" }} />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">Loading risk data…</p>
                )}
              </div>

              {/* Streak summary */}
              <div className="border-t border-border pt-3">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">Current Streak</p>
                <div className="grid grid-cols-2 gap-2 text-center">
                  <div className="rounded-lg bg-secondary/40 py-2.5">
                    <p className={`text-xl font-mono font-bold ${consecutiveLosses >= (drawdown?.consecutiveLossLimit ?? 99) ? "text-red-500" : consecutiveLosses > 0 ? "text-amber-400" : "text-muted-foreground"}`}>
                      {consecutiveLosses}
                    </p>
                    <p className="text-[9px] text-muted-foreground mt-0.5">Losses</p>
                  </div>
                  <div className="rounded-lg bg-secondary/40 py-2.5">
                    <p className={`text-xl font-mono font-bold ${consecutiveWins > 0 ? "text-green-400" : "text-muted-foreground"}`}>
                      {consecutiveWins}
                    </p>
                    <p className="text-[9px] text-muted-foreground mt-0.5">Wins</p>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>

          {/* ── Daily P&L log + Period summary ──────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Daily log table */}
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.35 }}
              className="rounded-xl border border-border/50 bg-card p-4">
              <p className="text-xs font-semibold text-foreground mb-1">Daily P&amp;L Log</p>
              <p className="text-[10px] text-muted-foreground mb-3">{periodLabel}</p>
              <div className="space-y-0.5 max-h-56 overflow-y-auto pr-1">
                {[...profitCurve].reverse().slice(0, 30).map(day => (
                  <div key={day.date} className="flex items-center gap-3 py-1.5 border-b border-border/30 last:border-0">
                    <span className="text-[10px] font-mono text-muted-foreground w-20 shrink-0">{day.date}</span>
                    <div className="flex-1 h-1.5 bg-secondary/40 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${day.dailyProfit >= 0 ? "bg-green-500" : "bg-red-500"}`}
                        style={{ width: `${Math.min(100, Math.abs(day.dailyProfit) * 8)}%` }} />
                    </div>
                    <span className="text-[9px] text-muted-foreground shrink-0">{day.tradeCount}t</span>
                    <span className={`text-[10px] font-mono w-14 text-right shrink-0 ${day.dailyProfit >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {day.dailyProfit >= 0 ? "+" : ""}{day.dailyProfit.toFixed(2)}
                    </span>
                  </div>
                ))}
                {profitCurve.length === 0 && (
                  <p className="text-xs text-muted-foreground py-4 text-center">No data for this period</p>
                )}
              </div>
            </motion.div>

            {/* Period summary card */}
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4 }}
              className="rounded-xl border border-border/50 bg-card p-4">
              <p className="text-xs font-semibold text-foreground mb-1">Period Summary</p>
              <p className="text-[10px] text-muted-foreground mb-4">{periodLabel}</p>
              {stats ? (
                <div className="space-y-3">
                  {/* Big P&L */}
                  <div className="text-center py-3 rounded-lg bg-secondary/20 border border-border/40">
                    <p className="text-[10px] text-muted-foreground mb-0.5">Net P&amp;L</p>
                    <p className={`text-4xl font-mono font-bold ${stats.totalProfit >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {stats.totalProfit >= 0 ? "+" : ""}{stats.totalProfit.toFixed(2)}
                    </p>
                  </div>
                  {/* Sub stats grid */}
                  <div className="grid grid-cols-3 gap-2 text-center">
                    {[
                      { label: "Trades",   value: String(stats.totalTrades), color: "text-foreground" },
                      { label: "Won",      value: String(stats.wonTrades),   color: "text-green-400" },
                      { label: "Lost",     value: String(stats.lostTrades),  color: "text-red-400" },
                    ].map(s => (
                      <div key={s.label} className="rounded-lg bg-secondary/30 py-2">
                        <p className={`text-lg font-mono font-bold ${s.color}`}>{s.value}</p>
                        <p className="text-[9px] text-muted-foreground">{s.label}</p>
                      </div>
                    ))}
                  </div>
                  {/* Win rate bar */}
                  <div>
                    <div className="flex justify-between text-[10px] mb-1">
                      <span className="text-muted-foreground">Win rate</span>
                      <span className="font-mono font-semibold">{(stats.winRate*100).toFixed(1)}%</span>
                    </div>
                    <div className="h-2 bg-secondary/50 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${stats.winRate >= 0.55 ? "bg-green-500" : stats.winRate >= 0.45 ? "bg-amber-500" : "bg-red-500"}`}
                        style={{ width: `${stats.winRate*100}%`, transition: "width 0.4s ease" }} />
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground py-4 text-center">No data for this period</p>
              )}
            </motion.div>
          </div>
        </>
      )}
    </motion.div>
  );
}
