import { useState, useEffect, useRef } from "react";
import { useGetMarketDetail, useExecuteTrade, useGetAiRecommendationForMarket } from "@workspace/api-client-react";
import { useParams, Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { toast } from "sonner";
import { ArrowLeft, TrendingUp, TrendingDown, AlertTriangle, Wifi, WifiOff, Activity } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useQueryClient } from "@tanstack/react-query";

function AgentBar({ name, score, weight, signal, reasoning }: { name: string; score: number; weight: number; signal: string; reasoning: string }) {
  const color = score >= 70 ? "bg-green-500" : score >= 50 ? "bg-amber-500" : "bg-red-500";
  const textColor = score >= 70 ? "text-green-500" : score >= 50 ? "text-amber-500" : "text-red-500";
  const sigColor = signal.includes("buy") ? "text-green-500 border-green-500/30" : signal.includes("sell") ? "text-red-500 border-red-500/30" : "text-zinc-400 border-zinc-700";
  return (
    <div className="p-3 rounded-lg border border-border bg-secondary/20">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{name}</span>
        <div className="flex items-center gap-1.5">
          <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${sigColor}`}>{signal.replace(/_/g, " ")}</Badge>
          <span className="text-[10px] text-zinc-600 font-mono">{(weight * 100).toFixed(0)}%</span>
        </div>
      </div>
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`text-lg font-mono font-bold ${textColor}`}>{score.toFixed(0)}</span>
        <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${score}%` }} />
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground leading-relaxed line-clamp-2" title={reasoning}>{reasoning}</p>
    </div>
  );
}

const AGENT_LABELS: Record<string, string> = {
  marketScanner: "Market Scanner", trendAnalysis: "Trend Analysis", volatilityAnalysis: "Volatility Analysis",
  patternRecognition: "Pattern Recognition", riskManagement: "Risk Management", capitalPreservation: "Capital Preservation",
  tradeExecution: "Trade Execution", selfLearning: "Self-Learning Performance",
};

// ── Digit distribution bar ─────────────────────────────────────────────────────
function DigitBar({ digit, count, pct, hot, cold, barrier, contractType }: {
  digit: number; count: number; pct: number; hot: boolean; cold: boolean; barrier?: number; contractType?: string;
}) {
  const isOver = contractType?.includes("OVER");
  const isUnder = contractType?.includes("UNDER");
  const highlighted = (isOver && digit > (barrier ?? 5)) || (isUnder && digit < (barrier ?? 5));
  const bgColor = highlighted ? "bg-primary" : hot ? "bg-amber-500" : cold ? "bg-red-500/60" : "bg-secondary";

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="text-[10px] font-mono text-muted-foreground">{pct}%</div>
      <div className="w-full flex flex-col items-center justify-end" style={{ height: "48px" }}>
        <div className={`w-full rounded-sm transition-all duration-300 ${bgColor}`} style={{ height: `${Math.max(4, pct * 2)}px` }} />
      </div>
      <div className={`text-xs font-mono font-bold ${highlighted ? "text-primary" : hot ? "text-amber-400" : "text-muted-foreground"}`}>{digit}</div>
    </div>
  );
}

