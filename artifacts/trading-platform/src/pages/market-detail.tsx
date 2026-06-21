import { useGetMarketDetail, useExecuteTrade } from "@workspace/api-client-react";
import { useParams } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { toast } from "sonner";

export default function MarketDetail() {
  const { symbol } = useParams();
  const { data: market } = useGetMarketDetail(symbol || "", { 
    query: { refetchInterval: 5000, enabled: !!symbol } 
  });
  const executeTrade = useExecuteTrade();

  if (!market) return <div className="p-8">Loading market...</div>;

  const handleTrade = (direction: 'up' | 'down') => {
    executeTrade.mutate({
      data: {
        symbol: market.symbol,
        contractType: market.recommendation.contractType,
        stake: market.recommendation.stake,
        direction
      }
    }, {
      onSuccess: () => toast.success(`Executed ${direction} trade for ${market.symbol}`),
      onError: (err) => toast.error(err.error || "Failed to execute trade")
    });
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{market.symbol}</h1>
          <p className="text-muted-foreground mt-1">{market.displayName}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="bg-green-500/10 text-green-500 border-green-500/50 hover:bg-green-500/20" onClick={() => handleTrade('up')}>
            BUY / UP
          </Button>
          <Button variant="outline" className="bg-red-500/10 text-red-500 border-red-500/50 hover:bg-red-500/20" onClick={() => handleTrade('down')}>
            SELL / DOWN
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="md:col-span-2 bg-card">
          <CardHeader>
            <CardTitle>Price Action</CardTitle>
          </CardHeader>
          <CardContent className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={market.priceHistory}>
                <XAxis dataKey="timestamp" hide />
                <YAxis domain={['auto', 'auto']} hide />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#121214', border: '1px solid #27272a' }}
                  labelStyle={{ color: '#888' }}
                />
                <Line type="monotone" dataKey="price" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="bg-card">
          <CardHeader>
            <CardTitle>AI Recommendation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Direction</div>
              <Badge variant="outline" className={`text-base px-3 py-1 ${market.recommendation.direction === 'up' ? 'text-green-500 border-green-500' : 'text-red-500 border-red-500'}`}>
                {market.recommendation.direction.toUpperCase()}
              </Badge>
            </div>
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Confidence</div>
              <div className="text-2xl font-mono">{market.recommendation.confidence.toFixed(1)}%</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Reasoning</div>
              <p className="text-sm text-muted-foreground leading-relaxed">{market.recommendation.reasoning}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <h2 className="text-xl font-bold mt-8 mb-4">Agent Analysis</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {Object.entries(market.agentScores).map(([key, agent]: [string, any]) => (
          <Card key={key} className="bg-secondary/30">
            <CardContent className="p-4">
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-2 truncate">{key.replace(/([A-Z])/g, ' $1').trim()}</div>
              <div className="flex justify-between items-end mb-2">
                <div className="text-xl font-mono">{agent.score.toFixed(1)}</div>
                <Badge variant="outline" className="text-[10px] uppercase">
                  {agent.signal.replace('_', ' ')}
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground line-clamp-2" title={agent.reasoning}>
                {agent.reasoning}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </motion.div>
  );
}
