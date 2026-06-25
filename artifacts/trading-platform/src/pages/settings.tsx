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
        type="number" value={value} min={min} max={max} step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-24 text-right font-mono text-sm bg-secondary/50"
      />
      {suffix && <span className="text-xs text-muted-foreground w-8">{suffix}</span>}
    </div>
  );
}

const CONTRACT_TYPES = [
  { id: "RISE", label: "RISE", desc: "Price rises from entry tick" },
  { id: "FALL", label: "FALL", desc: "Price falls from entry tick" },
  { id: "CALL", label: "CALL", desc: "Higher at expiry" },
  { id: "PUT", label: "PUT", desc: "Lower at expiry" },
  { id: "DIGITOVER", label: "OVER", desc: "Last digit > barrier (1s synthetics)" },
  { id: "DIGITUNDER", label: "UNDER", desc: "Last digit < barrier (1s synthetics)" },
];

// All 17 Deriv Synthetic Indices
const ALL_MARKETS = [
  { symbol: "R_10", label: "Volatility 10", group: "Volatility" },
  { symbol: "R_25", label: "Volatility 25", group: "Volatility" },
  { symbol: "R_50", label: "Volatility 50", group: "Volatility" },
  { symbol: "R_75", label: "Volatility 75", group: "Volatility" },
  { symbol: "R_100", label: "Volatility 100", group: "Volatility" },
  { symbol: "1HZ10V", label: "Volatility 10 (1s)", group: "Step" },
  { symbol: "1HZ25V", label: "Volatility 25 (1s)", group: "Step" },
  { symbol: "1HZ50V", label: "Volatility 50 (1s)", group: "Step" },
  { symbol: "1HZ75V", label: "Volatility 75 (1s)", group: "Step" },
  { symbol: "1HZ100V", label: "Volatility 100 (1s)", group: "Step" },
  { symbol: "STPRNG", label: "Step Index", group: "Step" },
  { symbol: "JD10", label: "Jump 10", group: "Jump" },
  { symbol: "JD25", label: "Jump 25", group: "Jump" },
  { symbol: "JD50", label: "Jump 50", group: "Jump" },
  { symbol: "JD75", label: "Jump 75", group: "Jump" },
  { symbol: "JD100", label: "Jump 100", group: "Jump" },
  { symbol: "BOOM300N", label: "Boom 300", group: "Crash/Boom" },
];

const MARKET_GROUPS = ["Volatility", "Step", "Jump", "Crash/Boom"];