export default function MarketDetail() {
  const { symbol } = useParams();
  const queryClient = useQueryClient();
  const [tradeDialog, setTradeDialog] = useState(false);
  const [tradeDir, setTradeDir] = useState<"up" | "down">("up");
  const [tradeContract, setTradeContract] = useState("");
  const [stake, setStake] = useState("");
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [priceHistory, setPriceHistory] = useState<{ timestamp: string; price: number }[]>([]);
  const [sseConnected, setSseConnected] = useState(false);
  const [lastTickAge, setLastTickAge] = useState<number>(0);
  const eventSourceRef = useRef<EventSource | null>(null);
  const lastTickTimeRef = useRef<number>(Date.now());

  const { data: market, isLoading, refetch } = useGetMarketDetail(symbol || "", { query: { refetchInterval: 8000, enabled: !!symbol } } as { query: any });
  const { data: rec, refetch: refetchRec } = useGetAiRecommendationForMarket(symbol || "", { query: { refetchInterval: 10000, enabled: !!symbol } } as { query: any });
  const executeTrade = useExecuteTrade();

  // ── SSE live tick subscription ──────────────────────────────────────────────
  useEffect(() => {
    if (!symbol) return;

    const es = new EventSource("/api/ai/events");
    eventSourceRef.current = es;

    es.addEventListener("connected", () => {
      setSseConnected(true);
    });

    es.addEventListener("tick", (e) => {
      try {
        const tick = JSON.parse(e.data);
        if (tick.symbol !== symbol) return;
        lastTickTimeRef.current = Date.now();
        setLivePrice(tick.price);
        setPriceHistory((prev) => {
          const next = [...prev, { timestamp: new Date().toISOString(), price: tick.price }];
          return next.slice(-120); // keep last 120 ticks (~2min at 1s intervals)
        });
      } catch { /* ignore */ }
    });

    es.addEventListener("scan_complete", () => {
      refetchRec();
    });

    es.onerror = () => {
      setSseConnected(false);
    };

    // Tick age indicator
    const tickAgeTimer = setInterval(() => {
      setLastTickAge(Math.round((Date.now() - lastTickTimeRef.current) / 1000));
    }, 1000);

    return () => {
      es.close();
      clearInterval(tickAgeTimer);
      setSseConnected(false);
    };
  }, [symbol, refetchRec]);

  // Seed price history from market data on load
  useEffect(() => {
    if (market?.priceHistory && priceHistory.length === 0) {
      setPriceHistory(market.priceHistory);
      const lastPrice = market.priceHistory[market.priceHistory.length - 1]?.price;
      if (lastPrice) setLivePrice(lastPrice);
    }
  }, [market?.priceHistory]);

  if (isLoading || !market) {
    return (
      <div className="p-8 flex items-center gap-3 text-muted-foreground">
        <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        Loading {symbol} analysis...
      </div>
    );
  }

  const recommendation = rec ?? market.recommendation;
  const digitStats = (rec as any)?.digitStats ?? (market as any)?.digitStats;
  const digitBarrier = (rec as any)?.digitBarrier ?? (market as any)?.digitBarrier;
  const suggestedContracts = (rec as any)?.suggestedContractTypes ?? (recommendation as any)?.suggestedContractTypes ?? [];
  const chartData = priceHistory.length > 0 ? priceHistory : market.priceHistory;
  const currentPrice = livePrice ?? chartData[chartData.length - 1]?.price ?? 0;
  const startPrice = chartData[0]?.price ?? currentPrice;
  const priceChange = startPrice > 0 ? ((currentPrice - startPrice) / startPrice) * 100 : 0;

  function openTradeDialog(contractType: string, direction: "up" | "down") {
    setTradeContract(contractType);
    setTradeDir(direction);
    setStake(String(recommendation?.stake ?? 1));
    setTradeDialog(true);
  }

  function handleExecuteTrade() {
    if (!symbol || !stake) return;
    executeTrade.mutate({
      data: { symbol, contractType: tradeContract || (tradeDir === "up" ? "RISE" : "FALL"), direction: tradeDir, stake: Number(stake), duration: 5, durationUnit: "t" }
    }, {
      onSuccess: (result: any) => {
        toast.success(`Trade ${result.status === "won" ? "WON" : "LOST"} — ${result.status === "won" ? "+" : ""}$${Number(result.profit ?? 0).toFixed(2)}`);
        setTradeDialog(false);
        queryClient.invalidateQueries();
        refetch();
      },
      onError: (err: any) => toast.error(err?.error || "Trade failed"),
    });
  }

  const pipSize = symbol?.includes("R_100") || symbol?.includes("1HZ100") ? 2 : symbol?.startsWith("1HZ") || symbol?.startsWith("R_") ? 3 : 4;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 md:p-6 max-w-7xl mx-auto space-y-5 pb-10">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link href="/markets">
            <button className="p-1.5 rounded-md hover:bg-secondary transition-colors">
              <ArrowLeft className="w-4 h-4" />
            </button>
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl md:text-2xl font-bold tracking-tight">{market.displayName}</h1>
              <div className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${sseConnected ? "text-green-400 border-green-500/30 bg-green-500/5" : "text-zinc-500 border-zinc-700"}`}>
                {sseConnected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                {sseConnected ? `LIVE ${lastTickAge < 3 ? "·" : `${lastTickAge}s ago`}` : "connecting..."}
              </div>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-muted-foreground text-sm font-mono">{symbol}</span>
              <Badge variant="outline" className="text-[10px] capitalize">synthetic</Badge>
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-2xl font-bold tabular-nums">
            {currentPrice > 0 ? currentPrice.toFixed(pipSize) : "—"}
          </div>
          <div className={`text-sm font-mono ${priceChange >= 0 ? "text-green-400" : "text-red-400"}`}>
            {priceChange >= 0 ? "+" : ""}{priceChange.toFixed(4)}%
          </div>
        </div>
      </div>

      {/* Live Price Chart */}
      <Card className="bg-card">
        <CardContent className="pt-4 pb-2">
          <div className="h-36 md:h-48">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="timestamp" hide />
                <YAxis domain={["auto", "auto"]} hide />
                <Tooltip
                  content={({ active, payload }) => active && payload?.[0] ? (
                    <div className="bg-card border border-border px-2 py-1 rounded text-xs font-mono">
                      {Number(payload[0].value).toFixed(pipSize)}
                    </div>
                  ) : null}
                />
                <Area type="monotone" dataKey="price" stroke="hsl(var(--primary))" fill="url(#priceGrad)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Digit Analysis (OVER/UNDER) */}
      {digitStats && (
        <Card className="bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Activity className="w-4 h-4 text-primary" />
              Digit Analysis — OVER/UNDER Intelligence
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-10 gap-1">
              {digitStats.distribution.map((d: any) => (
                <DigitBar
                  key={d.digit}
                  digit={d.digit}
                  count={d.count}
                  pct={d.pct}
                  hot={digitStats.hotDigits?.includes(d.digit)}
                  cold={digitStats.coldDigits?.includes(d.digit)}
                  barrier={digitBarrier}
                  contractType={recommendation?.contractType}
                />
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className={`p-2 rounded-lg border ${digitStats.bias === "under" ? "bg-primary/10 border-primary/30" : "bg-secondary/30 border-border"}`}>
                <div className="text-xs text-muted-foreground">UNDER (0-4)</div>
                <div className="text-lg font-mono font-bold">{digitStats.underPct}%</div>
                <div className="text-[10px] text-muted-foreground">expected 50%</div>
              </div>
              <div className={`p-2 rounded-lg border ${digitStats.fivePct > 12 ? "bg-amber-500/10 border-amber-500/30" : "bg-secondary/30 border-border"}`}>
                <div className="text-xs text-muted-foreground">FIVE (5)</div>
                <div className="text-lg font-mono font-bold">{digitStats.fivePct}%</div>
                <div className="text-[10px] text-muted-foreground">expected 10%</div>
              </div>
              <div className={`p-2 rounded-lg border ${digitStats.bias === "over" ? "bg-primary/10 border-primary/30" : "bg-secondary/30 border-border"}`}>
                <div className="text-xs text-muted-foreground">OVER (6-9)</div>
                <div className="text-lg font-mono font-bold">{digitStats.overPct}%</div>
                <div className="text-[10px] text-muted-foreground">expected 40%</div>
              </div>
            </div>
            <div className="p-2 rounded-lg bg-secondary/30 border border-border text-xs text-muted-foreground">
              <span className="text-foreground font-medium">AI Signal: </span>
              {digitStats.bias === "over" ? `📈 OVER bias detected — ${digitStats.overPct}% of recent ticks ended with digits 6-9` :
               digitStats.bias === "under" ? `📉 UNDER bias detected — ${digitStats.underPct}% ended with digits 0-4` :
               "⚖ Neutral — digit distribution is balanced"}
              {digitStats.streakInfo && <span className="ml-2 text-amber-400">· {digitStats.streakInfo}</span>}
            </div>
          </CardContent>
        </Card>
      )}

      {/* AI Recommendation + Contract Buttons */}
      {recommendation && (
        <Card className="bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${recommendation.shouldTrade ? "bg-green-500" : "bg-amber-500"}`} />
              AI Recommendation
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-secondary/30 rounded-lg p-3">
                <div className="text-[10px] text-muted-foreground uppercase mb-1">Calibrated</div>
                <div className={`text-xl font-mono font-bold ${(recommendation as any).calibratedConfidence >= 65 ? "text-green-400" : "text-amber-400"}`}>
                  {(recommendation as any).calibratedConfidence ?? recommendation.confidence}%
                </div>
              </div>
              <div className="bg-secondary/30 rounded-lg p-3">
                <div className="text-[10px] text-muted-foreground uppercase mb-1">Expected Value</div>
                <div className={`text-xl font-mono font-bold ${((recommendation as any).expectedValue ?? 0) > 0 ? "text-green-400" : "text-red-400"}`}>
                  ${((recommendation as any).expectedValue ?? 0).toFixed(2)}
                </div>
              </div>
              <div className="bg-secondary/30 rounded-lg p-3">
                <div className="text-[10px] text-muted-foreground uppercase mb-1">Breakeven WR</div>
                <div className="text-xl font-mono font-bold">{(recommendation as any).breakevenWinRate ?? "—"}%</div>
              </div>
              <div className="bg-secondary/30 rounded-lg p-3">
                <div className="text-[10px] text-muted-foreground uppercase mb-1">Win Prob</div>
                <div className="text-xl font-mono font-bold">{(recommendation as any).winProbability ?? recommendation.confidence}%</div>
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-secondary/30 rounded-lg p-3">
                <div className="text-[10px] text-muted-foreground uppercase mb-1">Confidence</div>
                <div className={`text-xl font-mono font-bold ${recommendation.confidence >= 65 ? "text-green-400" : recommendation.confidence >= 50 ? "text-amber-400" : "text-red-400"}`}>{recommendation.confidence}%</div>
              </div>
              <div className="bg-secondary/30 rounded-lg p-3">
                <div className="text-[10px] text-muted-foreground uppercase mb-1">Risk</div>
                <div className={`text-xl font-mono font-bold ${recommendation.riskScore < 40 ? "text-green-400" : recommendation.riskScore < 60 ? "text-amber-400" : "text-red-400"}`}>{recommendation.riskScore}</div>
              </div>
              <div className="bg-secondary/30 rounded-lg p-3">
                <div className="text-[10px] text-muted-foreground uppercase mb-1">Quality</div>
                <div className="text-xl font-mono font-bold">{market.qualityScore}</div>
              </div>
              <div className="bg-secondary/30 rounded-lg p-3">
                <div className="text-[10px] text-muted-foreground uppercase mb-1">Stake</div>
                <div className="text-xl font-mono font-bold text-primary">${recommendation.stake.toFixed(2)}</div>
              </div>
            </div>

            <p className="text-xs text-muted-foreground leading-relaxed">{recommendation.reasoning}</p>

            {recommendation.warnings && recommendation.warnings.length > 0 && (
              <div className="space-y-1">
                {recommendation.warnings.map((w: string, i: number) => (
                  <div key={i} className="flex items-center gap-2 p-2 bg-amber-500/5 border border-amber-500/20 rounded text-xs text-amber-400">
                    <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                    {w}
                  </div>
                ))}
              </div>
            )}

            {/* Contract type buttons */}
            <div className="space-y-2">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Trade Now</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {suggestedContracts.filter((c: any) => c.suitable).slice(0, 4).map((c: any) => {
                  const isUp = c.contractType === "RISE" || c.contractType === "CALL" || c.contractType === "DIGITOVER";
                  return (
                    <button
                      key={c.contractType}
                      onClick={() => openTradeDialog(c.contractType, isUp ? "up" : "down")}
                      className={`p-3 rounded-lg border text-left transition-all hover:scale-[1.02] ${
                        c.contractType === recommendation.contractType
                          ? "border-primary/50 bg-primary/10"
                          : "border-border bg-secondary/30 hover:border-border/80"
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-mono font-bold text-sm">{c.label}</span>
                        <span className={`text-xs font-mono ${c.confidence >= 65 ? "text-green-400" : "text-amber-400"}`}>{c.confidence}%</span>
                      </div>
                      <div className="text-[10px] text-muted-foreground">{c.description}</div>
                      <div className="flex items-center justify-between mt-1.5">
                        <span className="text-[10px] text-muted-foreground">Stake: <span className="text-foreground font-mono">${c.recommendedStake.toFixed(2)}</span></span>
                        <Badge variant="outline" className={`text-[9px] px-1 ${c.riskLevel === "low" ? "border-green-500/30 text-green-400" : c.riskLevel === "high" ? "border-red-500/30 text-red-400" : "border-amber-500/30 text-amber-400"}`}>
                          {c.riskLevel} risk
                        </Badge>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 8 Agent Scores */}
      {market.agentScores && (
        <Card className="bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">8-Agent AI Scoring</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {Object.entries(market.agentScores).map(([key, agent]: [string, any]) => (
                <AgentBar key={key} name={AGENT_LABELS[key] ?? key} score={agent.score} weight={agent.weight} signal={agent.signal} reasoning={agent.reasoning} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Trade dialog */}
      <Dialog open={tradeDialog} onOpenChange={setTradeDialog}>
        <DialogContent className="bg-card border-border max-w-sm">
          <DialogHeader>
            <DialogTitle>Place Trade — {tradeContract}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="p-3 bg-secondary/30 rounded-lg">
              <div className="text-xs text-muted-foreground mb-0.5">Market</div>
              <div className="font-medium">{market.displayName}</div>
              <div className="text-xs font-mono text-muted-foreground mt-0.5">Current: {currentPrice.toFixed(pipSize)}</div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="stake">Stake (USD)</Label>
              <Input id="stake" type="number" value={stake} min="0.35" step="0.5" onChange={(e) => setStake(e.target.value)} className="font-mono bg-secondary/50" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTradeDialog(false)}>Cancel</Button>
            <Button onClick={handleExecuteTrade} disabled={executeTrade.isPending}>
              {executeTrade.isPending ? "Executing…" : `Execute ${tradeContract}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
