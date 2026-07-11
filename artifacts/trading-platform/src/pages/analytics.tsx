/**
 * Analytics — daily trading dashboard
 *
 * Daily section (top)   — resets at midnight each day (today's trades only)
 * Persistent section    — cumulative P&L curve + win-rate trend (all-time, never reset)
 * Contract breakdown    — all-time by contract type (replaces market-category cards)
 * Top markets           — all-time ranked by net profit
 * Risk monitor          — current drawdown
 */

import { useGetDrawdownAnalysis } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, BarChart, Bar, CartesianGrid, Cell,
  LineChart, Line, ReferenceLine,
} from "recharts";
import {
  TrendingUp, TrendingDown, Activity, Shield,
  AlertTriangle, Zap, Target, BarChart3, Calendar, Flame,
} from "lucide-react";
import { useMemo } from "react";

// ── Helpers ───────────────────────────────────────────────────────────────────

function toLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function todayKey() {
  return toLocalDate(new Date());
}

/** Nice label for a contract type */
const CT_LABEL: Record<string, string> = {
  CALL: "Rise", PUT: "Fall",
  DIGITOVER: "Over", DIGITUNDER: "Under",
  DIGITEVEN: "Even", DIGITODD: "Odd",
  DIGITMATCH: "Match", DIGITDIFF: "Differ",
};

const CT_COLOR: Record<string, string> = {
  CALL: "#10b981", PUT: "#ef4444",
  DIGITOVER: "#06b6d4", DIGITUNDER: "#f59e0b",
  DIGITEVEN: "#8b5cf6", DIGITODD: "#ec4899",
  DIGITMATCH: "#a855f7", DIGITDIFF: "#14b8a6",
};

// ── Data hooks ────────────────────────────────────────────────────────────────

function useAllTrades() {
  return useQuery({
    queryKey: ["analytics-all-trades"],
    queryFn: () => fetch("/api/trades?limit=500").then(r => r.json()),
    refetchInterval: 15_000,
    staleTime: 8_000,
  });
}

// ── Analytics computation ─────────────────────────────────────────────────────

function buildDailyStats(trades: any[]) {
  const won   = trades.filter(t => t.won);
  const lost  = trades.filter(t => !t.won);
  const pnl   = trades.reduce((s, t) => s + (t.profit ?? 0), 0);
  const winRate = trades.length > 0 ? won.length / trades.length : 0;

  let streak = 0;
  for (const t of trades) {
    if (streak === 0) streak = t.won ? 1 : -1;
    else if (t.won && streak > 0) streak++;
    else if (!t.won && streak < 0) streak--;
    else break;
  }

  const avgStake = trades.length > 0
    ? trades.reduce((s, t) => s + Math.abs(t.stake ?? t.amount ?? 0), 0) / trades.length
    : 0;

  return {
    total: trades.length, won: won.length, lost: lost.length,
    pnl: Math.round(pnl * 100) / 100, winRate,
    bestTrade:  won.length  > 0 ? Math.max(...won.map(t => t.profit ?? 0))  : 0,
    worstTrade: lost.length > 0 ? Math.min(...lost.map(t => t.profit ?? 0)) : 0,
    currentStreak: streak,
    avgStake: Math.round(avgStake * 100) / 100,
  };
}

function buildCumulativeCurve(sorted: any[]) {
  const byDate: Record<string, { wins: number; losses: number; pnl: number }> = {};
  for (const t of sorted) {
    const date = toLocalDate(new Date(t.createdAt));
    if (!byDate[date]) byDate[date] = { wins: 0, losses: 0, pnl: 0 };
    byDate[date].pnl += t.profit ?? 0;
    if (t.won) byDate[date].wins++; else byDate[date].losses++;
  }
  let cumulative = 0;
  return Object.entries(byDate).map(([date, d]) => {
    cumulative += d.pnl;
    const total = d.wins + d.losses;
    return {
      date,
      dailyPnl: Math.round(d.pnl * 100) / 100,
      cumPnl:   Math.round(cumulative * 100) / 100,
      wins: d.wins, losses: d.losses, total,
    };
  });
}

