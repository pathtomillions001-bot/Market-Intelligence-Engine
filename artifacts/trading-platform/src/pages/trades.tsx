import { useGetTrades } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { motion } from "framer-motion";
import { format } from "date-fns";

export default function Trades() {
  const { data: trades } = useGetTrades({}, { query: { refetchInterval: 10000 } });

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-8 max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Trade Journal</h1>
        <p className="text-muted-foreground mt-1">Complete history of manual and autonomous executions.</p>
      </div>

      <div className="space-y-4">
        {trades?.map((trade) => (
          <Card key={trade.id} className="bg-card">
            <CardContent className="p-4 flex items-center justify-between">
              <div className="flex items-center gap-6">
                <div className="w-24">
                  <div className="text-xs text-muted-foreground mb-1">{format(new Date(trade.createdAt), 'HH:mm:ss')}</div>
                  <div className="font-bold">{trade.symbol}</div>
                </div>
                <div>
                  <Badge variant="outline" className={trade.direction === 'up' ? 'text-green-500 border-green-500/30' : 'text-red-500 border-red-500/30'}>
                    {trade.direction.toUpperCase()}
                  </Badge>
                </div>
                <div>
                  <Badge variant="outline" className="text-muted-foreground border-border">
                    {trade.isAutonomous ? 'AUTO' : 'MANUAL'}
                  </Badge>
                </div>
              </div>
              
              <div className="flex items-center gap-8">
                <div className="text-right">
                  <div className="text-xs text-muted-foreground mb-1">Stake</div>
                  <div className="font-mono text-sm">${trade.stake.toFixed(2)}</div>
                </div>
                <div className="text-right w-24">
                  <div className="text-xs text-muted-foreground mb-1">Result</div>
                  {trade.status === 'open' ? (
                    <span className="text-amber-500 text-sm font-mono uppercase">Open</span>
                  ) : (
                    <span className={`font-mono text-sm font-bold ${trade.profit && trade.profit > 0 ? 'text-green-500' : 'text-red-500'}`}>
                      {trade.profit && trade.profit > 0 ? '+' : ''}{trade.profit?.toFixed(2)}
                    </span>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
        {trades?.length === 0 && (
          <div className="text-center py-12 text-muted-foreground">
            No trades found.
          </div>
        )}
      </div>
    </motion.div>
  );
}
