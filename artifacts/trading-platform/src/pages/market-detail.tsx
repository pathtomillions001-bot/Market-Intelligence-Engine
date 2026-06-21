import { useState } from "react";
import { useGetMarketDetail, useExecuteTrade, useGetAiRecommendationForMarket } from "@workspace/api-client-react";
import { useParams, Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { toast } from "sonner";
import { ArrowLeft, TrendingUp, TrendingDown, AlertTriangle } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function AgentBar({ name, score, weight, signal, reasoning }: {
  name: string; score: number; weight: number; signal: string; reasoning: string;
}) {
  const pct = score;
  const color = pct >= 70 ? "bg-green-500" : pct >= 50 ? "bg-amber-500" : "bg-red-500";
  const textColor = pct >= 70 ? "text-green-500" : pct >= 50 ? "text-amber-500" : "text-red-500";
  const signalColor = signal.includes("buy") ? "text-green-500 border-green-500/30"
    : signal.includes("sell") ? "text-red-500 border-red-500/30"
    : "text-zinc-400 border-zinc-700";
  return (
    <div className="p-3 rounded-lg border border-border bg-secondary/20">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {name}
        </div>
        <div className="flex items-center gap-1.5">
          <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${signalColor}`}>
            {signal.replace(/_/g, " ")}
          </Badge>
          <span className="text-[10px] text-zinc-600 font-mono">{(weight * 100).toFixed(0)}%</span>
        </div>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <span className={`text-lg font-mono font-bold ${textColor}`}>{score.toFixed(0)}</span>
        <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
          <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%`, transition: "width 0.5s ease" }} />
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground leading-relaxed line-clamp-2" title={reasoning}>{reasoning}</p>
    </div>
  );
}

const AGENT_LABELS: Record<string, string> = {
  marketScanner: "Market Scanner",
  trendAnalysis: "Trend Analysis",
  volatilityAnalysis: "Volatility Analysis",
  patternRecognition: "Pattern Recognition",
  riskManagement: "Risk Management",
  capitalPreservation: "Capital Preservation",
  tradeExecution: "Trade Execution",
  selfLearning: "Self-Learning",
};

