import { useState } from "react";
import { useGetMarkets } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { motion } from "framer-motion";
import { Link } from "wouter";
import { TrendingUp, TrendingDown, Minus, ChevronRight } from "lucide-react";

type Category = "all" | "synthetic" | "forex" | "commodities" | "derived";

const CATEGORIES: { key: Category; label: string }[] = [
  { key: "all", label: "All Markets" },
  { key: "synthetic", label: "Synthetic" },
  { key: "forex", label: "Forex" },
  { key: "commodities", label: "Commodities" },
  { key: "derived", label: "Derived" },
];

function TrendIcon({ trend }: { trend: string }) {
  if (trend.includes("up")) return <TrendingUp className="w-3.5 h-3.5 text-green-500" />;
  if (trend.includes("down")) return <TrendingDown className="w-3.5 h-3.5 text-red-500" />;
  return <Minus className="w-3.5 h-3.5 text-zinc-500" />;
}

function ScoreBar({ value, max = 100 }: { value: number; max?: number }) {
  const pct = (value / max) * 100;
  const color = pct >= 70 ? "bg-green-500" : pct >= 50 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="text-sm font-mono w-8">{value.toFixed(0)}</div>
      <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function Markets() {
  const [category, setCategory] = useState<Category>("all");
  const { data: markets, isLoading } = useGetMarkets(
    { category: category === "all" ? undefined : category },
    { query: { refetchInterval: 15000 } } as { query: any }
  );

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Market Scanner</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {markets?.length ?? 0} markets ranked by AI quality score — real-time
          </p>
        </div>
        {isLoading && (
          <div className="text-xs text-muted-foreground font-mono animate-pulse">Scanning...</div>
        )}
      </div>

      {/* Category tabs */}
      <div className="flex gap-1.5 flex-wrap">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.key}
            onClick={() => setCategory(cat.key)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              category === cat.key
                ? "bg-primary/20 text-primary border border-primary/40"
                : "bg-secondary/50 text-muted-foreground border border-border hover:text-foreground"
            }`}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Column headers */}
      <div className="grid grid-cols-12 gap-4 px-4 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
        <div className="col-span-1">#</div>
        <div className="col-span-3">Market</div>
        <div className="col-span-2">Trend</div>
        <div className="col-span-2">Quality</div>
        <div className="col-span-2">Confidence</div>
        <div className="col-span-1">Risk</div>
        <div className="col-span-1"></div>
      </div>

      <div className="space-y-1.5">
        {markets?.map((market) => {
          const confColor = market.confidenceScore >= 70 ? "text-green-500" : market.confidenceScore >= 50 ? "text-amber-500" : "text-red-500";
          const riskColor = market.riskScore <= 30 ? "text-green-500" : market.riskScore <= 60 ? "text-amber-500" : "text-red-500";
          return (
            <Link key={market.symbol} href={`/markets/${market.symbol}`}>
              <Card className="hover:border-primary/40 cursor-pointer transition-all group bg-card hover:bg-secondary/30">
                <CardContent className="p-3 grid grid-cols-12 gap-4 items-center">
                  <div className="col-span-1 text-xs text-muted-foreground font-mono">#{market.rank}</div>

                  <div className="col-span-3">
                    <div className="flex items-center gap-2">
                      <div>
                        <div className="font-semibold text-sm flex items-center gap-1.5">
                          {market.symbol}
                          {market.confidenceScore >= 75 && (
                            <Badge variant="default" className="bg-primary/20 text-primary border-primary/30 text-[9px] px-1.5 py-0">HOT</Badge>
                          )}
                        </div>
                        <div className="text-[11px] text-muted-foreground truncate max-w-[120px]">{market.displayName}</div>
                      </div>
                    </div>
                  </div>

                  <div className="col-span-2">
                    <div className="flex items-center gap-1.5">
                      <TrendIcon trend={market.trend} />
                      <span className="text-xs font-mono capitalize">{market.trend.replace("_", " ")}</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5 capitalize">{market.volatility} vol</div>
                  </div>

                  <div className="col-span-2">
                    <ScoreBar value={market.qualityScore} />
                  </div>

                  <div className="col-span-2">
                    <div className={`text-base font-mono font-bold ${confColor}`}>
                      {market.confidenceScore.toFixed(0)}%
                    </div>
                    {market.recommendedContractType && (
                      <div className="text-[10px] text-muted-foreground">{market.recommendedContractType}</div>
                    )}
                  </div>

                  <div className="col-span-1">
                    <span className={`text-xs font-mono font-bold ${riskColor}`}>{market.riskScore.toFixed(0)}</span>
                  </div>

                  <div className="col-span-1 flex justify-end">
                    <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
        {markets?.length === 0 && (
          <div className="text-center py-12 text-muted-foreground text-sm">No markets available for this category.</div>
        )}
      </div>
    </motion.div>
  );
}
