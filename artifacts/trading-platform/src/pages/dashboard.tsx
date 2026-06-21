import { useGetDailySummary, useGetTopMarket, useGetAiEngineStatus } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { motion } from "framer-motion";

export default function Dashboard() {
  const { data: summary } = useGetDailySummary({ query: { refetchInterval: 5000 } });
  const { data: topMarket } = useGetTopMarket({ query: { refetchInterval: 5000 } });
  const { data: engine } = useGetAiEngineStatus({ query: { refetchInterval: 5000 } });

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-8 max-w-7xl mx-auto space-y-6">
      <header className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground mt-1 font-mono text-sm">System Status: {engine?.isRunning ? "ONLINE" : "STANDBY"}</p>
        </div>
        <div className="text-right">
          <div className="text-sm text-muted-foreground">Current P&L</div>
          <div className={`text-2xl font-mono font-bold ${summary && summary.totalProfit >= 0 ? "text-green-500" : "text-red-500"}`}>
            {summary && summary.totalProfit >= 0 ? "+" : ""}{summary?.totalProfit.toFixed(2)}
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Trades Today</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-mono">{summary?.tradesCount || 0}</div>
            <div className="flex gap-4 mt-2 text-sm font-mono">
              <span className="text-green-500">{summary?.wonCount || 0}W</span>
              <span className="text-red-500">{summary?.lostCount || 0}L</span>
            </div>
          </CardContent>
        </Card>
        
        <Card className="bg-card md:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Top Opportunity</CardTitle>
          </CardHeader>
          <CardContent>
            {topMarket ? (
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-2xl font-bold">{topMarket.symbol}</div>
                  <div className="text-sm text-muted-foreground">{topMarket.displayName}</div>
                </div>
                <div className="text-right">
                  <div className="text-sm text-muted-foreground mb-1">AI Confidence</div>
                  <div className="text-xl font-mono text-primary">{topMarket.recommendation?.confidence.toFixed(1)}%</div>
                </div>
              </div>
            ) : (
              <div className="text-muted-foreground text-sm py-4">Scanning markets...</div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Engine Status</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {engine?.agentStatuses.map(agent => (
              <div key={agent.name} className="p-3 rounded border border-border bg-secondary/50">
                <div className="flex justify-between items-center mb-2">
                  <div className="text-xs font-medium text-muted-foreground truncate" title={agent.name}>{agent.name}</div>
                  <div className={`w-1.5 h-1.5 rounded-full ${agent.isActive ? "bg-green-500" : "bg-muted"}`} />
                </div>
                <div className="text-lg font-mono">{agent.confidence.toFixed(1)}%</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
