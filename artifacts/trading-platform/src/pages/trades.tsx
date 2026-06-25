import { useState } from "react";
import { useGetTrades, useGetTradeStats } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { motion } from "framer-motion";
import { format } from "date-fns";
import { TrendingUp, TrendingDown, Activity } from "lucide-react";

type StatusFilter = "all" | "won" | "lost" | "open";

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "won", label: "Won" },
  { key: "lost", label: "Lost" },
  { key: "open", label: "Open" },
];

function formatContractLabel(contractType: string, barrier: number | null): string {
  if (contractType === "DIGITOVER" && barrier !== null) return `OVER ${barrier}`;
  if (contractType === "DIGITUNDER" && barrier !== null) return `UNDER ${barrier}`;
  if (contractType === "DIGITOVER") return "OVER";
  if (contractType === "DIGITUNDER") return "UNDER";
  return contractType;
}

export default function Trades() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const { data: trades } = useGetTrades(
    { status: statusFilter },
    { query: { refetchInterval: statusFilter === "open" ? 3000 : 8000 } } as { query: any }
  );
  const { data: stats } = useGetTradeStats({ query: { refetchInterval: 10000 } } as { query: any });

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-6 max-w-7xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Trade Journal</h1>
        <p className="text-muted-foreground text-sm mt-0.5">Complete history of manual and autonomous executions.</p>
      </div>

      {/* Stats strip */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Card className="bg-card">
            <CardContent className="p-3">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Win Rate</div>
              <div className={`text-xl font-mono font-bold ${stats.winRate >= 0.55 ? "text-green-500" : stats.winRate >= 0.45 ? "text-amber-500" : "text-red-500"}`}>
                {(stats.winRate * 100).toFixed(1)}%
              </div>
              <div className="text-[10px] text-muted-foreground">{stats.wonTrades}W / {stats.lostTrades}L</div>
            </CardContent>
          </Card>
          <Card className="bg-card">
            <CardContent className="p-3">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Total Profit</div>
              <div className={`text-xl font-mono font-bold ${stats.totalProfit >= 0 ? "text-green-500" : "text-red-500"}`}>
                {stats.totalProfit >= 0 ? "+" : ""}{stats.totalProfit.toFixed(2)}
              </div>
              <div className="text-[10px] text-muted-foreground">avg {stats.avgProfit >= 0 ? "+" : ""}{stats.avgProfit.toFixed(2)}/trade</div>
            </CardContent>
          </Card>
          <Card className="bg-card">
            <CardContent className="p-3">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Best Trade</div>
              <div className="text-xl font-mono font-bold text-green-500">+{stats.bestTrade.toFixed(2)}</div>
              <div className="text-[10px] text-muted-foreground">worst: {stats.worstTrade.toFixed(2)}</div>
            </CardContent>
          </Card>
          <Card className="bg-card">
            <CardContent className="p-3">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Streak</div>
              <div className={`text-xl font-mono font-bold ${stats.currentStreak >= 0 ? "text-green-500" : "text-red-500"}`}>
                {stats.currentStreak >= 0 ? "+" : ""}{stats.currentStreak}
              </div>
              <div className="text-[10px] text-muted-foreground">
                best win: {stats.longestWinStreak} / loss: {stats.longestLoseStreak}
              </div>
            </CardContent>
          </Card>
          <Card className="bg-card">
            <CardContent className="p-3">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Total Trades</div>
              <div className="text-xl font-mono font-bold">{stats.totalTrades}</div>
              <div className="text-[10px] text-muted-foreground">all time</div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Status filter */}
      <div className="flex gap-1.5">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setStatusFilter(f.key)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              statusFilter === f.key
                ? "bg-primary/20 text-primary border border-primary/40"
                : "bg-secondary/50 text-muted-foreground border border-border hover:text-foreground"
            }`}
          >
            {f.label}
          </button>
        ))}
        {trades && (
          <span className="ml-auto text-xs text-muted-foreground self-center">{trades.length} records</span>
        )}
      </div>

      {/* Column headers */}
      <div className="grid grid-cols-12 gap-3 px-4 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
        <div className="col-span-2">Time</div>
        <div className="col-span-2">Market</div>
        <div className="col-span-1">Dir</div>
        <div className="col-span-2">Contract</div>
        <div className="col-span-1">Stake</div>
        <div className="col-span-2">AI Conf</div>
        <div className="col-span-1">Mode</div>
        <div className="col-span-1">P/L</div>
      </div>

      <div className="space-y-1">
        {trades?.map((trade) => {
          const isWon = trade.status === "won";
          const isOpen = trade.status === "open";
          const profitColor = isWon ? "text-green-500" : isOpen ? "text-amber-500" : "text-red-500";
          const confVal = trade.aiConfidence ?? 0;
          const confColor = confVal >= 70 ? "text-green-500" : confVal >= 50 ? "text-amber-500" : "text-red-500";
          const contractLabel = formatContractLabel(trade.contractType, (trade as any).barrier ?? null);

          return (
            <Card key={trade.id} className={`bg-card hover:bg-secondary/20 transition-colors border ${isWon ? "border-green-500/10" : isOpen ? "border-amber-500/10 animate-pulse" : "border-red-500/10"}`}>
              <CardContent className="p-2.5 grid grid-cols-12 gap-3 items-center">
                <div className="col-span-2">
                  <div className="text-[11px] font-mono text-muted-foreground">{format(new Date(trade.createdAt), "HH:mm:ss")}</div>
                  <div className="text-[10px] text-zinc-600">{format(new Date(trade.createdAt), "MMM d")}</div>
                </div>

                <div className="col-span-2">
                  <div className="text-xs font-bold truncate">{(trade as any).displayName ?? trade.symbol}</div>
                  <div className="text-[10px] text-zinc-600 font-mono">{trade.symbol}</div>
                </div>

                <div className="col-span-1">
                  <div className={`flex items-center gap-0.5 text-[10px] font-bold ${trade.direction === "up" ? "text-green-500" : "text-red-500"}`}>
                    {trade.direction === "up" ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                    {trade.direction.toUpperCase()}
                  </div>
                </div>

                <div className="col-span-2">
                  <span className={`text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded ${
                    trade.contractType.includes("DIGIT")
                      ? "bg-purple-500/10 text-purple-400"
                      : "bg-blue-500/10 text-blue-400"
                  }`}>
                    {contractLabel}
                  </span>
                </div>

                <div className="col-span-1">
                  <span className="text-xs font-mono">${trade.stake.toFixed(2)}</span>
                </div>

                <div className="col-span-2">
                  <div className="flex items-center gap-1.5">
                    <div className={`text-xs font-mono font-bold ${confColor}`}>{confVal.toFixed(0)}%</div>
                    <div className="flex-1 h-1 bg-secondary rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${confVal >= 70 ? "bg-green-500" : confVal >= 50 ? "bg-amber-500" : "bg-red-500"}`}
                        style={{ width: `${confVal}%` }} />
                    </div>
                  </div>
                </div>

                <div className="col-span-1">
                  <Badge variant="outline" className="text-[9px] px-1 py-0 text-muted-foreground border-border">
                    {trade.isAutonomous ? "AUTO" : "MANUAL"}
                  </Badge>
                </div>

                <div className="col-span-1">
                  {isOpen ? (
                    <div className="flex items-center gap-0.5 text-amber-500">
                      <Activity className="w-3 h-3 animate-pulse" />
                      <span className="text-[10px] font-mono">Live</span>
                    </div>
                  ) : (
                    <div className={`text-xs font-mono font-bold ${profitColor}`}>
                      {isWon ? "+" : ""}{trade.profit?.toFixed(2) ?? "—"}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
        {trades?.length === 0 && (
          <div className="text-center py-16 text-muted-foreground">
            <Activity className="w-8 h-8 mx-auto mb-3 opacity-30" />
            <div className="text-sm">No trades recorded yet.</div>
            <div className="text-xs mt-1">Go to Markets and execute your first trade.</div>
          </div>
        )}
      </div>
    </motion.div>
  );
}
