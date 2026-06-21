import { useGetPerformanceAnalytics, useGetDrawdownAnalysis, useGetMarketBreakdown } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { motion } from "framer-motion";
import { LineChart, Line, AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, CartesianGrid } from "recharts";

export default function Analytics() {
  const { data: performance } = useGetPerformanceAnalytics({ days: 30 });
  const { data: drawdown } = useGetDrawdownAnalysis();
  const { data: marketBreakdown } = useGetMarketBreakdown();

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-8 max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Analytics</h1>
        <p className="text-muted-foreground mt-1">Deep dive into engine performance and trading metrics.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="bg-card">
          <CardHeader>
            <CardTitle>Cumulative Profit (30d)</CardTitle>
          </CardHeader>
          <CardContent className="h-[300px]">
            {performance?.profitCurve && (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={performance.profitCurve} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorProfit" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" hide />
                  <YAxis />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#121214', border: '1px solid #27272a' }}
                  />
                  <Area type="monotone" dataKey="cumulativeProfit" stroke="hsl(var(--primary))" fillOpacity={1} fill="url(#colorProfit)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card">
          <CardHeader>
            <CardTitle>Win Rate History (30d)</CardTitle>
          </CardHeader>
          <CardContent className="h-[300px]">
            {performance?.winRateHistory && (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={performance.winRateHistory} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <XAxis dataKey="date" hide />
                  <YAxis domain={[0, 100]} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#121214', border: '1px solid #27272a' }}
                  />
                  <Line type="monotone" dataKey="winRate" stroke="#10b981" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="bg-card lg:col-span-2">
          <CardHeader>
            <CardTitle>Market Breakdown</CardTitle>
          </CardHeader>
          <CardContent className="h-[300px]">
            {marketBreakdown && (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={marketBreakdown} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                  <XAxis dataKey="symbol" />
                  <YAxis />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#121214', border: '1px solid #27272a' }}
                  />
                  <Bar dataKey="totalProfit" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card">
          <CardHeader>
            <CardTitle>Drawdown Risk</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {drawdown && (
              <>
                <div>
                  <div className="flex justify-between mb-1 text-sm">
                    <span className="text-muted-foreground">Current Drawdown</span>
                    <span className="font-mono text-red-500">{drawdown.currentDrawdown.toFixed(2)}%</span>
                  </div>
                  <div className="h-2 w-full bg-secondary rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-red-500" 
                      style={{ width: `${Math.min((drawdown.currentDrawdown / drawdown.drawdownLimit) * 100, 100)}%` }}
                    />
                  </div>
                </div>
                <div>
                  <div className="flex justify-between mb-1 text-sm">
                    <span className="text-muted-foreground">Max Drawdown</span>
                    <span className="font-mono">{drawdown.maxDrawdown.toFixed(2)}%</span>
                  </div>
                  <div className="h-2 w-full bg-secondary rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-amber-500" 
                      style={{ width: `${Math.min((drawdown.maxDrawdown / drawdown.drawdownLimit) * 100, 100)}%` }}
                    />
                  </div>
                </div>
                <div className="pt-4 border-t border-border">
                  <div className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Consecutive Losses</div>
                  <div className="text-3xl font-mono">{drawdown.consecutiveLosses} <span className="text-sm text-muted-foreground">/ {drawdown.consecutiveLossLimit} limit</span></div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </motion.div>
  );
}
