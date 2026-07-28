import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { X, Zap, TrendingUp, TrendingDown, Hash, Equal, ChevronRight, Loader2, StopCircle, BarChart2 } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { useGetSettings } from "@workspace/api-client-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type ContractFamily = "overUnder" | "riseFall" | "evenOdd" | "matchDiff";
type RecoveryMethod = "split" | "instant";

interface SpeedConfig {
  normalFamily: ContractFamily;
  normalOverBarrier: number;
  normalUnderBarrier: number;
  recoveryFamily: ContractFamily;
  recoveryOverBarrier: number;
  recoveryUnderBarrier: number;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  recoveryMultiplier: number;
  recoveryMethod: RecoveryMethod;
  maxRecoverySteps: number;
}

interface SessionStatus {
  running: boolean;
  sessionId: string | null;
  totalProfit: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  currentStake: number;
  inRecovery: boolean;
  recoveryStep: number;
  unrecoveredAmount: number;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  message?: string;
  config?: {
    stake: number;
    stopLoss: number;
    takeProfit: number;
    recoveryMultiplier: number;
    recoveryMethod: string;
    maxRecoverySteps: number;
    normalContractTypes: string[];
    recoveryContractTypes: string[];
    normalBarriers: number[];
    recoveryBarriers: number[];
  };
  topMarkets?: Array<{
    symbol: string; displayName: string; contractType: string;
    barrier?: number; score: number; winProbability: number; reason: string;
  }>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const FAMILIES: { id: ContractFamily; label: string; icon: React.ReactNode; desc: string }[] = [
  { id: "overUnder", label: "Over & Under", icon: <Hash className="w-3.5 h-3.5" />, desc: "Digit barrier trades" },
  { id: "riseFall",  label: "Rise & Fall",  icon: <TrendingUp className="w-3.5 h-3.5" />, desc: "Price direction trades" },
  { id: "evenOdd",   label: "Even & Odd",   icon: <Equal className="w-3.5 h-3.5" />, desc: "Digit parity trades" },
  { id: "matchDiff", label: "Match & Differ", icon: <BarChart2 className="w-3.5 h-3.5" />, desc: "Digit prediction trades" },
];

const DIGIT_PAYOUTS_OVER: Record<number, number> = {
  0: 1.04, 1: 1.08, 2: 1.19, 3: 1.37, 4: 1.63, 5: 1.96, 6: 2.45, 7: 3.27, 8: 4.90,
};

function autoMultiplier(barrier: number, contractType: "over" | "under") {
  const payout = contractType === "over"
    ? (DIGIT_PAYOUTS_OVER[barrier] ?? 1.63)
    : (DIGIT_PAYOUTS_OVER[9 - barrier] ?? 1.63);
  const netPayout = payout - 1;
  if (netPayout <= 0) return 9.0;
  return Math.round((1 / netPayout) * 1.02 * 100) / 100;
}

// Map family → contract types sent to API
function familyToContracts(family: ContractFamily, overB: number, underB: number, isRecovery = false) {
  switch (family) {
    case "overUnder":
      return {
        types:    ["DIGITOVER", "DIGITUNDER"],
        barriers: isRecovery ? [overB, underB] : [overB, underB],
      };
    case "riseFall":
      return { types: ["CALL", "PUT"], barriers: [] };
    case "evenOdd":
      return { types: ["DIGITEVEN", "DIGITODD"], barriers: [] };
    case "matchDiff":
      return { types: ["DIGITMATCH", "DIGITDIFF"], barriers: [] };
  }
}

// ── NumInput helper ──────────────────────────────────────────────────────────

function NumInput({ label, value, onChange, min, max, step = 1, suffix }: {
  label: string; value: number; onChange: (v: number) => void;
  min?: number; max?: number; step?: number; suffix?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground flex-1">{label}</span>
      <div className="flex items-center gap-1">
        <Input
          type="number" value={value} min={min} max={max} step={step}
          onChange={e => onChange(Number(e.target.value))}
          className="w-20 h-7 text-right font-mono text-xs bg-black/30 border-white/10 focus:border-cyan-500/50"
        />
        {suffix && <span className="text-[10px] text-muted-foreground w-6">{suffix}</span>}
      </div>
    </div>
  );
}

// ── Family selector ──────────────────────────────────────────────────────────

function FamilySelector({ label, value, onChange, showBarriers, overBarrier, underBarrier, onOverBarrier, onUnderBarrier }: {
  label: string;
  value: ContractFamily;
  onChange: (v: ContractFamily) => void;
  showBarriers: boolean;
  overBarrier: number;
  underBarrier: number;
  onOverBarrier: (v: number) => void;
  onUnderBarrier: (v: number) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</p>
      <div className="grid grid-cols-2 gap-1.5">
        {FAMILIES.map(f => (
          <button
            key={f.id}
            onClick={() => onChange(f.id)}
            className={`flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-left text-xs border transition-all ${
              value === f.id
                ? "bg-cyan-500/15 border-cyan-500/50 text-cyan-300"
                : "bg-white/5 border-white/10 text-muted-foreground hover:border-white/20"
            }`}
          >
            <span className={value === f.id ? "text-cyan-400" : "text-muted-foreground"}>{f.icon}</span>
            <span className="font-medium truncate">{f.label}</span>
          </button>
        ))}
      </div>
      {showBarriers && value === "overUnder" && (
        <div className="grid grid-cols-2 gap-2 pt-1">
          <div>
            <p className="text-[10px] text-muted-foreground mb-1">OVER barrier</p>
            <Select value={String(overBarrier)} onValueChange={v => onOverBarrier(Number(v))}>
              <SelectTrigger className="h-7 text-xs bg-black/30 border-white/10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[0,1,2,3,4,5,6,7,8].map(b => (
                  <SelectItem key={b} value={String(b)}>OVER {b} ({(100*(9-b)/10).toFixed(0)}%)</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground mb-1">UNDER barrier</p>
            <Select value={String(underBarrier)} onValueChange={v => onUnderBarrier(Number(v))}>
              <SelectTrigger className="h-7 text-xs bg-black/30 border-white/10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[1,2,3,4,5,6,7,8,9].map(b => (
                  <SelectItem key={b} value={String(b)}>UNDER {b} ({(100*b/10).toFixed(0)}%)</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function SpeedAIFab() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"config" | "running">("config");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const { data: settings } = useGetSettings();

  const [config, setConfig] = useState<SpeedConfig>({
    normalFamily: "overUnder",
    normalOverBarrier: 1,
    normalUnderBarrier: 8,
    recoveryFamily: "overUnder",
    recoveryOverBarrier: 4,
    recoveryUnderBarrier: 5,
    stake: 1,
    stopLoss: 5,
    takeProfit: 10,
    recoveryMultiplier: 1.62,
    recoveryMethod: "split",
    maxRecoverySteps: 3,
  });

  const set = <K extends keyof SpeedConfig>(k: K, v: SpeedConfig[K]) =>
    setConfig(prev => ({ ...prev, [k]: v }));

  // Sync defaults from settings
  useEffect(() => {
    if (settings) {
      const s = settings as any;
      setConfig(prev => ({
        ...prev,
        normalOverBarrier:   s.normalOverDigit  ?? prev.normalOverBarrier,
        normalUnderBarrier:  s.normalUnderDigit ?? prev.normalUnderBarrier,
        recoveryOverBarrier: s.recoveryOverDigit  ?? prev.recoveryOverBarrier,
        recoveryUnderBarrier:s.recoveryUnderDigit ?? prev.recoveryUnderBarrier,
        recoveryMultiplier:  s.recoveryMultiplier ?? prev.recoveryMultiplier,
        recoveryMethod:      (s.recoveryMethod ?? prev.recoveryMethod) as RecoveryMethod,
        maxRecoverySteps:    s.maxRecoverySteps ?? prev.maxRecoverySteps,
        stake:               s.riskAmountValue ?? prev.stake,
      }));
    }
  }, [settings]);

  // Poll session status
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/speed-ai/status");
      if (res.ok) {
        const data: SessionStatus = await res.json();
        setStatus(data);
        if (data.running) setStep("running");
        else if (step === "running" && !data.running) {
          // Session ended naturally
          setStep("running"); // Stay on running to show final stats
        }
      }
    } catch { /* ignore */ }
  }, [step]);

  useEffect(() => {
    if (open) {
      fetchStatus();
      pollRef.current = setInterval(fetchStatus, 1000);
    } else {
      if (pollRef.current) clearInterval(pollRef.current);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [open, fetchStatus]);

  // Also listen to SSE
  useEffect(() => {
    const handler = (e: Event) => {
      try {
        const data = JSON.parse((e as CustomEvent).detail ?? "{}");
        if (data.type === "speed_ai_update" && data.data) {
          setStatus(data.data as SessionStatus);
          if ((data.data as SessionStatus).running) setStep("running");
        }
      } catch { /* ignore */ }
    };
    window.addEventListener("sse_event", handler);
    return () => window.removeEventListener("sse_event", handler);
  }, []);

  const handleStart = async () => {
    setLoading(true);
    try {
      const normalContracts = familyToContracts(config.normalFamily, config.normalOverBarrier, config.normalUnderBarrier);
      const recoveryContracts = familyToContracts(config.recoveryFamily, config.recoveryOverBarrier, config.recoveryUnderBarrier, true);

      const body = {
        normalContractTypes:   normalContracts.types,
        normalBarriers:        normalContracts.barriers,
        recoveryContractTypes: recoveryContracts.types,
        recoveryBarriers:      recoveryContracts.barriers,
        stake:                 config.stake,
        stopLoss:              config.stopLoss,
        takeProfit:            config.takeProfit,
        recoveryMultiplier:    config.recoveryMultiplier,
        recoveryMethod:        config.recoveryMethod,
        maxRecoverySteps:      config.maxRecoverySteps,
      };

      const res = await fetch("/api/speed-ai/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Failed to start SpeedAI");
        return;
      }
      setStatus(data.status);
      setStep("running");
      toast.success("⚡ SpeedAI Engine activated!");
    } catch (err) {
      toast.error("Could not start SpeedAI session");
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/speed-ai/stop", { method: "POST" });
      const data = await res.json();
      setStatus(data.status);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    setStep("config");
    setStatus(null);
  };

  const isRunning = status?.running ?? false;
  const profitColor = (status?.totalProfit ?? 0) >= 0 ? "text-green-400" : "text-red-400";
  const winRate = status && status.tradeCount > 0
    ? Math.round((status.winCount / status.tradeCount) * 100) : 0;

  const suggestedMult = config.normalFamily === "overUnder"
    ? autoMultiplier(config.recoveryOverBarrier, "over")
    : config.recoveryMultiplier;

  return (
    <>
      {/* Panel */}
      <AnimatePresence>
        {open && (
          <>
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/40 z-40"
              onClick={() => setOpen(false)}
            />

            {/* Panel */}
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 20, scale: 0.97 }}
              transition={{ type: "spring", stiffness: 400, damping: 35 }}
              className="fixed bottom-20 right-4 z-50 w-80 max-h-[calc(100vh-6rem)] overflow-y-auto rounded-2xl border border-cyan-500/20 bg-[#0a0f1a] shadow-2xl shadow-cyan-900/20"
            >
              {/* Header */}
              <div className="sticky top-0 bg-[#0a0f1a] flex items-center justify-between px-4 py-3 border-b border-white/5">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center">
                    <Zap className="w-3.5 h-3.5 text-white" />
                  </div>
                  <div>
                    <p className="text-xs font-bold text-white tracking-wide">SPEED AI</p>
                    <p className="text-[9px] text-cyan-400/70 uppercase tracking-widest">1-Tick Engine</p>
                  </div>
                </div>
                <button onClick={() => setOpen(false)} className="p-1 rounded-md text-muted-foreground hover:text-white">
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Config step */}
              {step === "config" && (
                <div className="p-4 space-y-5">
                  {/* Normal contract */}
                  <FamilySelector
                    label="Normal trade type"
                    value={config.normalFamily}
                    onChange={v => set("normalFamily", v)}
                    showBarriers
                    overBarrier={config.normalOverBarrier}
                    underBarrier={config.normalUnderBarrier}
                    onOverBarrier={v => set("normalOverBarrier", v)}
                    onUnderBarrier={v => set("normalUnderBarrier", v)}
                  />

                  {/* Recovery contract */}
                  <FamilySelector
                    label="Recovery trade type"
                    value={config.recoveryFamily}
                    onChange={v => set("recoveryFamily", v)}
                    showBarriers
                    overBarrier={config.recoveryOverBarrier}
                    underBarrier={config.recoveryUnderBarrier}
                    onOverBarrier={v => set("recoveryOverBarrier", v)}
                    onUnderBarrier={v => set("recoveryUnderBarrier", v)}
                  />

                  {/* Risk settings */}
                  <div className="space-y-2 pt-1">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Risk Settings</p>
                    <div className="space-y-2 bg-white/3 rounded-xl p-3 border border-white/5">
                      <NumInput label="Stake per trade" value={config.stake} onChange={v => set("stake", v)} min={0.35} step={0.5} suffix="$" />
                      <NumInput label="Stop loss" value={config.stopLoss} onChange={v => set("stopLoss", v)} min={0.5} step={1} suffix="$" />
                      <NumInput label="Take profit" value={config.takeProfit} onChange={v => set("takeProfit", v)} min={0.5} step={1} suffix="$" />
                    </div>
                  </div>

                  {/* Recovery settings */}
                  <div className="space-y-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Recovery Settings</p>
                    <div className="space-y-2 bg-white/3 rounded-xl p-3 border border-white/5">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs text-muted-foreground flex-1">Method</span>
                        <Select value={config.recoveryMethod} onValueChange={v => set("recoveryMethod", v as RecoveryMethod)}>
                          <SelectTrigger className="h-7 w-24 text-xs bg-black/30 border-white/10">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="split">Split</SelectItem>
                            <SelectItem value="instant">Instant</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground flex-1">Multiplier</span>
                        <div className="flex items-center gap-1">
                          <Input
                            type="number" value={config.recoveryMultiplier} min={1.01} max={20} step={0.01}
                            onChange={e => set("recoveryMultiplier", Number(e.target.value))}
                            disabled={config.recoveryMethod === "instant"}
                            className="w-20 h-7 text-right font-mono text-xs bg-black/30 border-white/10"
                          />
                          <span className="text-[10px] text-muted-foreground">×</span>
                          {config.recoveryMethod === "split" && Math.abs(suggestedMult - config.recoveryMultiplier) > 0.01 && (
                            <button
                              onClick={() => set("recoveryMultiplier", suggestedMult)}
                              className="text-[9px] px-1.5 py-1 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-500/20 whitespace-nowrap font-medium"
                            >
                              Auto {suggestedMult}×
                            </button>
                          )}
                        </div>
                      </div>
                      <NumInput label="Max steps" value={config.maxRecoverySteps} onChange={v => set("maxRecoverySteps", v)} min={1} max={10} />
                    </div>
                  </div>

                  {/* Start button */}
                  <Button
                    onClick={handleStart}
                    disabled={loading}
                    className="w-full h-10 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold text-sm shadow-lg shadow-cyan-900/40"
                  >
                    {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Zap className="w-4 h-4 mr-2" />}
                    Run SpeedAI
                  </Button>
                </div>
              )}

              {/* Running / results step */}
              {step === "running" && (
                <div className="p-4 space-y-4">
                  {/* P&L card */}
                  <div className={`rounded-xl p-3 border ${isRunning ? "bg-cyan-500/5 border-cyan-500/20" : "bg-secondary/30 border-border"}`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Session P&L</span>
                      {isRunning && (
                        <span className="flex items-center gap-1 text-[10px] text-cyan-400">
                          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                          LIVE
                        </span>
                      )}
                      {!isRunning && <span className="text-[10px] text-muted-foreground">STOPPED</span>}
                    </div>
                    <div className={`text-2xl font-bold font-mono ${profitColor}`}>
                      {(status?.totalProfit ?? 0) >= 0 ? "+" : ""}${Math.abs(status?.totalProfit ?? 0).toFixed(2)}
                    </div>
                    <div className="flex gap-3 mt-2 text-[11px]">
                      <span className="text-green-400">{status?.winCount ?? 0}W</span>
                      <span className="text-red-400">{status?.lossCount ?? 0}L</span>
                      <span className="text-muted-foreground">{winRate}% WR</span>
                      <span className="text-muted-foreground">{status?.tradeCount ?? 0} trades</span>
                    </div>
                    {/* TP/SL progress bar */}
                    {status && (
                      <div className="mt-2 space-y-1">
                        <div className="flex justify-between text-[9px] text-muted-foreground">
                          <span>SL -${status.config?.stopLoss.toFixed(2)}</span>
                          <span>TP +${status.config?.takeProfit.toFixed(2)}</span>
                        </div>
                        <div className="h-1.5 bg-secondary rounded-full overflow-hidden relative">
                          {/* Center line */}
                          <div className="absolute left-1/2 top-0 w-px h-full bg-white/20" />
                          {/* Profit fill */}
                          {status.config && (
                            <div
                              className={`absolute top-0 h-full rounded-full transition-all ${status.totalProfit >= 0 ? "bg-green-500 left-1/2" : "bg-red-500 right-1/2"}`}
                              style={{
                                width: `${Math.min(50, Math.abs(status.totalProfit) / (status.totalProfit >= 0 ? status.config.takeProfit : status.config.stopLoss) * 50)}%`,
                              }}
                            />
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Status message */}
                  {status?.message && (
                    <div className={`text-xs px-3 py-2 rounded-lg border ${
                      status.message.startsWith("✅") ? "bg-green-500/10 border-green-500/20 text-green-400" :
                      status.message.startsWith("🛑") ? "bg-red-500/10 border-red-500/20 text-red-400" :
                      status.message.startsWith("⚠️") ? "bg-amber-500/10 border-amber-500/20 text-amber-400" :
                      "bg-secondary/30 border-border text-muted-foreground"
                    }`}>
                      {status.message}
                    </div>
                  )}

                  {/* Current trade */}
                  {isRunning && status?.currentMarket && (
                    <div className="flex items-center gap-2 bg-white/3 rounded-lg px-3 py-2 border border-white/5">
                      <Loader2 className="w-3 h-3 text-cyan-400 animate-spin flex-shrink-0" />
                      <div className="min-w-0">
                        <p className="text-[10px] text-muted-foreground">Trading now</p>
                        <p className="text-xs font-medium truncate">{status.currentMarket}</p>
                        <p className="text-[10px] font-mono text-cyan-400">{status.currentContractType} · ${status.currentStake.toFixed(2)}</p>
                      </div>
                      {status.lastResult && (
                        <span className={`ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded ${status.lastResult === "won" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                          {status.lastResult.toUpperCase()}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Recovery indicator */}
                  {status?.inRecovery && (
                    <div className="flex items-center gap-2 bg-amber-500/5 rounded-lg px-3 py-2 border border-amber-500/20 text-xs">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" />
                      <span className="text-amber-400">Recovery step {status.recoveryStep} · ${status.unrecoveredAmount.toFixed(2)} to recover</span>
                    </div>
                  )}

                  {/* Top markets */}
                  {status?.topMarkets && status.topMarkets.length > 0 && (
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 font-semibold">Top Markets</p>
                      <div className="space-y-1">
                        {status.topMarkets.slice(0, 4).map((m, i) => (
                          <div key={i} className="flex items-center gap-2 text-[11px]">
                            <span className="text-muted-foreground w-3">{i + 1}</span>
                            <span className="flex-1 truncate">{m.displayName}</span>
                            <span className="font-mono text-cyan-400 text-[10px]">{m.contractType}{m.barrier !== undefined ? ` ${m.barrier}` : ""}</span>
                            <span className="font-mono font-bold" style={{ color: `hsl(${m.score * 1.2}, 70%, 55%)` }}>{m.score.toFixed(0)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Controls */}
                  <div className="flex gap-2">
                    {isRunning ? (
                      <Button
                        onClick={handleStop}
                        disabled={loading}
                        variant="destructive"
                        className="flex-1 h-9 text-xs"
                      >
                        <StopCircle className="w-3.5 h-3.5 mr-1.5" />
                        Stop Engine
                      </Button>
                    ) : (
                      <>
                        <Button onClick={handleReset} variant="outline" className="flex-1 h-9 text-xs border-white/10">
                          New Session
                        </Button>
                        <Button
                          onClick={handleStart}
                          disabled={loading}
                          className="flex-1 h-9 text-xs bg-gradient-to-r from-cyan-600 to-blue-600"
                        >
                          <Zap className="w-3.5 h-3.5 mr-1.5" />
                          Restart
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* FAB */}
      <motion.button
        onClick={() => setOpen(o => !o)}
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.95 }}
        className="fixed bottom-5 right-5 z-50 group"
        aria-label="SpeedAI Engine"
      >
        {/* Outer glow ring — pulsing when running */}
        {isRunning && (
          <span className="absolute inset-0 rounded-2xl bg-cyan-500/30 animate-ping" />
        )}

        {/* The FAB itself — diamond/crystal hex shape via border-radius */}
        <div className={`
          relative w-14 h-14 rounded-2xl flex flex-col items-center justify-center gap-0.5
          shadow-lg shadow-cyan-900/50 transition-all duration-200
          ${isRunning
            ? "bg-gradient-to-br from-cyan-500 to-blue-600 shadow-cyan-500/40"
            : "bg-gradient-to-br from-[#0d1a2d] to-[#0a1525] border border-cyan-500/40 hover:border-cyan-400/70"}
        `}>
          {/* Subtle inner shimmer */}
          <div className="absolute inset-0 rounded-2xl bg-gradient-to-tr from-white/5 to-transparent pointer-events-none" />

          <Zap className={`w-5 h-5 ${isRunning ? "text-white" : "text-cyan-400"}`} />
          <span className={`text-[8px] font-bold tracking-widest ${isRunning ? "text-white/90" : "text-cyan-500"}`}>
            {isRunning ? "LIVE" : "SPEED"}
          </span>

          {/* Trade count badge */}
          {isRunning && status && status.tradeCount > 0 && (
            <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-green-500 text-white text-[9px] font-bold flex items-center justify-center border border-black">
              {status.tradeCount}
            </span>
          )}
        </div>

        {/* Tooltip */}
        <span className="absolute right-full mr-2 top-1/2 -translate-y-1/2 px-2 py-1 rounded-lg bg-black/80 text-white text-[11px] font-medium whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none border border-white/10">
          SpeedAI Engine
        </span>
      </motion.button>
    </>
  );
}