export default function MarketDetail() {
  const { symbol } = useParams();
  const [tradeDialog, setTradeDialog] = useState(false);
  const [tradeDir, setTradeDir] = useState<"up" | "down">("up");
  const [stake, setStake] = useState("");

  const { data: market, isLoading } = useGetMarketDetail(symbol || "", { query: { refetchInterval: 6000, enabled: !!symbol } } as { query: any });
  const { data: rec } = useGetAiRecommendationForMarket(symbol || "", { query: { refetchInterval: 10000, enabled: !!symbol } } as { query: any });
  const executeTrade = useExecuteTrade();

  if (isLoading || !market) {
    return (
      <div className="p-8 flex items-center gap-3 text-muted-foreground">
        <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        Loading {symbol} analysis...
      </div>
    );
  }

  const recommendation = rec ?? market.recommendation;
  const stakeAmount = parseFloat(stake) || recommendation?.stake || 1;

  const openTradeDialog = (dir: "up" | "down") => {
    setTradeDir(dir);
    setStake(String(recommendation?.stake?.toFixed(2) ?? "1.00"));
    setTradeDialog(true);
  };

  const handleTrade = () => {
    executeTrade.mutate({
      data: {
        symbol: market.symbol,
        contractType: recommendation?.contractType ?? "CALL",
        stake: stakeAmount,
        direction: tradeDir,
      }
    }, {
      onSuccess: (trade) => {
        setTradeDialog(false);
        if (trade.status === "won") {
          toast.success(`Won $${Math.abs(trade.profit ?? 0).toFixed(2)} on ${market.symbol}`);
        } else {
          toast.error(`Lost $${Math.abs(trade.profit ?? 0).toFixed(2)} on ${market.symbol}`);
        }
      },
      onError: () => toast.error("Trade failed — check account settings"),
    });
  };

  const priceData = market.priceHistory;
  const lastPrice = priceData[priceData.length - 1]?.price;
  const firstPrice = priceData[0]?.price;
  const priceChange = firstPrice ? ((lastPrice - firstPrice) / firstPrice) * 100 : 0;
  const isUp = priceChange >= 0;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-6 max-w-7xl mx-auto space-y-5">
      {/* Back + header */}
      <div className="flex items-start justify-between">
        <div>
          <Link href="/markets">
            <button className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-2 transition-colors">
              <ArrowLeft className="w-3 h-3" /> Markets
            </button>
          </Link>
          <h1 className="text-2xl font-bold tracking-tight">{market.symbol}</h1>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-sm text-muted-foreground">{market.displayName}</span>
            <Badge variant="outline" className="text-[10px] capitalize">{market.category}</Badge>
          </div>
        </div>

        <div className="flex flex-col items-end gap-2">
          <div className="text-right">
            <div className="text-xl font-mono font-bold">{lastPrice?.toFixed(lastPrice > 100 ? 3 : 6)}</div>
            <div className={`text-sm font-mono flex items-center gap-1 ${isUp ? "text-green-500" : "text-red-500"}`}>
              {isUp ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
              {isUp ? "+" : ""}{priceChange.toFixed(3)}%
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm"
              className="bg-green-500/10 text-green-500 border border-green-500/40 hover:bg-green-500/20 text-xs px-4 h-8"
              onClick={() => openTradeDialog("up")}>
              BUY / UP
            </Button>
            <Button size="sm"
              className="bg-red-500/10 text-red-500 border border-red-500/40 hover:bg-red-500/20 text-xs px-4 h-8"
              onClick={() => openTradeDialog("down")}>
              SELL / DOWN
            </Button>
          </div>
        </div>
      </div>

      {/* Price chart + AI recommendation */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="md:col-span-2 bg-card">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Price Action</CardTitle>
              <div className="text-xs font-mono text-muted-foreground">{market.lastUpdated ? new Date(market.lastUpdated).toLocaleTimeString() : ""}</div>
            </div>
          </CardHeader>
          <CardContent className="h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={priceData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
                <XAxis dataKey="timestamp" hide />
                <YAxis domain={["auto", "auto"]} hide />
                <Tooltip
                  contentStyle={{ backgroundColor: "#0c0c0e", border: "1px solid #27272a", borderRadius: "6px", fontSize: "11px" }}
                  formatter={(v: number) => [v.toFixed(v > 100 ? 3 : 6), "Price"]}
                  labelFormatter={() => ""}
                />
                <ReferenceLine y={firstPrice} stroke="#3f3f46" strokeDasharray="4 4" />
                <Line type="monotone" dataKey="price" stroke={isUp ? "#10b981" : "#ef4444"} strokeWidth={1.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">AI Recommendation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-xs text-muted-foreground">Direction</div>
              <Badge variant="outline" className={`text-sm px-3 py-1 font-bold ${recommendation?.direction === "up" ? "text-green-500 border-green-500/40" : "text-red-500 border-red-500/40"}`}>
                {recommendation?.direction?.toUpperCase()} {recommendation?.contractType}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-xs text-muted-foreground">Confidence</div>
              <div className={`text-lg font-mono font-bold ${(recommendation?.confidence ?? 0) >= 70 ? "text-green-500" : (recommendation?.confidence ?? 0) >= 50 ? "text-amber-500" : "text-red-500"}`}>
                {recommendation?.confidence?.toFixed(1)}%
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-xs text-muted-foreground">Profitability</div>
              <div className="text-sm font-mono">{recommendation?.profitability?.toFixed(0)}%</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-xs text-muted-foreground">Risk Score</div>
              <div className={`text-sm font-mono ${(recommendation?.riskScore ?? 0) <= 30 ? "text-green-500" : (recommendation?.riskScore ?? 0) <= 60 ? "text-amber-500" : "text-red-500"}`}>
                {recommendation?.riskScore?.toFixed(0)}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-xs text-muted-foreground">Quality Score</div>
              <div className="text-sm font-mono">{market.qualityScore?.toFixed(0)}</div>
            </div>

            {recommendation?.warnings && recommendation.warnings.length > 0 && (
              <div className="pt-1 space-y-1">
                {recommendation.warnings.map((w, i) => (
                  <div key={i} className="flex items-start gap-1.5 p-2 rounded bg-amber-500/10 border border-amber-500/20">
                    <AlertTriangle className="w-3 h-3 text-amber-500 flex-shrink-0 mt-0.5" />
                    <span className="text-[10px] text-amber-400">{w}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="pt-2 border-t border-border">
              <div className="text-[10px] text-muted-foreground leading-relaxed">{recommendation?.reasoning}</div>
            </div>

            <Badge variant="outline"
              className={`w-full justify-center text-xs ${recommendation?.shouldTrade ? "border-green-500/40 text-green-500" : "border-red-500/40 text-red-500"}`}>
              {recommendation?.shouldTrade ? "TRADE RECOMMENDED" : "DO NOT TRADE"}
            </Badge>
          </CardContent>
        </Card>
      </div>

      {/* Agent scores */}
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">Agent Analysis</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Object.entries(market.agentScores).map(([key, agent]: [string, any]) => (
            <AgentBar
              key={key}
              name={AGENT_LABELS[key] ?? key}
              score={agent.score}
              weight={agent.weight}
              signal={agent.signal}
              reasoning={agent.reasoning}
            />
          ))}
        </div>
      </div>

      {/* Trade dialog */}
      <Dialog open={tradeDialog} onOpenChange={setTradeDialog}>
        <DialogContent className="bg-card border-border max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className={tradeDir === "up" ? "text-green-500" : "text-red-500"}>
                {tradeDir === "up" ? "BUY" : "SELL"}
              </span>
              {market.symbol}
            </DialogTitle>
            <DialogDescription className="text-xs">
              AI confidence: {recommendation?.confidence?.toFixed(1)}% &bull; Risk: {recommendation?.riskScore?.toFixed(0)}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Stake Amount ($)</Label>
              <Input
                type="number"
                value={stake}
                onChange={(e) => setStake(e.target.value)}
                className="font-mono bg-secondary/50"
                min={0.01}
                step={0.01}
              />
              <div className="text-[10px] text-muted-foreground">
                AI recommended: ${recommendation?.stake?.toFixed(2)}
              </div>
            </div>
            <div className="p-3 rounded bg-secondary/30 border border-border text-xs text-muted-foreground leading-relaxed">
              {recommendation?.reasoning?.slice(0, 180)}...
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={() => setTradeDialog(false)} className="flex-1">Cancel</Button>
            <Button size="sm" onClick={handleTrade} disabled={executeTrade.isPending}
              className={`flex-1 ${tradeDir === "up" ? "bg-green-500/20 text-green-500 border border-green-500/40 hover:bg-green-500/30" : "bg-red-500/20 text-red-500 border border-red-500/40 hover:bg-red-500/30"}`}>
              {executeTrade.isPending ? "Executing..." : `Confirm ${tradeDir === "up" ? "BUY" : "SELL"}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