export default function Settings() {
  const { data: settings, isLoading } = useGetSettings();
  const { data: account } = useGetAccount();
  const updateSettings = useUpdateSettings();

  const [form, setForm] = useState({
    riskProfile: "moderate" as "conservative" | "moderate" | "aggressive",
    maxRiskPerTrade: 2,
    dailyTarget: 50,
    dailyLossLimit: 30,
    maxDrawdown: 10,
    consecutiveLossLimit: 3,
    minConfidenceThreshold: 55,
    marketRotationAfter: 5,
    loopIntervalSec: 15,
    tradeDurationSec: 5,
    maxTradeStake: 500,
    autonomousEnabled: false,
    recoveryMode: false,
    recoveryMultiplier: 1.2,
    maxRecoverySteps: 3,
    scanAllMarkets: true,
    paperTradeMode: false,
    requirePositiveEv: true,
    preferredContractTypes: ["RISE", "FALL", "CALL", "PUT", "DIGITOVER", "DIGITUNDER"],
    preferredCategories: ["synthetic"],
    allowedMarkets: [] as string[],
  });

  useEffect(() => {
    if (settings) {
      setForm({
        riskProfile: settings.riskProfile as any,
        maxRiskPerTrade: settings.maxRiskPerTrade,
        dailyTarget: settings.dailyTarget,
        dailyLossLimit: settings.dailyLossLimit,
        maxDrawdown: settings.maxDrawdown,
        consecutiveLossLimit: settings.consecutiveLossLimit,
        minConfidenceThreshold: settings.minConfidenceThreshold,
        marketRotationAfter: settings.marketRotationAfter,
        loopIntervalSec: (settings as any).loopIntervalSec ?? 15,
        tradeDurationSec: (settings as any).tradeDurationSec ?? 5,
        maxTradeStake: (settings as any).maxTradeStake ?? 500,
        autonomousEnabled: settings.autonomousEnabled,
        recoveryMode: (settings as any).recoveryMode ?? false,
        recoveryMultiplier: (settings as any).recoveryMultiplier ?? 1.2,
        maxRecoverySteps: (settings as any).maxRecoverySteps ?? 3,
        scanAllMarkets: (settings as any).scanAllMarkets ?? true,
        paperTradeMode: (settings as any).paperTradeMode ?? false,
        requirePositiveEv: (settings as any).requirePositiveEv ?? true,
        preferredContractTypes: settings.preferredContractTypes.length > 0 ? settings.preferredContractTypes : ["RISE", "FALL", "CALL", "PUT", "DIGITOVER", "DIGITUNDER"],
        preferredCategories: ["synthetic"],
        allowedMarkets: (settings as any).allowedMarkets ?? [],
      });
    }
  }, [settings]);

  const set = (key: string, val: unknown) => setForm((prev) => ({ ...prev, [key]: val }));
  const toggleContract = (id: string) => setForm((prev) => ({
    ...prev,
    preferredContractTypes: prev.preferredContractTypes.includes(id)
      ? prev.preferredContractTypes.filter((c) => c !== id)
      : [...prev.preferredContractTypes, id],
  }));
  const toggleMarket = (symbol: string) => setForm((prev) => {
    const allowed = prev.allowedMarkets.includes(symbol)
      ? prev.allowedMarkets.filter(s => s !== symbol)
      : [...prev.allowedMarkets, symbol];
    return { ...prev, allowedMarkets: allowed };
  });
  const selectAllMarkets = () => setForm((prev) => ({ ...prev, allowedMarkets: [] }));
  const selectGroup = (group: string) => {
    const groupSymbols = ALL_MARKETS.filter(m => m.group === group).map(m => m.symbol);
    setForm((prev) => ({ ...prev, allowedMarkets: groupSymbols }));
  };

  const handleSave = () => {
    updateSettings.mutate({ data: { ...form, preferredCategories: ["synthetic"] } as any }, {
      onSuccess: () => toast.success("Settings saved"),
      onError: (err: any) => toast.error(err?.error || "Failed to save settings"),
    });
  };

  if (isLoading) return <div className="p-8 text-muted-foreground text-sm animate-pulse">Loading settings…</div>;

  const maxRecovery = Math.pow(form.recoveryMultiplier, form.maxRecoverySteps);
  const isAllMarkets = form.allowedMarkets.length === 0;
  const selectedCount = form.allowedMarkets.length;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 md:p-8 max-w-3xl mx-auto space-y-5 pb-24">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-1 text-sm">Full control over the AI engine — Synthetic Indices only.</p>
      </div>

      {account && (
        <div className="flex items-center gap-3 p-3 rounded-lg bg-green-500/5 border border-green-500/20">
          <div className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
          <span className="text-sm text-green-400">Live on <span className="font-mono">{account.loginId}</span> — {account.currency} {account.balance.toFixed(2)}</span>
        </div>
      )}

      {/* Risk Profile */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Risk Profile</CardTitle>
          <CardDescription className="text-xs">Core risk configuration applied to all trades.</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingRow label="Profile Preset" description="Affects stake sizing multiplier.">
            <Select value={form.riskProfile} onValueChange={(v) => set("riskProfile", v)}>
              <SelectTrigger className="w-36 bg-secondary/50 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="conservative">Conservative</SelectItem>
                <SelectItem value="moderate">Moderate</SelectItem>
                <SelectItem value="aggressive">Aggressive</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow label="Max Risk Per Trade" description="% of balance to risk per trade.">
            <NumInput value={form.maxRiskPerTrade} onChange={(v) => set("maxRiskPerTrade", v)} min={0.1} max={10} step={0.1} suffix="%" />
          </SettingRow>
          <SettingRow label="Max Stake Per Trade" description="Hard cap per trade regardless of balance.">
            <NumInput value={form.maxTradeStake} onChange={(v) => set("maxTradeStake", v)} min={0.35} max={50000} step={0.5} suffix="$" />
          </SettingRow>
        </CardContent>
      </Card>

      {/* Daily Limits */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Daily Limits</CardTitle>
          <CardDescription className="text-xs">Engine auto-stops when these are hit.</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingRow label="Daily Profit Target" description="Stop once this daily profit is achieved.">
            <NumInput value={form.dailyTarget} onChange={(v) => set("dailyTarget", v)} min={1} max={100000} step={1} suffix="$" />
          </SettingRow>
          <SettingRow label="Daily Loss Limit" description="Stop if total daily loss hits this.">
            <NumInput value={form.dailyLossLimit} onChange={(v) => set("dailyLossLimit", v)} min={1} max={100000} step={1} suffix="$" />
          </SettingRow>
          <SettingRow label="Max Drawdown" description="Stop if portfolio drops by this %.">
            <NumInput value={form.maxDrawdown} onChange={(v) => set("maxDrawdown", v)} min={1} max={50} step={0.5} suffix="%" />
          </SettingRow>
          <SettingRow label="Consecutive Loss Limit" description="Pause after this many losses in a row.">
            <NumInput value={form.consecutiveLossLimit} onChange={(v) => set("consecutiveLossLimit", v)} min={1} max={20} />
          </SettingRow>
        </CardContent>
      </Card>

      {/* Engine Behavior */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Engine Behavior</CardTitle>
          <CardDescription className="text-xs">How the AI scans Deriv markets and executes trades.</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingRow label="Min Confidence Threshold" description="AI must be at least this confident to trade.">
            <NumInput value={form.minConfidenceThreshold} onChange={(v) => set("minConfidenceThreshold", v)} min={40} max={95} step={1} suffix="%" />
          </SettingRow>
          <SettingRow label="Scan Interval" description="Seconds between each autonomous scan.">
            <NumInput value={form.loopIntervalSec} onChange={(v) => set("loopIntervalSec", v)} min={5} max={300} step={5} suffix="s" />
          </SettingRow>
          <SettingRow label="Trade Duration" description="Contract duration in ticks (5t ≈ 5s on 1s synthetics).">
            <NumInput value={form.tradeDurationSec} onChange={(v) => set("tradeDurationSec", v)} min={1} max={10} step={1} suffix="t" />
          </SettingRow>
          <SettingRow label="Market Rotation After" description="Exploit hot market for N trades before rotating.">
            <NumInput value={form.marketRotationAfter} onChange={(v) => set("marketRotationAfter", v)} min={1} max={20} step={1} />
          </SettingRow>
          <SettingRow label="Autonomous Trading" description="Allow AI to execute without manual approval.">
            <Switch checked={form.autonomousEnabled} onCheckedChange={(v) => set("autonomousEnabled", v)} />
          </SettingRow>
          <SettingRow label="Paper Trade Mode" description="Log trades with ML features but do not send live orders to Deriv.">
            <Switch checked={form.paperTradeMode} onCheckedChange={(v) => set("paperTradeMode", v)} />
          </SettingRow>
          <SettingRow label="Require Positive EV" description="Only trade when expected value is positive after Deriv proposal payout.">
            <Switch checked={form.requirePositiveEv} onCheckedChange={(v) => set("requirePositiveEv", v)} />
          </SettingRow>
        </CardContent>
      </Card>

      {/* Recovery Mode */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Recovery Mode</CardTitle>
          <CardDescription className="text-xs">After a loss, the AI switches contract type and calculates a recovery stake to cover the loss.</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingRow label="Enable Recovery Mode" description="AI switches contract type/market and adjusts stake after a loss.">
            <Switch checked={form.recoveryMode} onCheckedChange={(v) => set("recoveryMode", v)} />
          </SettingRow>
          {form.recoveryMode && (
            <>
              <SettingRow label="Recovery Multiplier" description="Fallback multiplier if loss amount is small.">
                <NumInput value={form.recoveryMultiplier} onChange={(v) => set("recoveryMultiplier", Math.min(1.5, Math.max(1.05, v)))} min={1.05} max={1.5} step={0.05} suffix="×" />
              </SettingRow>
              <SettingRow label="Max Recovery Steps" description="Max consecutive recovery attempts before reset.">
                <NumInput value={form.maxRecoverySteps} onChange={(v) => set("maxRecoverySteps", v)} min={1} max={5} step={1} />
              </SettingRow>
              <div className="mt-3 p-3 bg-secondary/30 rounded-lg flex gap-2">
                <Info className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
                <p className="text-xs text-muted-foreground">
                  On a loss: agent switches to an alternative contract type (e.g. OVER→UNDER, RISE→FALL or DIGIT) and calculates a stake that covers the loss + margin. Max: <span className="text-foreground font-mono">{form.recoveryMultiplier}^{form.maxRecoverySteps} = {maxRecovery.toFixed(3)}×</span> base stake.
                  {maxRecovery > 1.5 && <span className="text-amber-400"> Warning: high multiplier — reduce steps or multiplier.</span>}
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Contract Types */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Preferred Contract Types</CardTitle>
          <CardDescription className="text-xs">AI prioritises selected types. Also determines recovery alternatives.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {CONTRACT_TYPES.map((c) => {
              const active = form.preferredContractTypes.includes(c.id);
              return (
                <button
                  key={c.id}
                  onClick={() => toggleContract(c.id)}
                  className={`p-2.5 rounded-lg text-left border transition-colors ${active ? "bg-primary/10 border-primary/40 text-primary" : "bg-secondary/50 border-border text-muted-foreground hover:text-foreground"}`}
                >
                  <div className="font-mono font-bold text-sm">{c.label}</div>
                  <div className="text-[10px] mt-0.5 opacity-70">{c.desc}</div>
                </button>
              );
            })}
          </div>
          <div className="p-3 bg-secondary/20 rounded-lg text-xs text-muted-foreground space-y-0.5">
            <p><strong className="text-foreground">RISE/FALL</strong> — best for synthetic momentum, no barrier needed</p>
            <p><strong className="text-foreground">CALL/PUT</strong> — directional with fixed expiry price comparison</p>
            <p><strong className="text-foreground">OVER/UNDER</strong> — digit analysis; AI picks optimal barrier based on live digit distribution</p>
          </div>
        </CardContent>
      </Card>

      {/* Market Selection */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Market Selection</CardTitle>
          <CardDescription className="text-xs">
            Restrict the engine to specific markets. All 17 are scanned by default.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Quick select */}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={selectAllMarkets}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${isAllMarkets ? "bg-primary/10 border-primary/40 text-primary" : "bg-secondary/50 border-border text-muted-foreground hover:text-foreground"}`}
            >
              All Markets (17)
            </button>
            {MARKET_GROUPS.map(group => {
              const groupSymbols = ALL_MARKETS.filter(m => m.group === group).map(m => m.symbol);
              const isGroupSelected = !isAllMarkets && groupSymbols.every(s => form.allowedMarkets.includes(s)) && form.allowedMarkets.length === groupSymbols.length;
              return (
                <button
                  key={group}
                  onClick={() => selectGroup(group)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${isGroupSelected ? "bg-primary/10 border-primary/40 text-primary" : "bg-secondary/50 border-border text-muted-foreground hover:text-foreground"}`}
                >
                  {group} Only
                </button>
              );
            })}
          </div>

          {!isAllMarkets && (
            <div className="text-xs text-amber-400 flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5 flex-shrink-0" />
              <span>{selectedCount} of {ALL_MARKETS.length} markets selected. Engine scans only these.</span>
            </div>
          )}

          {/* Market grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {MARKET_GROUPS.map(group => (
              <div key={group}>
                <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1 mt-2">{group}</div>
                {ALL_MARKETS.filter(m => m.group === group).map(m => {
                  const isSelected = isAllMarkets || form.allowedMarkets.includes(m.symbol);
                  return (
                    <button
                      key={m.symbol}
                      onClick={() => toggleMarket(m.symbol)}
                      className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-left transition-colors mb-0.5 border ${
                        isSelected
                          ? "bg-green-500/5 border-green-500/20 text-green-400"
                          : "bg-secondary/30 border-transparent text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <span className="text-xs font-medium">{m.label}</span>
                      <span className="text-[10px] font-mono opacity-50">{m.symbol}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end pt-2">
        <Button onClick={handleSave} disabled={updateSettings.isPending} className="w-full sm:w-48">
          {updateSettings.isPending ? "Saving…" : "Save All Settings"}
        </Button>
      </div>
    </motion.div>
  );
}
