import { useGetMarkets } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { motion } from "framer-motion";
import { Link } from "wouter";

export default function Markets() {
  const { data: markets } = useGetMarkets({}, { query: { refetchInterval: 10000 } });

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-8 max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Market Scanner</h1>
        <p className="text-muted-foreground mt-1">Real-time ranking of trading opportunities based on AI confidence.</p>
      </div>

      <div className="grid gap-4">
        {markets?.map((market, idx) => (
          <Link key={market.symbol} href={`/markets/${market.symbol}`}>
            <Card className="hover:border-primary/50 cursor-pointer transition-colors group">
              <CardContent className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-8 text-center text-muted-foreground font-mono">#{idx + 1}</div>
                  <div>
                    <div className="font-bold flex items-center gap-2">
                      {market.symbol}
                      {market.confidenceScore >= 80 && <Badge variant="default" className="bg-primary/20 text-primary hover:bg-primary/20">Hot</Badge>}
                    </div>
                    <div className="text-sm text-muted-foreground">{market.displayName}</div>
                  </div>
                </div>
                
                <div className="flex items-center gap-8">
                  <div className="text-right">
                    <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wider">Trend</div>
                    <div className="font-mono text-sm capitalize">{market.trend.replace('_', ' ')}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wider">Quality</div>
                    <div className="font-mono text-sm">{market.qualityScore.toFixed(1)}</div>
                  </div>
                  <div className="text-right w-24">
                    <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wider">Confidence</div>
                    <div className={`font-mono text-lg font-bold ${
                      market.confidenceScore >= 70 ? "text-green-500" : 
                      market.confidenceScore >= 50 ? "text-amber-500" : "text-red-500"
                    }`}>
                      {market.confidenceScore.toFixed(1)}%
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </motion.div>
  );
}
