import { useState, useEffect, useRef } from "react";
import { useGetMarketDetail, useExecuteTrade, useGetAiRecommendationForMarket } from "@workspace/api-client-react";
import { useParams, Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { toast } from "sonner";
import { ArrowLeft, TrendingUp, TrendingDown, AlertTriangle, Wifi, WifiOff, Activity, ArrowUp, ArrowDown } from "lucide-react";
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

// ── Rise/Fall trend analysis panel ────────────────────────────────────────────
function RiseFallPanel({ trendStats, onTrade }: { trendStats: any; onTrade: (type: string, dir: "up" | "down") => void }) {
  if (!trendStats) return null;
  const { direction, strength, winProb, streak, streakDir, momentum, samples } = trendStats;
  const isRising = direction === "up";
  const isStrong = strength > 60;
  const risingPct = winProb?.rise ?? 50;
  const fallingPct = winProb?.fall ?? 50;

  return (
    <Card className="bg-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-indigo-400" />
          Rise & Fall Analysis
          {samples > 0 && <span className="text-[10px] text-muted-foreground font-normal">({samples} ticks)</span>}
          <span className="ml-auto w-2 h-2 rounded-full bg-green-500 animate-pulse" title="Live" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Main direction indicators */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onTrade("RISE", "up")}
            className={`flex flex-col items-center p-4 rounded-xl border-2 transition-all hover:scale-[1.02] active:scale-100 cursor-pointer ${isRising && isStrong ? "border-green-500/60 bg-green-500/10" : "border-border bg-secondary/30 hover:border-green-500/30"}`}
          >
            <ArrowUp className={`w-6 h-6 mb-1.5 ${isRising && isStrong ? "text-green-400" : "text-muted-foreground"}`} />
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">RISE</div>
            <div className={`text-2xl font-mono font-bold mt-1 ${isRising ? "text-green-400" : "text-foreground"}`}>{risingPct.toFixed(0)}%</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">win probability</div>
            {isRising && isStrong && <Badge className="mt-2 text-[9px] bg-green-500/20 text-green-400 border-green-500/30">AI Favours</Badge>}
          </button>
          <button
            onClick={() => onTrade("FALL", "down")}
            className={`flex flex-col items-center p-4 rounded-xl border-2 transition-all hover:scale-[1.02] active:scale-100 cursor-pointer ${!isRising && isStrong ? "border-red-500/60 bg-red-500/10" : "border-border bg-secondary/30 hover:border-red-500/30"}`}
          >
            <ArrowDown className={`w-6 h-6 mb-1.5 ${!isRising && isStrong ? "text-red-400" : "text-muted-foreground"}`} />
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">FALL</div>
            <div className={`text-2xl font-mono font-bold mt-1 ${!isRising ? "text-red-400" : "text-foreground"}`}>{fallingPct.toFixed(0)}%</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">win probability</div>
            {!isRising && isStrong && <Badge className="mt-2 text-[9px] bg-red-500/20 text-red-400 border-red-500/30">AI Favours</Badge>}
          </button>
        </div>

        {/* Trend stats row */}
        <div className="grid grid-cols-3 gap-2">
          <div className="text-center p-2 rounded-lg bg-secondary/30">
            <div className="text-[10px] text-muted-foreground">Strength</div>
            <div className={`text-base font-mono font-bold ${strength > 60 ? "text-green-400" : strength > 40 ? "text-amber-400" : "text-red-400"}`}>{strength.toFixed(0)}%</div>
          </div>
          <div className="text-center p-2 rounded-lg bg-secondary/30">
            <div className="text-[10px] text-muted-foreground">Momentum</div>
            <div className={`text-base font-mono font-bold ${momentum > 0 ? "text-green-400" : "text-red-400"}`}>{momentum > 0 ? "+" : ""}{(momentum * 100).toFixed(2)}</div>
          </div>
          <div className="text-center p-2 rounded-lg bg-secondary/30">
            <div className="text-[10px] text-muted-foreground">Streak</div>
            <div className={`text-base font-mono font-bold ${streakDir === "up" ? "text-green-400" : "text-red-400"}`}>{streak > 0 ? `${streak} ${streakDir === "up" ? "↑" : "↓"}` : "—"}</div>
          </div>
        </div>

        <div className="p-2 rounded-lg bg-secondary/20 border border-border text-xs text-muted-foreground">
          <span className="text-foreground font-medium">Signal: </span>
          {isRising
            ? `📈 Upward momentum detected (${strength.toFixed(0)}% strength) — RISE favoured`
            : `📉 Downward momentum detected (${strength.toFixed(0)}% strength) — FALL favoured`}
          {streak >= 3 && <span className="ml-2 text-amber-400">· {streak}-tick {streakDir === "up" ? "↑" : "↓"} streak</span>}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Put/Call analysis panel ───────────────────────────────────────────────────
function PutCallPanel({ trendStats, onTrade }: { trendStats: any; onTrade: (type: string, dir: "up" | "down") => void }) {
  if (!trendStats) return null;
  const { direction, strength, winProb, sma, ema, rsi, samples } = trendStats;
  const isCallFavoured = direction === "up";
  const callPct = winProb?.call ?? (isCallFavoured ? winProb?.rise ?? 50 : 100 - (winProb?.rise ?? 50));
  const putPct = 100 - callPct;

  return (
    <Card className="bg-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <TrendingDown className="w-4 h-4 text-violet-400" />
          Put & Call Analysis
          {samples > 0 && <span className="text-[10px] text-muted-foreground font-normal">({samples} ticks)</span>}
          <span className="ml-auto w-2 h-2 rounded-full bg-green-500 animate-pulse" title="Live" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onTrade("CALL", "up")}
            className={`flex flex-col items-center p-4 rounded-xl border-2 transition-all hover:scale-[1.02] active:scale-100 cursor-pointer ${isCallFavoured && strength > 55 ? "border-violet-500/60 bg-violet-500/10" : "border-border bg-secondary/30 hover:border-violet-500/30"}`}
          >
            <ArrowUp className={`w-6 h-6 mb-1.5 ${isCallFavoured && strength > 55 ? "text-violet-400" : "text-muted-foreground"}`} />
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">CALL</div>
            <div className={`text-2xl font-mono font-bold mt-1 ${isCallFavoured ? "text-violet-400" : "text-foreground"}`}>{callPct.toFixed(0)}%</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">above entry</div>
            {isCallFavoured && strength > 55 && <Badge className="mt-2 text-[9px] bg-violet-500/20 text-violet-400 border-violet-500/30">AI Favours</Badge>}
          </button>
          <button
            onClick={() => onTrade("PUT", "down")}
            className={`flex flex-col items-center p-4 rounded-xl border-2 transition-all hover:scale-[1.02] active:scale-100 cursor-pointer ${!isCallFavoured && strength > 55 ? "border-rose-500/60 bg-rose-500/10" : "border-border bg-secondary/30 hover:border-rose-500/30"}`}
          >
            <ArrowDown className={`w-6 h-6 mb-1.5 ${!isCallFavoured && strength > 55 ? "text-rose-400" : "text-muted-foreground"}`} />
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">PUT</div>
            <div className={`text-2xl font-mono font-bold mt-1 ${!isCallFavoured ? "text-rose-400" : "text-foreground"}`}>{putPct.toFixed(0)}%</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">below entry</div>
            {!isCallFavoured && strength > 55 && <Badge className="mt-2 text-[9px] bg-rose-500/20 text-rose-400 border-rose-500/30">AI Favours</Badge>}
          </button>
        </div>

        {/* Indicator row */}
        <div className="grid grid-cols-3 gap-2">
          <div className="text-center p-2 rounded-lg bg-secondary/30">
            <div className="text-[10px] text-muted-foreground">RSI</div>
            <div className={`text-base font-mono font-bold ${rsi > 70 ? "text-red-400" : rsi < 30 ? "text-green-400" : "text-foreground"}`}>{rsi?.toFixed(0) ?? "—"}</div>
          </div>
          <div className="text-center p-2 rounded-lg bg-secondary/30">
            <div className="text-[10px] text-muted-foreground">SMA vs EMA</div>
            <div className={`text-base font-mono font-bold ${sma > ema ? "text-green-400" : "text-red-400"}`}>{sma > ema ? "Bull" : "Bear"}</div>
          </div>
          <div className="text-center p-2 rounded-lg bg-secondary/30">
            <div className="text-[10px] text-muted-foreground">Trend</div>
            <div className={`text-base font-mono font-bold ${isCallFavoured ? "text-violet-400" : "text-rose-400"}`}>{isCallFavoured ? "↑ CALL" : "↓ PUT"}</div>
          </div>
        </div>

        <div className="p-2 rounded-lg bg-secondary/20 border border-border text-xs text-muted-foreground">
          <span className="text-foreground font-medium">Signal: </span>
          {isCallFavoured
            ? `📊 Bullish structure — price likely above entry at expiry (CALL favoured, ${strength.toFixed(0)}% strength)`
            : `📊 Bearish structure — price likely below entry at expiry (PUT favoured, ${strength.toFixed(0)}% strength)`}
          {rsi && (rsi > 70 || rsi < 30) && <span className="ml-2 text-amber-400">· RSI {rsi > 70 ? "overbought" : "oversold"}</span>}
        </div>
      </CardContent>
    </Card>
  );
}

export default function MarketDetail() {
  const { symbol } = useParams();
  const queryClient = useQueryClient();
  const [tradeDialog, setTradeDialog] = useState(false);
  const [tradeDir, setTradeDir] = useState<"up" | "down">("up");
  const [tradeContract, setTradeContract] = useState("");
  const [stake, setStake] = useState("");
  const [tradeBarrier, setTradeBarrier] = useState<number | undefined>(undefined);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [priceHistory, setPriceHistory] = useState<{ timestamp: string; price: number }[]>([]);
  const [sseConnected, setSseConnected] = useState(false);
  const [lastTickAge, setLastTickAge] = useState<number>(0);
  // Live analysis state — updated via SSE on every tick
  const [liveDigitStats, setLiveDigitStats] = useState<any | null>(null);
  const [liveTrendStats, setLiveTrendStats] = useState<any | null>(null);
  const [lastLiveDigit, setLastLiveDigit] = useState<number | null>(null);
  const [dialogCountdown, setDialogCountdown] = useState<number | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const lastTickTimeRef = useRef<number>(Date.now());

  const { data: market, isLoading, refetch } = useGetMarketDetail(symbol || "", { query: { refetchInterval: 8000, enabled: !!symbol } } as { query: any });
  const { data: rec, refetch: refetchRec } = useGetAiRecommendationForMarket(symbol || "", { query: { refetchInterval: 12000, enabled: !!symbol } } as { query: any });
  const executeTrade = useExecuteTrade();

  // ── SSE: live ticks + live market analysis ───────────────────────────────────
  useEffect(() => {
    if (!symbol) return;

    const es = new EventSource("/api/ai/events");
    eventSourceRef.current = es;

    es.addEventListener("connected", () => setSseConnected(true));

    es.addEventListener("tick", (e) => {
      try {
        const tick = JSON.parse(e.data);
        if (tick.symbol !== symbol) return;
        lastTickTimeRef.current = Date.now();
        setLivePrice(tick.price);
        setPriceHistory((prev) => {
          const next = [...prev, { timestamp: new Date().toISOString(), price: tick.price }];
          return next.slice(-120);
        });
      } catch { /* ignore */ }
    });

    // Live digit + trend analysis from the backend on every tick
    es.addEventListener("market_analysis", (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.symbol !== symbol) return;
        if (data.digitStats) setLiveDigitStats(data.digitStats);
        if (data.trendStats) setLiveTrendStats(data.trendStats);
        // lastDigit changes on EVERY tick — show it prominently in the digit panel
        if (typeof data.lastDigit === "number") setLastLiveDigit(data.lastDigit);
      } catch { /* ignore */ }
    });

    es.addEventListener("scan_complete", () => refetchRec());

    es.onerror = () => setSseConnected(false);

    const tickAgeTimer = setInterval(() => {
      setLastTickAge(Math.round((Date.now() - lastTickTimeRef.current) / 1000));
    }, 1000);

    return () => {
      es.close();
      clearInterval(tickAgeTimer);
      setSseConnected(false);
    };
  }, [symbol, refetchRec]);

  // Seed price history + initial stats from market data
  useEffect(() => {
    if (market?.priceHistory && priceHistory.length === 0) {
      setPriceHistory(market.priceHistory);
      const lastPrice = market.priceHistory[market.priceHistory.length - 1]?.price;
      if (lastPrice) setLivePrice(lastPrice);
    }
    if (market && (market as any).digitStats) setLiveDigitStats((market as any).digitStats);
    if (market && (market as any).trendStats) setLiveTrendStats((market as any).trendStats);
  }, [market]);

  // Populate from rec on first load too
  useEffect(() => {
    if (rec) {
      if ((rec as any).digitStats) setLiveDigitStats((rec as any).digitStats);
      if ((rec as any).trendStats) setLiveTrendStats((rec as any).trendStats);
    }
  }, [rec]);

  // ── Trade dialog countdown — MUST be before any early return (Rules of Hooks) ─
  useEffect(() => {
    if (!tradeDialog) { setDialogCountdown(null); return; }
    setDialogCountdown(15);
    const iv = setInterval(() => setDialogCountdown((c) => (c !== null ? Math.max(0, c - 1) : null)), 1000);
    return () => clearInterval(iv);
  }, [tradeDialog]);

  if (isLoading || !market) {
    return (
      <div className="p-8 flex items-center gap-3 text-muted-foreground">
        <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        Loading {symbol} analysis...
      </div>
    );
  }

  const recommendation = rec ?? market.recommendation;
  // Use live stats (SSE) first, fallback to rec/market data
  const digitStats = liveDigitStats ?? (rec as any)?.digitStats ?? (market as any)?.digitStats;
  const trendStats = liveTrendStats ?? (rec as any)?.trendStats ?? null;
  const digitBarrier = (rec as any)?.digitBarrier ?? (market as any)?.digitBarrier;
  const suggestedContracts = (rec as any)?.suggestedContractTypes ?? (recommendation as any)?.suggestedContractTypes ?? [];
  const chartData = priceHistory.length > 0 ? priceHistory : market.priceHistory;
  const currentPrice = livePrice ?? chartData[chartData.length - 1]?.price ?? 0;
  const startPrice = chartData[0]?.price ?? currentPrice;
  const priceChange = startPrice > 0 ? ((currentPrice - startPrice) / startPrice) * 100 : 0;

  const pipSize = symbol?.includes("R_100") || symbol?.includes("1HZ100") ? 2 : symbol?.startsWith("1HZ") || symbol?.startsWith("R_") ? 3 : 4;

  function openTradeDialog(contractType: string, direction: "up" | "down", barrier?: number) {
    setTradeContract(contractType);
    setTradeDir(direction);
    setTradeBarrier(barrier);
    setStake(String(recommendation?.stake ?? 1));
    setTradeDialog(true);
  }

  function handleExecuteTrade() {
    if (!symbol || !stake) return;
    executeTrade.mutate({
      data: { symbol, contractType: tradeContract || (tradeDir === "up" ? "RISE" : "FALL"), direction: tradeDir, stake: Number(stake), duration: 5, durationUnit: "t", barrier: tradeBarrier }
    }, {
      onSuccess: (result: any) => {
        toast.success(`Trade ${result.status === "won" ? "WON 🎉" : "LOST"} — ${result.status === "won" ? "+" : ""}$${Number(result.profit ?? 0).toFixed(2)}`);
        setTradeDialog(false);
        queryClient.invalidateQueries();
        refetch();
      },
      onError: (err: any) => toast.error(err?.error || "Trade failed"),
    });
  }

  const isDigitMarket = symbol?.includes("R_") || symbol?.includes("1HZ") || symbol?.startsWith("JD");

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

      {/* Rise & Fall Analysis — clickable trade buttons */}
      <RiseFallPanel trendStats={trendStats} onTrade={openTradeDialog} />

      {/* Put & Call Analysis — clickable trade buttons */}
      <PutCallPanel trendStats={trendStats} onTrade={openTradeDialog} />

      {/* Digit Analysis (OVER/UNDER) — only for digit markets */}
      {isDigitMarket && digitStats && (
        <Card className="bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Activity className="w-4 h-4 text-primary" />
              Digit Analysis — OVER/UNDER Intelligence
              {lastLiveDigit !== null && (
                <span className="ml-2 flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-primary/15 border border-primary/30">
                  <span className="text-[10px] text-muted-foreground">LAST</span>
                  <span className="text-base font-mono font-bold text-primary leading-none">{lastLiveDigit}</span>
                </span>
              )}
              <span className="ml-auto w-2 h-2 rounded-full bg-green-500 animate-pulse" title="Live" />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Last digit highlight row — updates every tick */}
            {lastLiveDigit !== null && (
              <div className="grid grid-cols-10 gap-1">
                {[0,1,2,3,4,5,6,7,8,9].map(d => (
                  <div key={d} className={`flex items-center justify-center h-7 rounded-md text-sm font-mono font-bold transition-all duration-150 ${
                    d === lastLiveDigit ? "bg-primary text-primary-foreground scale-110 shadow-md shadow-primary/30" : "bg-secondary/30 text-muted-foreground"
                  }`}>{d}</div>
                ))}
              </div>
            )}
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

            {/* Clickable OVER/UNDER trade buttons for each barrier */}
            <div className="grid grid-cols-5 gap-1.5">
              {[0, 1, 2, 3, 4].map((b) => {
                const overPct = digitStats.distribution
                  .filter((d: any) => d.digit > b)
                  .reduce((s: number, d: any) => s + d.pct, 0);
                const isHot = overPct > 60;
                return (
                  <button
                    key={b}
                    onClick={() => openTradeDialog("DIGITOVER", "up", b)}
                    className={`flex flex-col items-center p-2 rounded-lg border text-center transition-all hover:scale-[1.02] ${isHot ? "border-green-500/40 bg-green-500/8" : "border-border bg-secondary/20"}`}
                  >
                    <div className="text-[9px] text-muted-foreground">OVER {b}</div>
                    <div className={`text-sm font-mono font-bold ${isHot ? "text-green-400" : "text-foreground"}`}>{overPct.toFixed(0)}%</div>
                    {isHot && <div className="text-[8px] text-green-500 mt-0.5">HOT</div>}
                  </button>
                );
              })}
              {[5, 6, 7, 8, 9].map((b) => {
                const underPct = digitStats.distribution
                  .filter((d: any) => d.digit < b)
                  .reduce((s: number, d: any) => s + d.pct, 0);
                const isHot = underPct > 60;
                return (
                  <button
                    key={b}
                    onClick={() => openTradeDialog("DIGITUNDER", "down", b)}
                    className={`flex flex-col items-center p-2 rounded-lg border text-center transition-all hover:scale-[1.02] ${isHot ? "border-blue-500/40 bg-blue-500/8" : "border-border bg-secondary/20"}`}
                  >
                    <div className="text-[9px] text-muted-foreground">UNDER {b}</div>
                    <div className={`text-sm font-mono font-bold ${isHot ? "text-blue-400" : "text-foreground"}`}>{underPct.toFixed(0)}%</div>
                    {isHot && <div className="text-[8px] text-blue-500 mt-0.5">HOT</div>}
                  </button>
                );
              })}
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

            {/* Quick Trade — all market types */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Quick Trade</div>
                <div className="text-[10px] font-mono text-muted-foreground">5 ticks · auto-configured</div>
              </div>

              {/* Rise / Fall and Call / Put — always visible */}
              <div className="grid grid-cols-2 gap-1.5">
                {([
                  { ct: "RISE", dir: "up" as const, label: "▲ RISE", probKey: "rise" },
                  { ct: "FALL", dir: "down" as const, label: "▼ FALL", probKey: "fall" },
                  { ct: "CALL", dir: "up" as const, label: "↑ CALL", probKey: "call" },
                  { ct: "PUT",  dir: "down" as const, label: "↓ PUT",  probKey: "put"  },
                ] as const).map(({ ct, dir, label, probKey }) => {
                  const prob: number | undefined = (trendStats as any)?.winProb?.[probKey];
                  const pct = prob != null ? Math.round(prob) : null;
                  const isRec = (recommendation as any)?.contractType === ct;
                  const isUp = dir === "up";
                  return (
                    <button key={ct} onClick={() => openTradeDialog(ct, dir)}
                      className={`relative p-2.5 rounded-lg border text-left transition-all hover:scale-[1.02] active:scale-[0.98] ${
                        isRec
                          ? "border-primary/50 bg-primary/10 shadow-sm shadow-primary/20"
                          : "border-border bg-secondary/30 hover:border-muted-foreground/30"
                      }`}
                    >
                      {isRec && <span className="absolute top-1 right-1.5 text-[8px] font-bold text-primary uppercase tracking-wider">AI ★</span>}
                      <div className={`font-mono font-bold text-sm ${isUp ? "text-green-400" : "text-red-400"}`}>{label}</div>
                      {pct != null
                        ? <div className={`text-[10px] mt-0.5 font-mono ${pct >= 55 ? "text-green-400" : pct >= 45 ? "text-amber-400" : "text-red-400"}`}>{pct}% prob</div>
                        : <div className="text-[10px] mt-0.5 text-muted-foreground">click to trade</div>}
                    </button>
                  );
                })}
              </div>

              {/* Digit OVER / UNDER — only for digit-enabled markets */}
              {isDigitMarket && (
                <div className="grid grid-cols-2 gap-1.5">
                  {([
                    { ct: "DIGITOVER", dir: "up" as const, label: "OVER", barrier: digitBarrier ?? 5, color: "text-violet-400", borderRec: "border-violet-500/50 bg-violet-500/10 shadow-violet-500/20" },
                    { ct: "DIGITUNDER", dir: "down" as const, label: "UNDER", barrier: digitBarrier ?? 5, color: "text-rose-400", borderRec: "border-rose-500/50 bg-rose-500/10 shadow-rose-500/20" },
                  ] as const).map(({ ct, dir, label, barrier, color, borderRec }) => {
                    const isRec = (recommendation as any)?.contractType === ct;
                    const overPct = digitStats ? Math.round(digitStats.overPct ?? 0) : null;
                    const underPct = digitStats ? Math.round(digitStats.underPct ?? 0) : null;
                    const prob = ct === "DIGITOVER" ? overPct : underPct;
                    return (
                      <button key={ct} onClick={() => openTradeDialog(ct, dir, barrier)}
                        className={`relative p-2.5 rounded-lg border text-left transition-all hover:scale-[1.02] active:scale-[0.98] ${
                          isRec
                            ? `${borderRec} shadow-sm`
                            : "border-border bg-secondary/30 hover:border-muted-foreground/30"
                        }`}
                      >
                        {isRec && <span className={`absolute top-1 right-1.5 text-[8px] font-bold uppercase tracking-wider ${color}`}>AI ★</span>}
                        <div className={`font-mono font-bold text-sm ${color}`}>{label} {barrier}</div>
                        {prob != null
                          ? <div className={`text-[10px] mt-0.5 font-mono ${prob >= 50 ? "text-green-400" : "text-amber-400"}`}>{prob}% rate</div>
                          : <div className="text-[10px] mt-0.5 text-muted-foreground">digit contract</div>}
                      </button>
                    );
                  })}
                </div>
              )}
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
          <div className="space-y-3 py-2">
            <div className="p-3 bg-secondary/30 rounded-lg flex justify-between items-start">
              <div>
                <div className="text-xs text-muted-foreground mb-0.5">Market</div>
                <div className="font-medium">{market.displayName}</div>
                <div className="text-xs font-mono text-muted-foreground mt-0.5">Current: {currentPrice.toFixed(pipSize)}</div>
              </div>
              {dialogCountdown !== null && (
                <div className={`text-right text-xs font-mono font-bold ${dialogCountdown <= 5 ? "text-red-400 animate-pulse" : dialogCountdown <= 10 ? "text-amber-400" : "text-muted-foreground"}`}>
                  <div>{dialogCountdown}s</div>
                  <div className="text-[9px] font-normal">to place</div>
                </div>
              )}
            </div>
            {/* Contract type + duration info */}
            <div className="flex items-center gap-2 text-xs">
              <span className="px-2 py-1 rounded-md bg-primary/10 border border-primary/30 font-mono font-bold text-primary">
                {tradeContract.startsWith("DIGIT") ? `${tradeContract.replace("DIGIT", "")} ${tradeBarrier ?? ""}` : tradeContract}
              </span>
              <span className="px-2 py-1 rounded-md bg-secondary/50 border border-border font-mono text-muted-foreground">5 ticks</span>
              {tradeBarrier != null && !tradeContract.startsWith("DIGIT") === false && (
                <span className="px-2 py-1 rounded-md bg-violet-500/10 border border-violet-500/30 font-mono text-violet-400 text-[10px]">Barrier: {tradeBarrier}</span>
              )}
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
