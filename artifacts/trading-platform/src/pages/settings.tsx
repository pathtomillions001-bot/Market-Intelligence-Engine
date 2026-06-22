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
import { Info } from "lucide-react";

function SettingRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b border-border/50 last:border-0">
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm">{label}</div>
        {description && <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{description}</div>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

function NumInput({ value, onChange, min, max, step = 1, suffix }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; suffix?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-24 text-right font-mono text-sm bg-secondary/50"
      />
      {suffix && <span className="text-xs text-muted-foreground w-8">{suffix}</span>}
    </div>
  );
}

const CONTRACT_TYPE_OPTIONS = ["CALL", "PUT", "RISE", "FALL", "DIGITOVER", "DIGITUNDER"];
const CATEGORY_OPTIONS = ["synthetic", "forex", "commodities", "derived"];

export default function Settings() {
  const { data: settings, isLoading } = useGetSettings();
  const { data: account } = useGetAccount();
  const updateSettings = useUpdateSettings();

  const [form, setForm] = useState({
    riskProfile: "moderate",
    maxRiskPerTrade: 2,
    dailyTarget: 50,
    dailyLossLimit: 30,
    maxDrawdown: 10,
    consecutiveLossLimit: 3,
    minConfidenceThreshold: 55,
    marketRotationAfter: 5,
    loopIntervalSec: 30,
    tradeDurationSec: 5,
    maxTradeStake: 500,
    autonomousEnabled: false,
    recoveryMode: false,
    recoveryMultiplier: 1.2,
    maxRecoverySteps: 3,
    scanAllMarkets: true,
    preferredContractTypes: ["CALL", "PUT", "RISE", "FALL"] as string[],
    preferredCategories: ["synthetic", "forex"] as string[],
  });

  useEffect(() => {
    if (settings) {
      setForm({
        riskProfile: settings.riskProfile,
        maxRiskPerTrade: settings.maxRiskPerTrade,
        dailyTarget: settings.dailyTarget,
        dailyLossLimit: settings.dailyLossLimit,
        maxDrawdown: settings.maxDrawdown,
        consecutiveLossLimit: settings.consecutiveLossLimit,
        minConfidenceThreshold: settings.minConfidenceThreshold,
        marketRotationAfter: settings.marketRotationAfter,
        loopIntervalSec: (settings as any).loopIntervalSec ?? 30,
        tradeDurationSec: (settings as any).tradeDurationSec ?? 5,
        maxTradeStake: (settings as any).maxTradeStake ?? 500,
        autonomousEnabled: settings.autonomousEnabled,
        recoveryMode: (settings as any).recoveryMode ?? false,
        recoveryMultiplier: (settings as any).recoveryMultiplier ?? 1.2,
        maxRecoverySteps: (settings as any).maxRecoverySteps ?? 3,
        scanAllMarkets: (settings as any).scanAllMarkets ?? true,
        preferredContractTypes: settings.preferredContractTypes,
        preferredCategories: settings.preferredCategories,
      });
    }
  }, [settings]);

  const set = (key: string, val: unknown) => setForm((prev) => ({ ...prev, [key]: val }));

  const toggleArr = (arr: string[], val: string): string[] =>
    arr.includes(val) ? arr.filter((v) => v !== val) : [...arr, val];

  const handleSave = () => {
    updateSettings.mutate({ data: form as any }, {
      onSuccess: () => toast.success("Settings saved"),
      onError: (err: any) => toast.error(err?.error || "Failed to save settings"),
    });
  };

  if (isLoading) {
    return <div className="p-8 text-muted-foreground text-sm animate-pulse">Loading settings…</div>;
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 md:p-8 max-w-3xl mx-auto space-y-5 pb-20">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-1 text-sm">Full control over the AI engine and risk parameters.</p>
      </div>

      {account && (
        <div className="flex items-center gap-3 p-3 rounded-lg bg-green-500/5 border border-green-500/20">
          <div className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
          <span className="text-sm text-green-400">Live trading on <span className="font-mono">{account.loginId}</span> — Balance: {account.currency} {account.balance.toFixed(2)}</span>
        </div>
      )}

      {/* Risk Profile */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Risk Profile</CardTitle>
          <CardDescription className="text-xs">Global risk configuration for the AI engine.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-0">
          <SettingRow label="Profile Preset" description="Conservative trades smaller stakes. Aggressive allows higher risk.">
            <Select value={form.riskProfile} onValueChange={(v) => set("riskProfile", v)}>
              <SelectTrigger className="w-36 bg-secondary/50 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="conservative">Conservative</SelectItem>
                <SelectItem value="moderate">Moderate</SelectItem>
                <SelectItem value="aggressive">Aggressive</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow label="Max Risk Per Trade" description="Maximum % of your balance to risk on a single trade.">
            <NumInput value={form.maxRiskPerTrade} onChange={(v) => set("maxRiskPerTrade", v)} min={0.1} max={10} step={0.1} suffix="%" />
          </SettingRow>
          <SettingRow label="Max Stake Per Trade" description="Hard cap on stake size per trade, regardless of balance.">
            <NumInput value={form.maxTradeStake} onChange={(v) => set("maxTradeStake", v)} min={0.35} max={50000} step={1} suffix="$" />
          </SettingRow>
        </CardContent>
      </Card>

      {/* Daily Limits */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Daily Limits</CardTitle>
          <CardDescription className="text-xs">Engine stops automatically when these thresholds are reached.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-0">
          <SettingRow label="Daily Profit Target" description="Stop trading for the day once this profit is reached.">
            <NumInput value={form.dailyTarget} onChange={(v) => set("dailyTarget", v)} min={1} max={100000} step={1} suffix="$" />
          </SettingRow>
          <SettingRow label="Daily Loss Limit" description="Stop trading for the day if total loss reaches this amount.">
            <NumInput value={form.dailyLossLimit} onChange={(v) => set("dailyLossLimit", v)} min={1} max={100000} step={1} suffix="$" />
          </SettingRow>
          <SettingRow label="Max Drawdown" description="Stop if portfolio drawdown exceeds this percentage.">
            <NumInput value={form.maxDrawdown} onChange={(v) => set("maxDrawdown", v)} min={1} max={50} step={0.5} suffix="%" />
          </SettingRow>
          <SettingRow label="Consecutive Loss Limit" description="Pause engine after this many losses in a row.">
            <NumInput value={form.consecutiveLossLimit} onChange={(v) => set("consecutiveLossLimit", v)} min={1} max={20} step={1} />
          </SettingRow>
        </CardContent>
      </Card>

      {/* Engine Behavior */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Engine Behavior</CardTitle>
          <CardDescription className="text-xs">How the autonomous AI engine scans and executes trades.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-0">
          <SettingRow label="Min Confidence Threshold" description="AI must be at least this confident before trading.">
            <NumInput value={form.minConfidenceThreshold} onChange={(v) => set("minConfidenceThreshold", v)} min={40} max={95} step={1} suffix="%" />
          </SettingRow>
          <SettingRow label="Scan Interval" description="Seconds between each market scan cycle.">
            <NumInput value={form.loopIntervalSec} onChange={(v) => set("loopIntervalSec", v)} min={5} max={300} step={5} suffix="s" />
          </SettingRow>
          <SettingRow label="Trade Duration" description="Contract length in ticks (5t = ~5 seconds on synthetic indices).">
            <NumInput value={form.tradeDurationSec} onChange={(v) => set("tradeDurationSec", v)} min={1} max={10} step={1} suffix="t" />
          </SettingRow>
          <SettingRow label="Market Rotation After" description="Stay on the same market for this many trades before rotating.">
            <NumInput value={form.marketRotationAfter} onChange={(v) => set("marketRotationAfter", v)} min={1} max={20} step={1} />
          </SettingRow>
          <SettingRow label="Scan All Markets" description="Analyze all 33+ markets in parallel to find the best opportunity.">
            <Switch checked={form.scanAllMarkets} onCheckedChange={(v) => set("scanAllMarkets", v)} />
          </SettingRow>
          <SettingRow label="Autonomous Trading" description="Allow AI to execute trades without manual approval.">
            <Switch checked={form.autonomousEnabled} onCheckedChange={(v) => set("autonomousEnabled", v)} />
          </SettingRow>
        </CardContent>
      </Card>

      {/* Recovery Mode */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Recovery Mode</CardTitle>
          <CardDescription className="text-xs">Smart stake adjustment after losses — not martingale.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-0">
          <SettingRow label="Enable Recovery Mode" description="After a loss, slightly increase stake to recover. Resets on any win.">
            <Switch checked={form.recoveryMode} onCheckedChange={(v) => set("recoveryMode", v)} />
          </SettingRow>
          {form.recoveryMode && (
            <>
              <SettingRow label="Recovery Multiplier" description="Stake multiplier after each loss (e.g. 1.2 = 20% increase).">
                <NumInput value={form.recoveryMultiplier} onChange={(v) => set("recoveryMultiplier", Math.min(Math.max(v, 1.05), 1.5))} min={1.05} max={1.5} step={0.05} suffix="×" />
              </SettingRow>
              <SettingRow label="Max Recovery Steps" description="Max number of consecutive multiplications before resetting to base stake.">
                <NumInput value={form.maxRecoverySteps} onChange={(v) => set("maxRecoverySteps", v)} min={1} max={5} step={1} />
              </SettingRow>
              <div className="mt-3 p-3 bg-secondary/30 rounded-lg flex items-start gap-2">
                <Info className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
                <p className="text-xs text-muted-foreground">
                  Max exposure with current settings: <span className="text-foreground font-mono">{form.recoveryMultiplier}^{form.maxRecoverySteps} = {Math.pow(form.recoveryMultiplier, form.maxRecoverySteps).toFixed(2)}×</span> base stake.
                  This is safe because it resets on any win and is capped by Max Stake Per Trade.
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Contract Types */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Contract Types</CardTitle>
          <CardDescription className="text-xs">Select which contract types the AI engine will use.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {CONTRACT_TYPE_OPTIONS.map((type) => {
              const active = form.preferredContractTypes.includes(type);
              return (
                <button
                  key={type}
                  onClick={() => set("preferredContractTypes", toggleArr(form.preferredContractTypes, type))}
                  className={`px-3 py-1.5 rounded-md text-xs font-mono font-medium border transition-colors ${
                    active ? "bg-primary/10 border-primary/40 text-primary" : "bg-secondary/50 border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {type}
                </button>
              );
            })}
          </div>
          <div className="mt-3 text-xs text-muted-foreground space-y-0.5">
            <p><span className="text-foreground">CALL/PUT</span> — higher/lower at expiry (all markets)</p>
            <p><span className="text-foreground">RISE/FALL</span> — rises/falls from entry tick (synthetic markets)</p>
            <p><span className="text-foreground">OVER/UNDER</span> — last digit over/under 5 (1s synthetic indices only)</p>
          </div>
        </CardContent>
      </Card>

      {/* Market Categories */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Market Categories</CardTitle>
          <CardDescription className="text-xs">Which categories the engine will scan and trade.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {CATEGORY_OPTIONS.map((cat) => {
              const active = form.preferredCategories.includes(cat);
              return (
                <button
                  key={cat}
                  onClick={() => set("preferredCategories", toggleArr(form.preferredCategories, cat))}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium border capitalize transition-colors ${
                    active ? "bg-primary/10 border-primary/40 text-primary" : "bg-secondary/50 border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {cat}
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end pt-2">
        <Button onClick={handleSave} disabled={updateSettings.isPending} className="w-full sm:w-40">
          {updateSettings.isPending ? "Saving…" : "Save All Settings"}
        </Button>
      </div>
    </motion.div>
  );
}
