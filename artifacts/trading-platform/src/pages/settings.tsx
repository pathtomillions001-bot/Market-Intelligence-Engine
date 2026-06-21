import { useGetSettings, useUpdateSettings, useGetAccount } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { motion } from "framer-motion";
import { useState, useEffect } from "react";
import { toast } from "sonner";

export default function Settings() {
  const { data: settings } = useGetSettings();
  const { data: account } = useGetAccount();
  const updateSettings = useUpdateSettings();

  const [formData, setFormData] = useState({
    riskProfile: "moderate",
    maxRiskPerTrade: 2,
    dailyTarget: 100,
    dailyLossLimit: 50,
    minConfidenceThreshold: 75,
    autonomousEnabled: false
  });

  useEffect(() => {
    if (settings) {
      setFormData({
        riskProfile: settings.riskProfile,
        maxRiskPerTrade: settings.maxRiskPerTrade,
        dailyTarget: settings.dailyTarget,
        dailyLossLimit: settings.dailyLossLimit,
        minConfidenceThreshold: settings.minConfidenceThreshold,
        autonomousEnabled: settings.autonomousEnabled
      });
    }
  }, [settings]);

  const handleSave = () => {
    updateSettings.mutate({
      data: {
        riskProfile: formData.riskProfile as any,
        maxRiskPerTrade: Number(formData.maxRiskPerTrade),
        dailyTarget: Number(formData.dailyTarget),
        dailyLossLimit: Number(formData.dailyLossLimit),
        minConfidenceThreshold: Number(formData.minConfidenceThreshold),
        autonomousEnabled: formData.autonomousEnabled
      }
    }, {
      onSuccess: () => toast.success("Settings updated successfully"),
      onError: (err) => toast.error(err.error || "Failed to update settings")
    });
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-8 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-1">Configure trading parameters and engine behavior.</p>
      </div>

      <Card className="bg-card">
        <CardHeader>
          <CardTitle>Risk Profile</CardTitle>
          <CardDescription>Global risk configuration for the AI engine.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-1 gap-6">
            <div className="space-y-2">
              <Label>Profile Preset</Label>
              <Select 
                value={formData.riskProfile} 
                onValueChange={(val) => setFormData(prev => ({ ...prev, riskProfile: val }))}
              >
                <SelectTrigger className="w-full bg-secondary/50">
                  <SelectValue placeholder="Select profile" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="conservative">Conservative</SelectItem>
                  <SelectItem value="moderate">Moderate</SelectItem>
                  <SelectItem value="aggressive">Aggressive</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label>Max Risk Per Trade (%)</Label>
                <Input 
                  type="number" 
                  value={formData.maxRiskPerTrade}
                  onChange={(e) => setFormData(prev => ({ ...prev, maxRiskPerTrade: Number(e.target.value) }))}
                  className="bg-secondary/50 font-mono"
                />
              </div>
              <div className="space-y-2">
                <Label>Min Confidence Threshold (%)</Label>
                <Input 
                  type="number" 
                  value={formData.minConfidenceThreshold}
                  onChange={(e) => setFormData(prev => ({ ...prev, minConfidenceThreshold: Number(e.target.value) }))}
                  className="bg-secondary/50 font-mono"
                />
              </div>
              <div className="space-y-2">
                <Label>Daily Profit Target ($)</Label>
                <Input 
                  type="number" 
                  value={formData.dailyTarget}
                  onChange={(e) => setFormData(prev => ({ ...prev, dailyTarget: Number(e.target.value) }))}
                  className="bg-secondary/50 font-mono"
                />
              </div>
              <div className="space-y-2">
                <Label>Daily Loss Limit ($)</Label>
                <Input 
                  type="number" 
                  value={formData.dailyLossLimit}
                  onChange={(e) => setFormData(prev => ({ ...prev, dailyLossLimit: Number(e.target.value) }))}
                  className="bg-secondary/50 font-mono"
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card">
        <CardHeader>
          <CardTitle>System Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between p-4 border border-border rounded-lg bg-secondary/30">
            <div>
              <div className="font-medium">Autonomous Trading</div>
              <div className="text-sm text-muted-foreground">Allow AI to execute trades without manual approval.</div>
            </div>
            <Switch 
              checked={formData.autonomousEnabled}
              onCheckedChange={(checked) => setFormData(prev => ({ ...prev, autonomousEnabled: checked }))}
            />
          </div>
          
          {account && (
            <div className="p-4 border border-border rounded-lg bg-secondary/30">
              <div className="text-sm font-medium mb-2 uppercase tracking-wider text-muted-foreground">Connected Exchange</div>
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-mono text-lg">{account.loginId}</div>
                  <div className="text-sm text-primary">Deriv API Active</div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-muted-foreground">Balance</div>
                  <div className="font-mono text-lg">{account.currency} {account.balance.toFixed(2)}</div>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end pt-4">
        <Button onClick={handleSave} disabled={updateSettings.isPending} className="w-32">
          {updateSettings.isPending ? "Saving..." : "Save Settings"}
        </Button>
      </div>
    </motion.div>
  );
}