function buildWinRateTrend(curve: ReturnType<typeof buildCumulativeCurve>) {
  return curve.map((_, i) => {
    const window = curve.slice(Math.max(0, i - 6), i + 1);
    const w = window.reduce((s, d) => s + d.wins, 0);
    const t = window.reduce((s, d) => s + d.total, 0);
    return { date: curve[i].date, winRate: t > 0 ? Math.round(w / t * 100) : 0 };
  });
}

function buildContractBreakdown(trades: any[]) {
  const map: Record<string, { wins: number; losses: number; pnl: number }> = {};
  for (const t of trades) {
    const ct = t.contractType ?? "?";
    if (!map[ct]) map[ct] = { wins: 0, losses: 0, pnl: 0 };
    map[ct].pnl += t.profit ?? 0;
    if (t.won) map[ct].wins++; else map[ct].losses++;
  }
  return Object.entries(map)
    .map(([ct, d]) => ({
      ct,
      label: CT_LABEL[ct] ?? ct,
      color: CT_COLOR[ct] ?? "#71717a",
      wins: d.wins, losses: d.losses,
      total: d.wins + d.losses,
      pnl: Math.round(d.pnl * 100) / 100,
      winRate: (d.wins + d.losses) > 0 ? d.wins / (d.wins + d.losses) : 0,
    }))
    .filter(c => c.total > 0)
    .sort((a, b) => b.total - a.total);
}

function buildMarketRanking(trades: any[]) {
  const map: Record<string, { wins: number; losses: number; pnl: number; display: string }> = {};
  for (const t of trades) {
    const sym = t.symbol ?? "?";
    if (!map[sym]) map[sym] = { wins: 0, losses: 0, pnl: 0, display: t.displayName ?? sym };
    map[sym].pnl += t.profit ?? 0;
    if (t.won) map[sym].wins++; else map[sym].losses++;
  }
  return Object.entries(map)
    .map(([sym, d]) => ({
      sym, display: d.display, wins: d.wins, losses: d.losses,
      total: d.wins + d.losses,
      pnl: Math.round(d.pnl * 100) / 100,
      winRate: (d.wins + d.losses) > 0 ? d.wins / (d.wins + d.losses) : 0,
    }))
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, 10);
}

