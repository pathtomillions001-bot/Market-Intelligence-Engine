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
import { Info, TrendingUp, TrendingDown, Hash } from "lucide-react";

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

// Contract type groups — what the AI engine trades
const CONTRACT_GROUPS = [
  {
    id: "riseFall",
    label: "Rise & Fall",
    icon: <TrendingUp className="w-4 h-4" />,
    desc: "Tick-to-tick momentum. Price rises or falls from entry.",
    types: ["RISE", "FALL"],
    color: "indigo",
  },
  {
    id: "putCall",
    label: "Put & Call",
    icon: <TrendingDown className="w-4 h-4" />,
    desc: "Direction at expiry. Higher or lower than entry at contract end.",
    types: ["CALL", "PUT"],
    color: "violet",
  },
  {
    id: "overUnder",
    label: "Over & Under (Digits)",
    icon: <Hash className="w-4 h-4" />,
    desc: "Last digit of price. AI picks optimal barrier from live digit analysis.",
    types: ["DIGITOVER", "DIGITUNDER"],
    color: "emerald",
  },
];

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
    marketRotationAfter: 5,
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
        marketRotationAfter: settings.marketRotationAfter,
        tradeDurationSec: (settings as any).tradeDurationSec ?? 5,
        maxTradeStake: (settings as any).maxTradeStake ?? 500,
        autonomousEnabled: settings.autonomousEnabled,
        recoveryMode: (settings as any).recoveryMode ?? false,
        recoveryMultiplier: (settings as any).recoveryMultiplier ?? 1.2,
        maxRecoverySteps: (settings as any).maxRecoverySteps ?? 3,
        scanAllMarkets: (settings as any).scanAllMarkets ?? true,
        paperTradeMode: (settings as any).paperTradeMode ?? false,
        requirePositiveEv: (settings as any).requirePositiveEv ?? true,
        preferredContractTypes: settings.preferredContractTypes.length > 0
          ? settings.preferredContractTypes
          : ["RISE", "FALL", "CALL", "PUT", "DIGITOVER", "DIGITUNDER"],
        preferredCategories: ["synthetic"],
        allowedMarkets: [],
      });
    }
  }, [settings]);

  const set = (key: string, val: unknown) => setForm((prev) => ({ ...prev, [key]: val }));

  // Toggle entire contract group
  const toggleGroup = (types: string[]) => {
    setForm((prev) => {
      const allActive = types.every(t => prev.preferredContractTypes.includes(t));
      if (allActive) {
        // Deactivate group — but don't allow empty
        const next = prev.preferredContractTypes.filter(t => !types.includes(t));
        return { ...prev, preferredContractTypes: next.length > 0 ? next : prev.preferredContractTypes };
      } else {
        return {
          ...prev,
          preferredContractTypes: [...new Set([...prev.preferredContractTypes, ...types])],
        };
      }
    });
  };

  const handleSave = () => {
    updateSettings.mutate({ data: { ...form, preferredCategories: ["synthetic"], allowedMarkets: [] } as any }, {
      onSuccess: () => toast.success("Settings saved"),
      onError: (err: any) => toast.error(err?.error || "Failed to save settings"),
    });
  };

  if (isLoading) return <div className="p-8 text-muted-foreground text-sm animate-pulse">Loading settings…</div>;

  const maxRecovery = Math.pow(form.recoveryMultiplier, form.maxRecoverySteps);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 md:p-8 max-w-3xl mx-auto space-y-5 pb-24">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-1 text-sm">The AI engine learns autonomously — configure risk and trade mode only.</p>
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
          <CardDescription className="text-xs">The AI scans all markets in milliseconds from live tick buffers. Confidence and scan speed are self-managed.</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingRow label="Trade Duration" description="Contract duration in ticks (5t ≈ 5s on 1s synthetics).">
            <NumInput value={form.tradeDurationSec} onChange={(v) => set("tradeDurationSec", v)} min={1} max={10} step={1} suffix="t" />
          </SettingRow>
          <SettingRow label="Market Rotation After" description="Exploit hot market for N trades before rotating.">
            <NumInput value={form.marketRotationAfter} onChange={(v) => set("marketRotationAfter", v)} min={1} max={20} step={1} />
          </SettingRow>
          <SettingRow label="Paper Trade Mode" description="Log trades with ML features but do not send live orders to Deriv.">
            <Switch checked={form.paperTradeMode} onCheckedChange={(v) => set("paperTradeMode", v)} />
          </SettingRow>
          <div className="pt-2 pb-1 flex gap-2 text-xs text-muted-foreground bg-secondary/20 rounded-lg px-3 py-2">
            <Info className="w-3.5 h-3.5 text-primary flex-shrink-0 mt-0.5" />
            <span>The AI engine scans all 17 markets every 2–3 seconds from live tick buffers. Confidence thresholds, scan intervals, and trade timing are determined autonomously by the ML ensemble — not user settings.</span>
          </div>
        </CardContent>
      </Card>

      {/* AI Engine Contract Mode */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">AI Engine Contract Mode</CardTitle>
          <CardDescription className="text-xs">
            Choose which contract types the engine trades. The AI picks the best market and optimal parameters for each selected type — no manual barriers or directions needed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-3">
            {CONTRACT_GROUPS.map((group) => {
              const active = group.types.every(t => form.preferredContractTypes.includes(t));
              const partial = !active && group.types.some(t => form.preferredContractTypes.includes(t));
              return (
                <button
                  key={group.id}
                  onClick={() => toggleGroup(group.types)}
                  className={`w-full flex items-start gap-3 p-4 rounded-xl text-left border transition-all ${
                    active
                      ? "bg-primary/10 border-primary/40"
                      : partial
                      ? "bg-amber-500/5 border-amber-500/30"
                      : "bg-secondary/30 border-border hover:border-border/80"
                  }`}
                >
                  <div className={`p-2 rounded-lg mt-0.5 ${active ? "bg-primary/20 text-primary" : "bg-secondary text-muted-foreground"}`}>
                    {group.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`font-semibold text-sm ${active ? "text-primary" : "text-foreground"}`}>{group.label}</span>
                      {active && <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/20 text-primary font-medium">Active</span>}
                      {partial && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 font-medium">Partial</span>}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{group.desc}</p>
                    <div className="flex gap-1.5 mt-2">
                      {group.types.map(t => (
                        <span key={t} className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${form.preferredContractTypes.includes(t) ? "bg-primary/10 border-primary/30 text-primary" : "bg-secondary border-border text-muted-foreground"}`}>{t.replace("DIGIT", "").replace("OVER", "OVER").replace("UNDER", "UNDER")}</span>
                      ))}
                    </div>
                  </div>
                  <div className={`w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center mt-1 ${active ? "bg-primary border-primary" : "border-border"}`}>
                    {active && <div className="w-2 h-2 rounded-full bg-white" />}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="p-3 bg-secondary/20 rounded-lg text-xs text-muted-foreground space-y-1">
            <p><strong className="text-foreground">All selected (recommended)</strong> — AI picks the best contract type for each opportunity across all categories</p>
            <p><strong className="text-foreground">Selective mode</strong> — restricts the engine to your chosen contract categories only</p>
            <p><strong className="text-foreground">OVER/UNDER</strong> — AI analyses live digit distribution per tick and selects the most favourable barrier automatically</p>
          </div>
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
                  On a loss: agent switches contract type (OVER→UNDER, RISE→FALL, etc.) and calculates a stake that covers the loss + margin. Max: <span className="text-foreground font-mono">{form.recoveryMultiplier}^{form.maxRecoverySteps} = {maxRecovery.toFixed(3)}×</span> base stake.
                  {maxRecovery > 1.5 && <span className="text-amber-400"> Warning: high multiplier.</span>}
                </p>
              </div>
            </>
          )}
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
