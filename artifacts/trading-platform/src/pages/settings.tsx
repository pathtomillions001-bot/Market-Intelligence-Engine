import { useGetSettings, useUpdateSettings, useGetAccount } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { motion } from "framer-motion";
import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Info, TrendingUp, TrendingDown, Hash, Equal, Shuffle } from "lucide-react";

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

function NumInput({ value, onChange, min, max, step = 1, suffix, disabled }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; suffix?: string; disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="number" value={value} min={min} max={max} step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
        className="w-24 text-right font-mono text-sm bg-secondary/50 disabled:opacity-40"
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
    desc: "Tick-to-tick momentum. Price ends higher (Rise = CALL) or lower (Fall = PUT) than entry at contract expiry.",
    types: ["CALL", "PUT"],
    color: "indigo",
  },
  {
    id: "overUnder",
    label: "Over & Under (Digits)",
    icon: <Hash className="w-4 h-4" />,
    desc: "Last digit of price. AI picks optimal barrier from live digit analysis.",
    types: ["DIGITOVER", "DIGITUNDER"],
    color: "emerald",
  },
  {
    id: "evenOdd",
    label: "Even & Odd (Digits)",
    icon: <TrendingDown className="w-4 h-4" />,
    desc: "Last digit parity. AI analyses digit frequency, chi-square bias and streak patterns to find edge.",
    types: ["DIGITEVEN", "DIGITODD"],
    color: "violet",
  },
  {
    id: "matchDiff",
    label: "Matches & Differs (Digits)",
    icon: <Equal className="w-4 h-4" />,
    desc: "Predict whether the last digit will match (MATCH) or differ from (DIFF) a specific digit. AI picks the hottest digit to match and coldest digit to differ from for positive EV.",
    types: ["DIGITMATCH", "DIGITDIFF"],
    color: "rose",
  },
];