// ── Chart tooltip ─────────────────────────────────────────────────────────────
const TOOLTIP_STYLE = {
  contentStyle: {
    backgroundColor: "#0c0c0e", border: "1px solid #27272a",
    borderRadius: "8px", fontSize: "11px", padding: "8px 12px",
  },
  labelStyle: { color: "#52525b", marginBottom: "4px" },
  cursor: { stroke: "hsl(var(--primary))", strokeWidth: 1, strokeDasharray: "4 2" },
};

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({
  label, value, sub, color, icon: Icon, accent, pulse,
}: {
  label: string; value: string; sub?: string;
  color: string; icon: React.ComponentType<{ className?: string }>;
  accent: string; pulse?: boolean;
}) {
  return (
    <div className={`rounded-xl border border-border/60 p-4 bg-gradient-to-br ${accent} to-card/80`}>
      <div className="flex items-start justify-between mb-2">
        <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-medium">{label}</p>
        <div className="relative">
          <Icon className={`w-4 h-4 ${color}`} />
          {pulse && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />}
        </div>
      </div>
      <p className={`text-2xl font-mono font-bold leading-none ${color}`}>{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground mt-1.5 leading-snug">{sub}</p>}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-semibold flex items-center gap-1.5">
      {children}
    </p>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Analytics() {
  const { data: drawdown } = useGetDrawdownAnalysis({ query: { refetchInterval: 15_000 } } as { query: any });
  const { data: rawTrades, isLoading } = useAllTrades();

  const allTrades: any[] = useMemo(
    () => (Array.isArray(rawTrades)
      ? rawTrades.filter((t: any) => t.status === "won" || t.status === "lost")
      : []),
    [rawTrades],
  );

  // Split: today vs all-time
  const today = todayKey();
  const todayTrades = useMemo(
    () => allTrades.filter(t => toLocalDate(new Date(t.createdAt)) === today),
    [allTrades, today],
  );

  const dailyStats = useMemo(() => buildDailyStats(
    [...todayTrades].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
  ), [todayTrades]);

  const allSorted  = useMemo(
    () => [...allTrades].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    [allTrades],
  );
  const curve      = useMemo(() => buildCumulativeCurve(allSorted), [allSorted]);
  const wrTrend    = useMemo(() => buildWinRateTrend(curve), [curve]);
  const contractBk = useMemo(() => buildContractBreakdown(allTrades), [allTrades]);
  const marketRank = useMemo(() => buildMarketRanking(allTrades), [allTrades]);
  const allTimeStats = useMemo(() => buildDailyStats(
    [...allTrades].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
  ), [allTrades]);

  const consecutiveLosses = dailyStats.currentStreak < 0 ? Math.abs(dailyStats.currentStreak) : 0;
  const consecutiveWins   = dailyStats.currentStreak > 0 ? dailyStats.currentStreak : 0;

  // Human-readable date for header
  const todayLabel = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground text-sm gap-2 p-6">
        <Activity className="w-4 h-4 animate-spin" />
        Loading trade data…
      </div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 md:p-6 max-w-7xl mx-auto space-y-6">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2.5">
            <BarChart3 className="w-6 h-6 text-primary" />
            Analytics
          </h1>
          <div className="flex items-center gap-2 mt-0.5">
            <Calendar className="w-3 h-3 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{todayLabel}</p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">All-time trades</p>
          <p className="text-2xl font-mono font-bold text-foreground">{allTrades.length}</p>
          <p className="text-[10px] text-muted-foreground">{allTimeStats.won}W · {allTimeStats.lost}L</p>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════
          DAILY SECTION — resets at midnight
      ══════════════════════════════════════════════════════════════════ */}
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <SectionLabel>
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            Today's Performance
          </SectionLabel>
          <span className="text-[10px] text-muted-foreground">— resets at midnight</span>
        </div>

        {todayTrades.length === 0 ? (
          <div className="rounded-xl border border-border/40 bg-card/50 py-10 flex flex-col items-center justify-center gap-2">
            <Flame className="w-8 h-8 text-muted-foreground/20" />
            <p className="text-sm text-muted-foreground">No trades yet today</p>
            <p className="text-xs text-muted-foreground/60">Stats will appear here once the engine executes</p>
          </div>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
            className="grid grid-cols-2 md:grid-cols-4 gap-3"
          >
            <StatCard
              label="Win Rate" icon={Target} pulse
              value={`${(dailyStats.winRate * 100).toFixed(1)}%`}
              sub={`${dailyStats.won}W / ${dailyStats.lost}L · ${dailyStats.total} trades`}
              color={dailyStats.winRate >= 0.55 ? "text-green-400" : dailyStats.winRate >= 0.45 ? "text-amber-400" : "text-red-400"}
              accent={dailyStats.winRate >= 0.55 ? "from-green-500/8" : dailyStats.winRate >= 0.45 ? "from-amber-500/8" : "from-red-500/8"}
            />
            <StatCard
              label="Today's P&L" icon={dailyStats.pnl >= 0 ? TrendingUp : TrendingDown} pulse
              value={`${dailyStats.pnl >= 0 ? "+" : ""}${dailyStats.pnl.toFixed(2)}`}
              sub={`best: +${dailyStats.bestTrade.toFixed(2)} · worst: ${dailyStats.worstTrade.toFixed(2)}`}
              color={dailyStats.pnl >= 0 ? "text-green-400" : "text-red-400"}
              accent={dailyStats.pnl >= 0 ? "from-green-500/8" : "from-red-500/8"}
            />
            <StatCard
              label="Streak" icon={Zap} pulse
              value={dailyStats.currentStreak === 0 ? "0" : `${dailyStats.currentStreak > 0 ? "+" : ""}${dailyStats.currentStreak}`}
              sub={consecutiveWins > 0 ? `${consecutiveWins} consecutive wins` : consecutiveLosses > 0 ? `${consecutiveLosses} consecutive losses` : "No streak yet"}
              color={dailyStats.currentStreak > 0 ? "text-green-400" : dailyStats.currentStreak < 0 ? "text-red-400" : "text-muted-foreground"}
              accent={dailyStats.currentStreak > 0 ? "from-green-500/8" : dailyStats.currentStreak < 0 ? "from-red-500/8" : "from-secondary/20"}
            />
            <StatCard
              label="Avg Stake" icon={Activity}
              value={`$${dailyStats.avgStake.toFixed(2)}`}
              sub={`${dailyStats.total} trades placed today`}
              color="text-primary"
              accent="from-primary/8"
            />
          </motion.div>
        )}

        {/* Today's hourly P&L mini bar chart */}
        {todayTrades.length > 0 && (() => {
          const hourly: Record<number, { pnl: number; count: number }> = {};
          for (const t of todayTrades) {
            const h = new Date(t.createdAt).getHours();
            if (!hourly[h]) hourly[h] = { pnl: 0, count: 0 };
            hourly[h].pnl += t.profit ?? 0;
            hourly[h].count++;
          }
          const hourData = Object.entries(hourly).map(([h, d]) => ({
            hour: `${h.padStart(2, "0")}:00`, pnl: Math.round(d.pnl * 100) / 100, count: d.count,
          })).sort((a, b) => a.hour.localeCompare(b.hour));

          if (hourData.length < 2) return null;
          return (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}
              className="rounded-xl border border-border/50 bg-card p-4">
              <div className="flex items-center justify-between mb-3">
                <SectionLabel>Today's P&amp;L by Hour</SectionLabel>
                <span className={`text-sm font-mono font-bold ${dailyStats.pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {dailyStats.pnl >= 0 ? "+" : ""}{dailyStats.pnl.toFixed(2)}
                </span>
              </div>
              <div className="h-[120px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={hourData} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1c1c1e" vertical={false} />
                    <XAxis dataKey="hour" tick={{ fontSize: 9, fill: "#71717a" }} />
                    <YAxis tick={{ fontSize: 9, fill: "#52525b" }} />
                    <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => [`$${v.toFixed(2)}`, "P&L"]} />
                    <ReferenceLine y={0} stroke="#3f3f46" />
                    <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
                      {hourData.map((e, i) => (
                        <Cell key={i} fill={e.pnl >= 0 ? "#10b981" : "#ef4444"} opacity={0.85} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </motion.div>
          );
        })()}
      </div>

      {/* ══════════════════════════════════════════════════════════════════
          PERSISTENT SECTION — cumulative P&L + win-rate trend (all-time)
      ══════════════════════════════════════════════════════════════════ */}
      <div className="space-y-4">
        <SectionLabel>
          <span className="w-1.5 h-1.5 rounded-full bg-primary" />
          All-Time Trends
          <span className="font-normal text-muted-foreground/60 normal-case tracking-normal ml-1">— cumulates across days, never resets</span>
        </SectionLabel>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Cumulative P&L */}
          <div className="rounded-xl border border-border/50 bg-card p-4">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-xs font-semibold text-foreground">Cumulative P&amp;L</p>
                <p className="text-[10px] text-muted-foreground">All-time · {curve.length} days of data</p>
              </div>
              <span className={`text-sm font-mono font-bold ${allTimeStats.pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                {allTimeStats.pnl >= 0 ? "+" : ""}{allTimeStats.pnl.toFixed(2)}
              </span>
            </div>
            <div className="h-[180px]">
              {curve.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={curve} margin={{ top: 4, right: 4, left: -22, bottom: 0 }}>
                    <defs>
                      <linearGradient id="cumUp" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%"   stopColor="#10b981" stopOpacity={0.3} />
                        <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="cumDown" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%"   stopColor="#ef4444" stopOpacity={0.3} />
                        <stop offset="100%" stopColor="#ef4444" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="date" hide />
                    <YAxis tick={{ fontSize: 9, fill: "#52525b" }} />
                    <Tooltip {...TOOLTIP_STYLE}
                      formatter={(v: number) => [`$${v.toFixed(2)}`, "Cumulative"]} />
                    <ReferenceLine y={0} stroke="#3f3f46" strokeDasharray="3 3" />
                    <Area type="monotone" dataKey="cumPnl"
                      stroke={allTimeStats.pnl >= 0 ? "#10b981" : "#ef4444"}
                      fill={allTimeStats.pnl >= 0 ? "url(#cumUp)" : "url(#cumDown)"}
                      strokeWidth={2} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground/50 text-xs">No data yet</div>
              )}
            </div>
          </div>

          {/* Win-rate trend */}
          <div className="rounded-xl border border-border/50 bg-card p-4">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-xs font-semibold text-foreground">Win Rate Trend</p>
                <p className="text-[10px] text-muted-foreground">7-session rolling average · all-time</p>
              </div>
              <span className={`text-sm font-mono font-bold ${allTimeStats.winRate >= 0.55 ? "text-green-400" : allTimeStats.winRate >= 0.45 ? "text-amber-400" : "text-red-400"}`}>
                {(allTimeStats.winRate * 100).toFixed(1)}%
              </span>
            </div>
            <div className="h-[180px]">
              {wrTrend.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={wrTrend} margin={{ top: 4, right: 4, left: -22, bottom: 0 }}>
                    <XAxis dataKey="date" hide />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: "#52525b" }}
                      tickFormatter={v => `${v}%`} />
                    <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => [`${v}%`, "Win Rate"]} />
                    <CartesianGrid strokeDasharray="3 3" stroke="#1c1c1e" vertical={false} />
                    <ReferenceLine y={50} stroke="#3f3f46" strokeDasharray="4 2" />
                    <Line type="monotone" dataKey="winRate" stroke="#06b6d4" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground/50 text-xs">No data yet</div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════
          CONTRACT TYPE BREAKDOWN + MARKET RANKING + RISK
      ══════════════════════════════════════════════════════════════════ */}
      <div className="space-y-4">
        <SectionLabel>
          <span className="w-1.5 h-1.5 rounded-full bg-primary/60" />
          All-Time Breakdown
        </SectionLabel>

        {/* Contract type cards */}
        {contractBk.length > 0 && (
          <div className="space-y-3">
            <p className="text-[10px] text-muted-foreground">Performance by contract type</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {contractBk.slice(0, 8).map((c, i) => (
                <motion.div
                  key={c.ct}
                  initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04 }}
                  className="rounded-xl border bg-card p-4 transition-all"
                  style={{ borderColor: c.color + "30", background: c.color + "06" }}
                >
                  <div className="flex items-center gap-1.5 mb-2">
                    <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: c.color }} />
                    <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
                      {c.label}
                    </span>
                  </div>
                  <p className={`text-xl font-mono font-bold leading-none ${c.pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                    {c.pnl >= 0 ? "+" : ""}{c.pnl.toFixed(2)}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    {c.total} trades · {(c.winRate * 100).toFixed(1)}% win
                  </p>
                  <div className="mt-2 h-1.5 w-full bg-secondary/50 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all"
                      style={{ width: `${c.winRate * 100}%`, backgroundColor: c.color }} />
                  </div>
                  <div className="flex justify-between text-[9px] text-muted-foreground mt-0.5">
                    <span>{c.wins}W</span><span>{c.losses}L</span>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>
        )}

        {/* Market ranking + Risk */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Market ranking table */}
          <div className="lg:col-span-2 rounded-xl border border-border/50 bg-card p-4">
            <p className="text-xs font-semibold text-foreground mb-1">Top Markets</p>
            <p className="text-[10px] text-muted-foreground mb-4">Ranked by all-time net P&amp;L</p>
            {marketRank.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">No data yet</p>
            ) : (
              <div className="space-y-1.5">
                {marketRank.map((m, i) => {
                  const maxAbsPnl = Math.max(...marketRank.map(x => Math.abs(x.pnl)), 1);
                  return (
                    <div key={m.sym} className="flex items-center gap-3 py-1.5 border-b border-border/30 last:border-0">
                      <span className="text-[9px] text-muted-foreground/50 font-mono w-4 text-right shrink-0">{i + 1}</span>
                      <span className="text-[10px] font-mono flex-1 truncate min-w-0">{m.sym}</span>
                      <div className="w-24 h-1.5 bg-secondary/40 rounded-full overflow-hidden shrink-0">
                        <div className={`h-full rounded-full ${m.pnl >= 0 ? "bg-green-500" : "bg-red-500"}`}
                          style={{ width: `${(Math.abs(m.pnl) / maxAbsPnl) * 100}%` }} />
                      </div>
                      <span className="text-[9px] text-muted-foreground shrink-0 w-10 text-right">
                        {m.total}t · {(m.winRate * 100).toFixed(0)}%
                      </span>
                      <span className={`text-[10px] font-mono font-bold w-14 text-right shrink-0 ${m.pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                        {m.pnl >= 0 ? "+" : ""}{m.pnl.toFixed(2)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Risk monitor */}
          <div className="rounded-xl border border-border/50 bg-card p-4 space-y-4">
            <div className="flex items-center gap-1.5">
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
                  { label: "Current Drawdown", value: drawdown.currentDrawdown,  limit: drawdown.drawdownLimit, color: "bg-red-500" },
                  { label: "Max Drawdown",      value: drawdown.maxDrawdown,      limit: drawdown.drawdownLimit, color: "bg-amber-500" },
                  { label: "Risk Exposure",     value: drawdown.riskExposure,     limit: 100,                    color: "bg-orange-500" },
                ].map(item => (
                  <div key={item.label}>
                    <div className="flex justify-between text-[10px] mb-1">
                      <span className="text-muted-foreground">{item.label}</span>
                      <span className="font-mono font-semibold">{item.value.toFixed(2)}%</span>
                    </div>
                    <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${item.color} transition-all duration-500`}
                        style={{ width: `${Math.min((item.value / item.limit) * 100, 100)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Loading…</p>
            )}

            <div className="border-t border-border pt-3 space-y-2">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Today's Streak</p>
              <div className="grid grid-cols-2 gap-2 text-center">
                <div className="rounded-lg bg-secondary/40 py-2.5">
                  <p className={`text-xl font-mono font-bold ${consecutiveLosses > 0 ? "text-red-400" : "text-muted-foreground"}`}>
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

            {/* Daily P&L log — last 7 days */}
            {curve.length > 0 && (
              <div className="border-t border-border pt-3 space-y-1.5">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Last 7 days</p>
                {[...curve].slice(-7).reverse().map(day => (
                  <div key={day.date} className="flex items-center gap-2">
                    <span className="text-[9px] font-mono text-muted-foreground w-20 shrink-0">{day.date}</span>
                    <div className="flex-1 h-1 bg-secondary/40 rounded-full overflow-hidden">
                      <div className={`h-full ${day.dailyPnl >= 0 ? "bg-green-500" : "bg-red-500"} rounded-full`}
                        style={{ width: `${Math.min(100, Math.abs(day.dailyPnl) * 5)}%` }} />
                    </div>
                    <span className={`text-[9px] font-mono font-semibold w-12 text-right shrink-0 ${day.dailyPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {day.dailyPnl >= 0 ? "+" : ""}{day.dailyPnl.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
