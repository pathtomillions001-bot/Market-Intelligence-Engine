import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  X, Zap, TrendingUp, Hash, Equal, Loader2, StopCircle,
  BarChart2, ScanSearch, CheckCircle2, AlertTriangle, RefreshCw,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { useGetSettings } from "@workspace/api-client-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type ContractFamily = "overUnder" | "riseFall" | "evenOdd" | "matchDiff";
type RecoveryMethod = "split" | "instant";
type Step = "config" | "scanning" | "scan-result" | "running";

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

interface MarketScore {
  symbol: string;
  displayName: string;
  contractType: string;
  barrier?: number;
  score: number;
  winProbability: number;
  reason: string;
}

interface ScanResult {
  suitable: boolean;
  best: MarketScore | null;
  allScored: MarketScore[];
  reason: string;
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
  topMarkets?: MarketScore[];
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

function familyToContracts(family: ContractFamily, overB: number, underB: number) {
  switch (family) {
    case "overUnder":  return { types: ["DIGITOVER", "DIGITUNDER"], barriers: [overB, underB] };
    case "riseFall":   return { types: ["CALL", "PUT"], barriers: [] };
    case "evenOdd":    return { types: ["DIGITEVEN", "DIGITODD"], barriers: [] };
    case "matchDiff":  return { types: ["DIGITMATCH", "DIGITDIFF"], barriers: [] };
  }
}

function scoreColor(score: number) {
  if (score >= 60) return "text-green-400";
  if (score >= 54) return "text-cyan-400";
  if (score >= 48) return "text-amber-400";
  return "text-red-400";
}

// ── Sub-components ────────────────────────────────────────────────────────────

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

function FamilySelector({ label, value, onChange, showBarriers, overBarrier, underBarrier, onOverBarrier, onUnderBarrier }: {
  label: string; value: ContractFamily; onChange: (v: ContractFamily) => void;
  showBarriers: boolean; overBarrier: number; underBarrier: number;
  onOverBarrier: (v: number) => void; onUnderBarrier: (v: number) => void;
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
  const [step, setStep] = useState<Step>("config");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
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

  // Sync defaults from user settings
  useEffect(() => {
    if (settings) {
      const s = settings as any;
      setConfig(prev => ({
        ...prev,
        normalOverBarrier:    s.normalOverDigit    ?? prev.normalOverBarrier,
        normalUnderBarrier:   s.normalUnderDigit   ?? prev.normalUnderBarrier,
        recoveryOverBarrier:  s.recoveryOverDigit  ?? prev.recoveryOverBarrier,
        recoveryUnderBarrier: s.recoveryUnderDigit ?? prev.recoveryUnderBarrier,
        recoveryMultiplier:   s.recoveryMultiplier ?? prev.recoveryMultiplier,
        recoveryMethod:       (s.recoveryMethod    ?? prev.recoveryMethod) as RecoveryMethod,
        maxRecoverySteps:     s.maxRecoverySteps   ?? prev.maxRecoverySteps,
        stake:                s.riskAmountValue    ?? prev.stake,
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
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (open) {
      fetchStatus();
      pollRef.current = setInterval(fetchStatus, 1000);
    } else {
      if (pollRef.current) clearInterval(pollRef.current);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [open, fetchStatus]);

  // SSE listener
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

  // ── Build request body from current config ──────────────────────────────
  function buildBody(lockedSymbol?: string) {
    const normalContracts  = familyToContracts(config.normalFamily,   config.normalOverBarrier,   config.normalUnderBarrier);
    const recoveryContracts = familyToContracts(config.recoveryFamily, config.recoveryOverBarrier, config.recoveryUnderBarrier);
    return {
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
      ...(lockedSymbol ? { lockedSymbol } : {}),
    };
  }

  // ── Scan markets ────────────────────────────────────────────────────────
  const handleScan = async () => {
    setLoading(true);
    setStep("scanning");
    setScanResult(null);
    try {
      const res = await fetch("/api/speed-ai/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      const data: ScanResult = await res.json();
      if (!res.ok) {
        toast.error((data as any).error ?? "Scan failed");
        setStep("config");
        return;
      }
      setScanResult(data);
      setStep("scan-result");
    } catch {
      toast.error("Could not reach the server");
      setStep("config");
    } finally {
      setLoading(false);
    }
  };

  // ── Start trading on the scanned market ─────────────────────────────────
  const handleStart = async (lockedSymbol: string) => {
    setLoading(true);
    try {
      const res = await fetch("/api/speed-ai/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody(lockedSymbol)),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Failed to start SpeedAI");
        return;
      }
      setStatus(data.status);
      setStep("running");
      toast.success("⚡ SpeedAI locked on market — trading now!");
    } catch {
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
    setScanResult(null);
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
                    <p className="text-xs font-bold text-white tracking-wide">NEUROAI</p>
                    <p className="text-[9px] text-cyan-400/70 uppercase tracking-widest">1-Tick Engine</p>
                  </div>
                </div>
                <button onClick={() => setOpen(false)} className="p-1 rounded-md text-muted-foreground hover:text-white">
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* ── STEP: CONFIG ── */}
              {step === "config" && (
                <div className="p-4 space-y-5">
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
                      <NumInput label="Stop loss"        value={config.stopLoss} onChange={v => set("stopLoss", v)} min={0.5} step={1} suffix="$" />
                      <NumInput label="Take profit"      value={config.takeProfit} onChange={v => set("takeProfit", v)} min={0.5} step={1} suffix="$" />
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

                  {/* Scan button */}
                  <Button
                    onClick={handleScan}
                    disabled={loading}
                    className="w-full h-10 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold text-sm shadow-lg shadow-cyan-900/40"
                  >
                    <ScanSearch className="w-4 h-4 mr-2" />
                    Scan Markets
                  </Button>

                  <p className="text-[10px] text-center text-muted-foreground/60 -mt-2">
                    AI agents will find the best market for your settings
                  </p>
                </div>
              )}

              {/* ── STEP: SCANNING ── */}
              {step === "scanning" && (
                <div className="p-6 flex flex-col items-center gap-4 text-center">
                  {/* Animated radar */}
                  <div className="relative w-20 h-20 flex items-center justify-center">
                    <span className="absolute inset-0 rounded-full border-2 border-cyan-500/30 animate-ping" />
                    <span className="absolute inset-2 rounded-full border border-cyan-500/20 animate-ping [animation-delay:0.3s]" />
                    <div className="w-14 h-14 rounded-full bg-cyan-500/10 border border-cyan-500/40 flex items-center justify-center">
                      <ScanSearch className="w-6 h-6 text-cyan-400 animate-pulse" />
                    </div>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white">Scanning all markets…</p>
                    <p className="text-xs text-muted-foreground mt-1">AI agents are evaluating every market<br />against your settings</p>
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] text-cyan-400/70">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Analysing digit patterns &amp; probabilities
                  </div>
                </div>
              )}

              {/* ── STEP: SCAN RESULT ── */}
              {step === "scan-result" && scanResult && (
                <div className="p-4 space-y-4">
                  {scanResult.suitable && scanResult.best ? (
                    <>
                      {/* Suitable market card */}
                      <div className="rounded-xl bg-green-500/5 border border-green-500/25 p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />
                          <p className="text-xs font-semibold text-green-300">Suitable market found</p>
                        </div>

                        <div className="bg-black/30 rounded-lg p-2.5 space-y-1.5">
                          <div className="flex items-center justify-between">
                            <p className="text-sm font-bold text-white truncate">{scanResult.best.displayName}</p>
                            <span className={`text-sm font-bold font-mono ${scoreColor(scanResult.best.score)}`}>
                              {scanResult.best.score.toFixed(0)}<span className="text-[10px] font-normal text-muted-foreground">/100</span>
                            </span>
                          </div>
                          <div className="flex items-center gap-2 text-[11px]">
                            <span className="px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 font-mono font-medium">
                              {scanResult.best.contractType}{scanResult.best.barrier !== undefined ? ` ${scanResult.best.barrier}` : ""}
                            </span>
                            <span className="text-muted-foreground">{(scanResult.best.winProbability * 100).toFixed(1)}% win rate</span>
                          </div>
                          <p className="text-[10px] text-muted-foreground">{scanResult.best.reason}</p>
                        </div>

                        {/* Top 3 runners-up */}
                        {scanResult.allScored.length > 1 && (
                          <div className="space-y-1 pt-1">
                            <p className="text-[9px] uppercase tracking-wider text-muted-foreground/60">Other markets scanned</p>
                            {scanResult.allScored.slice(1, 4).map((m, i) => (
                              <div key={i} className="flex items-center gap-2 text-[10px] text-muted-foreground">
                                <span className="w-3 text-muted-foreground/40">{i + 2}</span>
                                <span className="flex-1 truncate">{m.displayName}</span>
                                <span className={`font-mono font-semibold ${scoreColor(m.score)}`}>{m.score.toFixed(0)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <p className="text-[10px] text-center text-muted-foreground/70 px-2">
                        The engine will trade <span className="text-cyan-400 font-medium">{scanResult.best.displayName}</span> exclusively until TP or SL is hit
                      </p>

                      <Button
                        onClick={() => handleStart(scanResult.best!.symbol)}
                        disabled={loading}
                        className="w-full h-10 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold text-sm shadow-lg shadow-cyan-900/40"
                      >
                        {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Zap className="w-4 h-4 mr-2" />}
                        Run SpeedAI
                      </Button>

                      <button onClick={() => setStep("config")} className="w-full text-[11px] text-muted-foreground hover:text-white text-center py-1">
                        ← Change settings
                      </button>
                    </>
                  ) : (
                    <>
                      {/* No suitable market */}
                      <div className="rounded-xl bg-amber-500/5 border border-amber-500/25 p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
                          <p className="text-xs font-semibold text-amber-300">No suitable market found</p>
                        </div>
                        <p className="text-[11px] text-muted-foreground">{scanResult.reason}</p>

                        {/* Show what was found anyway */}
                        {scanResult.allScored.length > 0 && (
                          <div className="bg-black/30 rounded-lg p-2 space-y-1 mt-1">
                            <p className="text-[9px] uppercase tracking-wider text-muted-foreground/50 mb-1">Current best (below threshold)</p>
                            {scanResult.allScored.slice(0, 3).map((m, i) => (
                              <div key={i} className="flex items-center gap-2 text-[10px]">
                                <span className="w-3 text-muted-foreground/40">{i + 1}</span>
                                <span className="flex-1 truncate text-muted-foreground">{m.displayName}</span>
                                <span className="font-mono text-amber-400/80">{m.score.toFixed(0)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <p className="text-[10px] text-center text-muted-foreground/60 px-2">
                        Market conditions don't yet match your settings. Scan again in a few seconds.
                      </p>

                      <Button
                        onClick={handleScan}
                        disabled={loading}
                        className="w-full h-10 bg-gradient-to-r from-amber-600/80 to-orange-600/80 hover:from-amber-500 hover:to-orange-500 text-white font-bold text-sm"
                      >
                        {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <RefreshCw className="w-4 h-4 mr-2" />}
                        Scan Again
                      </Button>

                      <button onClick={() => setStep("config")} className="w-full text-[11px] text-muted-foreground hover:text-white text-center py-1">
                        ← Change settings
                      </button>
                    </>
                  )}
                </div>
              )}

              {/* ── STEP: RUNNING ── */}
              {step === "running" && (
                <div className="p-4 space-y-4">
                  {/* P&L card */}
                  <div className={`rounded-xl p-3 border ${isRunning ? "bg-cyan-500/5 border-cyan-500/20" : "bg-secondary/30 border-border"}`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Session P&L</span>
                      {isRunning
                        ? <span className="flex items-center gap-1 text-[10px] text-cyan-400"><span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />LIVE</span>
                        : <span className="text-[10px] text-muted-foreground">STOPPED</span>}
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
                    {/* TP/SL bar */}
                    {status?.config && (
                      <div className="mt-2 space-y-1">
                        <div className="flex justify-between text-[9px] text-muted-foreground">
                          <span>SL -${status.config.stopLoss.toFixed(2)}</span>
                          <span>TP +${status.config.takeProfit.toFixed(2)}</span>
                        </div>
                        <div className="h-1.5 bg-secondary rounded-full overflow-hidden relative">
                          <div className="absolute left-1/2 top-0 w-px h-full bg-white/20" />
                          <div
                            className={`absolute top-0 h-full rounded-full transition-all ${status.totalProfit >= 0 ? "bg-green-500 left-1/2" : "bg-red-500 right-1/2"}`}
                            style={{ width: `${Math.min(50, Math.abs(status.totalProfit) / (status.totalProfit >= 0 ? status.config.takeProfit : status.config.stopLoss) * 50)}%` }}
                          />
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

                  {/* Locked market + current trade */}
                  {isRunning && status?.currentMarket && (
                    <div className="flex items-center gap-2 bg-white/3 rounded-lg px-3 py-2 border border-white/5">
                      <Loader2 className="w-3 h-3 text-cyan-400 animate-spin flex-shrink-0" />
                      <div className="min-w-0">
                        <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-cyan-500 inline-block" />
                          Locked market
                        </p>
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

                  {/* Controls */}
                  <div className="flex gap-2">
                    {isRunning ? (
                      <Button onClick={handleStop} disabled={loading} variant="destructive" className="flex-1 h-9 text-xs">
                        <StopCircle className="w-3.5 h-3.5 mr-1.5" />
                        Stop Engine
                      </Button>
                    ) : (
                      <>
                        <Button onClick={handleReset} variant="outline" className="flex-1 h-9 text-xs border-white/10">
                          New Session
                        </Button>
                        <Button
                          onClick={handleScan}
                          disabled={loading}
                          className="flex-1 h-9 text-xs bg-gradient-to-r from-cyan-600 to-blue-600"
                        >
                          <ScanSearch className="w-3.5 h-3.5 mr-1.5" />
                          Re-scan
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
        aria-label="NeuroAI Engine"
      >
        {/* Running ping ring */}
        {isRunning && <span className="absolute inset-0 rounded-2xl bg-cyan-500/30 animate-ping" />}

        {/* Glowing orbital nodes */}
        <motion.span
          className="absolute -top-1.5 -left-1.5 w-2 h-2 rounded-full bg-cyan-400"
          style={{ boxShadow: "0 0 8px 3px rgba(34,211,238,0.9)" }}
          animate={{ opacity: [0.35, 1, 0.35], scale: [0.7, 1.3, 0.7] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.span
          className="absolute -bottom-1.5 -right-1.5 w-2 h-2 rounded-full bg-blue-400"
          style={{ boxShadow: "0 0 8px 3px rgba(96,165,250,0.9)" }}
          animate={{ opacity: [0.35, 1, 0.35], scale: [0.7, 1.3, 0.7] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut", delay: 0.75 }}
        />
        <motion.span
          className="absolute -top-1.5 -right-1.5 w-1.5 h-1.5 rounded-full bg-cyan-300"
          style={{ boxShadow: "0 0 6px 2px rgba(103,232,249,0.9)" }}
          animate={{ opacity: [0.35, 1, 0.35], scale: [0.7, 1.3, 0.7] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut", delay: 1.5 }}
        />
        <motion.span
          className="absolute -bottom-1.5 -left-1.5 w-1.5 h-1.5 rounded-full bg-blue-300"
          style={{ boxShadow: "0 0 6px 2px rgba(147,197,253,0.9)" }}
          animate={{ opacity: [0.35, 1, 0.35], scale: [0.7, 1.3, 0.7] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut", delay: 1.1 }}
        />

        <div className={`
          relative w-14 h-14 rounded-2xl flex flex-col items-center justify-center gap-0.5
          shadow-lg transition-all duration-200
          ${isRunning
            ? "bg-gradient-to-br from-cyan-500 to-blue-600 shadow-[0_0_24px_rgba(6,182,212,0.6)]"
            : "bg-gradient-to-br from-[#0d1a2d] to-[#0a1525] border border-cyan-500/40 hover:border-cyan-400/70 shadow-[0_0_16px_rgba(6,182,212,0.25)] hover:shadow-[0_0_22px_rgba(6,182,212,0.45)]"}
        `}>
          <div className="absolute inset-0 rounded-2xl bg-gradient-to-tr from-white/5 to-transparent pointer-events-none" />
          <Zap className={`w-5 h-5 ${isRunning ? "text-white" : "text-cyan-400"}`} />
          <span className={`text-[7px] font-bold tracking-wider ${isRunning ? "text-white/90" : "text-cyan-500"}`}>
            {isRunning ? "LIVE" : "NEUROAI"}
          </span>
          {isRunning && status && status.tradeCount > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-cyan-400 text-[8px] font-bold text-black flex items-center justify-center">
              {status.tradeCount}
            </span>
          )}
        </div>
      </motion.button>
    </>
  );
}