export default function Settings() {
  const { data: settings, isLoading } = useGetSettings();
  const { data: account } = useGetAccount();
  const updateSettings = useUpdateSettings();
  const queryClient = useQueryClient();

  const [form, setForm] = useState({
    riskProfile: "moderate" as "conservative" | "moderate" | "aggressive",
    maxRiskPerTrade: 2,
    dailyTarget: 50,
    dailyLossLimit: 30,
    maxDrawdown: 10,
    consecutiveLossLimit: 3,
    cooldownMinutes: 30,
    marketRotationAfter: 5,
    tradeDurationSec: 5,
    maxTradeStake: 500,
    autonomousEnabled: false,
    recoveryMode: false,
    recoveryMethod: "split" as "split" | "instant",
    recoveryMultiplier: 1.5,
    maxRecoverySteps: 3,
    normalOverDigit: 2,
    normalUnderDigit: 7,
    recoveryOverDigit: 4,
    recoveryUnderDigit: 5,
    scanAllMarkets: true,
    paperTradeMode: false,
    requirePositiveEv: true,
    preferredContractTypes: ["CALL", "PUT", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD"],
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
        cooldownMinutes: (settings as any).cooldownMinutes ?? 30,
        marketRotationAfter: settings.marketRotationAfter,
        tradeDurationSec: (settings as any).tradeDurationSec ?? 5,
        maxTradeStake: (settings as any).maxTradeStake ?? 500,
        autonomousEnabled: settings.autonomousEnabled,
        recoveryMode: (settings as any).recoveryMode ?? false,
        recoveryMethod: ((settings as any).recoveryMethod ?? "split") as "split" | "instant",
        recoveryMultiplier: (settings as any).recoveryMultiplier ?? 1.5,
        maxRecoverySteps: (settings as any).maxRecoverySteps ?? 3,
        normalOverDigit: (settings as any).normalOverDigit ?? 2,
        normalUnderDigit: (settings as any).normalUnderDigit ?? 7,
        recoveryOverDigit: (settings as any).recoveryOverDigit ?? 4,
        recoveryUnderDigit: (settings as any).recoveryUnderDigit ?? 5,
        scanAllMarkets: (settings as any).scanAllMarkets ?? true,
        paperTradeMode: (settings as any).paperTradeMode ?? false,
        requirePositiveEv: (settings as any).requirePositiveEv ?? true,
        preferredContractTypes: settings.preferredContractTypes.length > 0
          ? settings.preferredContractTypes.map((t: string) => t === "RISE" ? "CALL" : t === "FALL" ? "PUT" : t).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i)
          : ["CALL", "PUT", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD", "DIGITMATCH", "DIGITDIFF"],
        preferredCategories: (settings as any).preferredCategories?.length > 0
          ? (settings as any).preferredCategories
          : ["synthetic"],
        allowedMarkets: (settings as any).allowedMarkets ?? [],
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
    updateSettings.mutate({ data: { ...form } as any }, {
      onSuccess: (saved: any) => {
        // Update settings cache directly so the toggles reflect immediately
        queryClient.setQueryData(["getSettings"], saved);
        queryClient.setQueryData(["settings"], saved);
        // Invalidate all data that depends on settings (contract types, market rankings, etc.)
        // The server will also broadcast SSE "settings_updated" to all open tabs/dashboard
        queryClient.invalidateQueries({ queryKey: ["getSettings"] });
        queryClient.invalidateQueries({ queryKey: ["markets-top-signals"] });
        queryClient.invalidateQueries({ queryKey: ["markets", "ranked-all"] });
        queryClient.invalidateQueries({ queryKey: ["/api/markets/top"] });
        queryClient.invalidateQueries({ queryKey: ["getAiEngineStatus"] });
        toast.success("Settings saved — engine and market data updated");
      },
      onError: (err: any) => {
        const msg = err?.data?.error || err?.message || "Failed to save settings";
        toast.error(msg);
      },
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
          <SettingRow label="Cooldown Duration" description="Minutes before engine auto-resumes after a consecutive-loss stop.">
            <NumInput value={form.cooldownMinutes} onChange={(v) => set("cooldownMinutes", v)} min={1} max={1440} step={5} suffix="min" />
          </SettingRow>
        </CardContent>
      </Card>

      {/* Recovery Mode */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Recovery Mode</CardTitle>
          <CardDescription className="text-xs">
            When enabled, after a loss the engine escalates stake size to recover the lost amount. Recovery is tracked as a single global state — it does not reset to normal until a win fully covers the accumulated unrecovered amount; partial wins leave the remainder active.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SettingRow label="Enable Recovery Mode" description="Automatically increase stake after a loss to recover.">
            <Switch checked={form.recoveryMode} onCheckedChange={(v) => set("recoveryMode", v)} />
          </SettingRow>
          <SettingRow
            label="Recovery Method"
            description="Split: stake is capped at Multiplier × base stake per trade — recovery spreads across multiple wins. Instant: AI uses the minimum stake needed to recover the full loss in the next single winning trade."
          >
            <Select value={form.recoveryMethod} onValueChange={(v) => set("recoveryMethod", v)}>
              <SelectTrigger className="w-36 bg-secondary/50 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="split">Split</SelectItem>
                <SelectItem value="instant">Instant</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow
            label="Recovery Multiplier"
            description={form.recoveryMethod === "instant"
              ? "Not used in Instant mode — AI sizes the stake to recover the exact lost amount."
              : `Split mode cap: recovery stake will not exceed this multiple of the original base stake (e.g. 1.5 = max 1.5× base).`}
          >
            <NumInput value={form.recoveryMultiplier} onChange={(v) => set("recoveryMultiplier", v)} min={1.1} max={5} step={0.05} suffix="×" disabled={form.recoveryMethod === "instant"} />
          </SettingRow>
          <SettingRow
            label="Max Recovery Steps"
            description="Maximum number of consecutive stake escalations. Stakes cap here and won't increase further."
          >
            <NumInput value={form.maxRecoverySteps} onChange={(v) => set("maxRecoverySteps", v)} min={1} max={10} />
          </SettingRow>
          {form.recoveryMode && (
            <div className="mt-3 p-3 bg-amber-500/5 border border-amber-500/20 rounded-lg">
              <div className="text-xs font-medium text-amber-400 mb-2">Recovery stake escalation preview</div>
              <div className="flex gap-2 flex-wrap">
                {Array.from({ length: form.maxRecoverySteps }, (_, i) => i + 1).map((step) => (
                  <div key={step} className="text-center">
                    <div className="text-[10px] text-muted-foreground">Step {step}</div>
                    <div className="text-xs font-mono font-bold text-amber-400">
                      ×{Math.pow(form.recoveryMultiplier, step).toFixed(2)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Over/Under Digit Configuration */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Over/Under Digits</CardTitle>
          <CardDescription className="text-xs">
            The AI only ever trades these exact digit barriers — one pair for normal trading, one pair while recovery is active. No other digits are scanned or selected automatically.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SettingRow label="Normal — OVER digit" description="Barrier used for DIGITOVER trades outside of recovery.">
            <NumInput value={form.normalOverDigit} onChange={(v) => set("normalOverDigit", v)} min={0} max={9} />
          </SettingRow>
          <SettingRow label="Normal — UNDER digit" description="Barrier used for DIGITUNDER trades outside of recovery.">
            <NumInput value={form.normalUnderDigit} onChange={(v) => set("normalUnderDigit", v)} min={0} max={9} />
          </SettingRow>
          <SettingRow label="Recovery — OVER digit" description="Barrier used for DIGITOVER trades while recovery is active.">
            <NumInput value={form.recoveryOverDigit} onChange={(v) => set("recoveryOverDigit", v)} min={0} max={9} />
          </SettingRow>
          <SettingRow label="Recovery — UNDER digit" description="Barrier used for DIGITUNDER trades while recovery is active.">
            <NumInput value={form.recoveryUnderDigit} onChange={(v) => set("recoveryUnderDigit", v)} min={0} max={9} />
          </SettingRow>
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

      <div className="flex justify-end pt-2">
        <Button onClick={handleSave} disabled={updateSettings.isPending} className="w-full sm:w-48">
          {updateSettings.isPending ? "Saving…" : "Save All Settings"}
        </Button>
      </div>
    </motion.div>
  );
}
