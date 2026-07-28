/**
 * APEX Engine — Precision 1-tick trading FAB
 *
 * Flow: Configure → Scan all markets → Lock best market → Trade continuously
 * Normal trades: DIGITDIFF (coldest digit, ~96% win)
 * Recovery trades: DIGITMATCH (hottest digit, 9× payout)
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { X, Loader2, StopCircle, ScanSearch, CheckCircle2, AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { useGetSettings } from "@workspace/api-client-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type RecoveryMethod = "split" | "instant";
type Step = "config" | "scanning" | "scan-result" | "running";

interface ApexConfig {
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
  };
  topMarkets?: MarketScore[];
}

// ── APEX animated icon ────────────────────────────────────────────────────────

function ApexIcon({ running }: { running: boolean }) {
  return (
    <svg viewBox="0 0 32 32" width="22" height="22" fill="none" aria-hidden>
      {/* Outer rotating hexagonal ring */}
      <motion.g
        style={{ originX: "16px", originY: "16px" } as React.CSSProperties}
        animate={{ rotate: 360 }}
        transition={{ duration: 14, repeat: Infinity, ease: "linear" }}
      >
        <polygon
          points="16,2 27,8.5 27,23.5 16,30 5,23.5 5,8.5"
          stroke={running ? "#ffffff" : "#22d3ee"}
          strokeWidth="0.9"
          strokeDasharray="4 2.5"
          fill="none"
          opacity={running ? 0.7 : 0.45}
        />
      </motion.g>

      {/* Inner apex triangle — pulses when running */}
      <motion.polygon
        points="16,7 25,23 7,23"
        stroke={running ? "#ffffff" : "#22d3ee"}
        strokeWidth="1.4"
        strokeLinejoin="round"
        fill="none"
        animate={running ? { scale: [1, 1.06, 1], opacity: [1, 0.7, 1] } : { opacity: [0.8, 1, 0.8] }}
        style={{ originX: "16px", originY: "16px" } as React.CSSProperties}
        transition={{ duration: running ? 1.1 : 2.5, repeat: Infinity, ease: "easeInOut" }}
      />

      {/* Horizontal scan line — sweeps inside the triangle when running */}
      {running && (
        <motion.line
          x1="9" y1="18" x2="23" y2="18"
          stroke="#ffffff"
          strokeWidth="0.8"
          opacity={0.5}
          animate={{ y1: [16, 22, 16], y2: [16, 22, 16], opacity: [0.6, 0, 0.6] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
        />
      )}

      {/* Center dot */}
      <motion.circle
        cx="16" cy="17" r="1.8"
        fill={running ? "#ffffff" : "#22d3ee"}
        animate={{ opacity: [1, 0.35, 1] }}
        transition={{ duration: running ? 0.9 : 2, repeat: Infinity, ease: "easeInOut" }}
      />
    </svg>
  );
}

// ── Score colour helper ───────────────────────────────────────────────────────

function scoreColor(score: number) {
  if (score >= 60) return "text-green-400";
  if (score >= 54) return "text-cyan-400";
  if (score >= 48) return "text-amber-400";
  return "text-red-400";
}

// ── NumInput ──────────────────────────────────────────────────────────────────

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

// ── Main component ────────────────────────────────────────────────────────────

export function SpeedAIFab() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("config");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const { data: settings } = useGetSettings();

  const [config, setConfig] = useState<ApexConfig>({
    stake: 1,
    stopLoss: 5,
    takeProfit: 10,
    recoveryMultiplier: 1.62,
    recoveryMethod: "split",
    maxRecoverySteps: 3,
  });

  const set = <K extends keyof ApexConfig>(k: K, v: ApexConfig[K]) =>
    setConfig(prev => ({ ...prev, [k]: v }));

  // Sync defaults from user settings
  useEffect(() => {
    if (settings) {
      const s = settings as any;
      setConfig(prev => ({
        ...prev,
        recoveryMultiplier: s.recoveryMultiplier ?? prev.recoveryMultiplier,
        recoveryMethod:     (s.recoveryMethod    ?? prev.recoveryMethod) as RecoveryMethod,
        maxRecoverySteps:   s.maxRecoverySteps   ?? prev.maxRecoverySteps,
        stake:              s.riskAmountValue    ?? prev.stake,
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

  // Build request body — contract types are fixed: DIGITDIFF normal, DIGITMATCH recovery
  function buildBody(lockedSymbol?: string) {
    return {
      normalContractTypes:   ["DIGITDIFF"],
      normalBarriers:        [],            // engine auto-picks coldest digit
      recoveryContractTypes: ["DIGITMATCH"],
      recoveryBarriers:      [],            // engine auto-picks hottest digit
      stake:                 config.stake,
      stopLoss:              config.stopLoss,
      takeProfit:            config.takeProfit,
      recoveryMultiplier:    config.recoveryMultiplier,
      recoveryMethod:        config.recoveryMethod,
      maxRecoverySteps:      config.maxRecoverySteps,
      ...(lockedSymbol ? { lockedSymbol } : {}),
    };
  }

  // Scan all markets
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

  // Start trading on the scanned (locked) market
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
        toast.error(data.error ?? "Failed to start APEX");
        return;
      }
      setStatus(data.status);
      setStep("running");
      toast.success("APEX locked — trading initiated");
    } catch {
      toast.error("Could not start APEX session");
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
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-cyan-500/20 to-blue-600/20 border border-cyan-500/30 flex items-center justify-center">
                    <ApexIcon running={isRunning} />
                  </div>
                  <div>
                    <p className="text-xs font-bold text-white tracking-widest">APEX</p>
                    <p className="text-[9px] text-cyan-400/70 uppercase tracking-widest">Precision 1-Tick Engine</p>
                  </div>
                </div>
                <button onClick={() => setOpen(false)} className="p-1 rounded-md text-muted-foreground hover:text-white transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* ── CONFIG ── */}
              {step === "config" && (
                <div className="p-4 space-y-5">
                  {/* Strategy badge */}
                  <div className="flex gap-2">
                    <div className="flex-1 bg-white/3 rounded-xl p-3 border border-white/5 text-center">
                      <p className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1">Normal</p>
                      <p className="text-xs font-bold text-cyan-300">DIGIT DIFFER</p>
                      <p className="text-[9px] text-muted-foreground mt-0.5">~96% win · coldest digit</p>
                    </div>
                    <div className="flex items-center text-muted-foreground/30 text-xs">→</div>
                    <div className="flex-1 bg-white/3 rounded-xl p-3 border border-amber-500/15 text-center">
                      <p className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1">Recovery</p>
                      <p className="text-xs font-bold text-amber-300">DIGIT MATCH</p>
                      <p className="text-[9px] text-muted-foreground mt-0.5">9× payout · hottest digit</p>
                    </div>
                  </div>

                  {/* Risk settings */}
                  <div className="space-y-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Risk Settings</p>
                    <div className="space-y-2 bg-white/3 rounded-xl p-3 border border-white/5">
                      <NumInput label="Stake per trade" value={config.stake}      onChange={v => set("stake", v)}      min={0.35} step={0.5}  suffix="$" />
                      <NumInput label="Stop loss"        value={config.stopLoss}   onChange={v => set("stopLoss", v)}   min={0.5}  step={1}    suffix="$" />
                      <NumInput label="Take profit"      value={config.takeProfit} onChange={v => set("takeProfit", v)} min={0.5}  step={1}    suffix="$" />
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

                  <p className="text-[10px] text-center text-muted-foreground/50 -mt-2">
                    Scans all 17 markets — Volatility, Volatility 1s, Bull &amp; Bear
                  </p>
                </div>
              )}

              {/* ── SCANNING ── */}
              {step === "scanning" && (
                <div className="p-6 flex flex-col items-center gap-5 text-center">
                  <div className="relative w-24 h-24 flex items-center justify-center">
                    <motion.span
                      className="absolute inset-0 rounded-full border border-cyan-500/30"
                      animate={{ scale: [1, 1.35, 1], opacity: [0.5, 0, 0.5] }}
                      transition={{ duration: 2, repeat: Infinity, ease: "easeOut" }}
                    />
                    <motion.span
                      className="absolute inset-3 rounded-full border border-cyan-500/20"
                      animate={{ scale: [1, 1.25, 1], opacity: [0.4, 0, 0.4] }}
                      transition={{ duration: 2, repeat: Infinity, ease: "easeOut", delay: 0.4 }}
                    />
                    <div className="w-16 h-16 rounded-full bg-cyan-500/8 border border-cyan-500/30 flex items-center justify-center">
                      <ApexIcon running={false} />
                    </div>
                  </div>

                  <div>
                    <p className="text-sm font-semibold text-white tracking-wide">Scanning all markets</p>
                    <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                      Evaluating digit patterns across<br />all 17 synthetic indices
                    </p>
                  </div>

                  <div className="w-full space-y-1.5">
                    {["Volatility 1s indices", "Volatility indices", "Bull & Bear markets", "Jump indices"].map((label, i) => (
                      <motion.div
                        key={label}
                        className="flex items-center gap-2 text-[11px] text-muted-foreground bg-white/3 rounded-lg px-3 py-1.5"
                        initial={{ opacity: 0, x: -6 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: i * 0.25 }}
                      >
                        <motion.span
                          className="w-1.5 h-1.5 rounded-full bg-cyan-500 flex-shrink-0"
                          animate={{ opacity: [1, 0.3, 1] }}
                          transition={{ duration: 1, repeat: Infinity, delay: i * 0.3 }}
                        />
                        {label}
                        <Loader2 className="w-3 h-3 animate-spin ml-auto text-cyan-500/60" />
                      </motion.div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── SCAN RESULT ── */}
              {step === "scan-result" && scanResult && (
                <div className="p-4 space-y-4">
                  {scanResult.suitable && scanResult.best ? (
                    <>
                      {/* Suitable market */}
                      <div className="rounded-xl bg-green-500/5 border border-green-500/20 p-3 space-y-3">
                        <div className="flex items-center gap-2">
                          <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />
                          <p className="text-xs font-semibold text-green-300">Market locked — ready to trade</p>
                        </div>

                        <div className="bg-black/40 rounded-lg p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <p className="text-sm font-bold text-white">{scanResult.best.displayName}</p>
                            <span className={`text-sm font-bold font-mono ${scoreColor(scanResult.best.score)}`}>
                              {scanResult.best.score.toFixed(0)}<span className="text-[10px] font-normal text-muted-foreground">/100</span>
                            </span>
                          </div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="px-2 py-0.5 rounded-md bg-cyan-500/15 text-cyan-300 font-mono text-[11px] font-medium border border-cyan-500/20">
                              {scanResult.best.contractType}{scanResult.best.barrier !== undefined ? ` ${scanResult.best.barrier}` : ""}
                            </span>
                            <span className="text-[11px] text-muted-foreground">
                              {(scanResult.best.winProbability * 100).toFixed(1)}% win rate
                            </span>
                          </div>
                          <p className="text-[10px] text-muted-foreground">{scanResult.best.reason}</p>
                        </div>

                        {/* Runners-up */}
                        {scanResult.allScored.length > 1 && (
                          <div className="space-y-1">
                            <p className="text-[9px] uppercase tracking-wider text-muted-foreground/50">Other markets scanned ({scanResult.allScored.length} total)</p>
                            {scanResult.allScored.slice(1, 4).map((m, i) => (
                              <div key={i} className="flex items-center gap-2 text-[10px] text-muted-foreground">
                                <span className="w-4 text-muted-foreground/40 text-right">{i + 2}</span>
                                <span className="flex-1 truncate">{m.displayName}</span>
                                <span className={`font-mono font-semibold text-[10px] ${scoreColor(m.score)}`}>{m.score.toFixed(0)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <p className="text-[10px] text-center text-muted-foreground/60 px-2 leading-relaxed">
                        APEX will trade <span className="text-cyan-400 font-medium">{scanResult.best.displayName}</span> exclusively —<br />no market switches until you stop and re-scan
                      </p>

                      <Button
                        onClick={() => handleStart(scanResult.best!.symbol)}
                        disabled={loading}
                        className="w-full h-10 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold text-sm shadow-lg shadow-cyan-900/40"
                      >
                        {loading
                          ? <Loader2 className="w-4 h-4 animate-spin mr-2" />
                          : <ApexIcon running={false} />
                        }
                        <span className="ml-2">Launch APEX</span>
                      </Button>

                      <button onClick={() => setStep("config")} className="w-full text-[11px] text-muted-foreground hover:text-white text-center py-1 transition-colors">
                        Change settings
                      </button>
                    </>
                  ) : (
                    <>
                      {/* No suitable market */}
                      <div className="rounded-xl bg-amber-500/5 border border-amber-500/20 p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
                          <p className="text-xs font-semibold text-amber-300">No clear edge detected</p>
                        </div>
                        <p className="text-[11px] text-muted-foreground leading-relaxed">{scanResult.reason}</p>

                        {scanResult.allScored.length > 0 && (
                          <div className="bg-black/30 rounded-lg p-2.5 space-y-1.5 mt-1">
                            <p className="text-[9px] uppercase tracking-wider text-muted-foreground/50">Current standings (below threshold)</p>
                            {scanResult.allScored.slice(0, 4).map((m, i) => (
                              <div key={i} className="flex items-center gap-2 text-[10px]">
                                <span className="w-4 text-muted-foreground/40 text-right">{i + 1}</span>
                                <span className="flex-1 truncate text-muted-foreground">{m.displayName}</span>
                                <span className="font-mono text-amber-400/70 text-[10px]">{m.score.toFixed(0)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <p className="text-[10px] text-center text-muted-foreground/60 px-2 leading-relaxed">
                        Market conditions don't yet favour your settings.<br />Scan again in a few seconds.
                      </p>

                      <Button
                        onClick={handleScan}
                        disabled={loading}
                        className="w-full h-10 bg-gradient-to-r from-amber-700/80 to-orange-700/80 hover:from-amber-600 hover:to-orange-600 text-white font-bold text-sm"
                      >
                        {loading
                          ? <Loader2 className="w-4 h-4 animate-spin mr-2" />
                          : <RefreshCw className="w-4 h-4 mr-2" />
                        }
                        Scan Again
                      </Button>

                      <button onClick={() => setStep("config")} className="w-full text-[11px] text-muted-foreground hover:text-white text-center py-1 transition-colors">
                        Change settings
                      </button>
                    </>
                  )}
                </div>
              )}

              {/* ── RUNNING ── */}
              {step === "running" && (
                <div className="p-4 space-y-4">
                  {/* P&L card */}
                  <div className={`rounded-xl p-3 border ${isRunning ? "bg-cyan-500/5 border-cyan-500/20" : "bg-secondary/30 border-border"}`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Session P&amp;L</span>
                      {isRunning
                        ? <span className="flex items-center gap-1.5 text-[10px] text-cyan-400 font-medium">
                            <motion.span
                              className="w-1.5 h-1.5 rounded-full bg-cyan-400"
                              animate={{ opacity: [1, 0.3, 1] }}
                              transition={{ duration: 0.8, repeat: Infinity }}
                            />
                            LIVE
                          </span>
                        : <span className="text-[10px] text-muted-foreground">STOPPED</span>
                      }
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
                    {status?.config && (
                      <div className="mt-2 space-y-1">
                        <div className="flex justify-between text-[9px] text-muted-foreground">
                          <span>SL −${status.config.stopLoss.toFixed(2)}</span>
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
                      status.message.startsWith("Take profit") || status.message.includes("complete")
                        ? "bg-green-500/10 border-green-500/20 text-green-400"
                        : status.message.includes("Stop loss") || status.message.includes("stopped")
                        ? "bg-red-500/10 border-red-500/20 text-red-400"
                        : status.message.includes("Max recovery") || status.message.includes("protect")
                        ? "bg-amber-500/10 border-amber-500/20 text-amber-400"
                        : "bg-secondary/30 border-border text-muted-foreground"
                    }`}>
                      {status.message}
                    </div>
                  )}

                  {/* Locked market */}
                  {status?.currentMarket && (
                    <div className="flex items-center gap-2.5 bg-white/3 rounded-lg px-3 py-2.5 border border-white/5">
                      {isRunning
                        ? <motion.div
                            className="w-2 h-2 rounded-full bg-cyan-400 flex-shrink-0"
                            animate={{ opacity: [1, 0.3, 1] }}
                            transition={{ duration: 0.8, repeat: Infinity }}
                          />
                        : <div className="w-2 h-2 rounded-full bg-muted-foreground/40 flex-shrink-0" />
                      }
                      <div className="min-w-0 flex-1">
                        <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Locked market</p>
                        <p className="text-xs font-semibold text-white truncate">{status.currentMarket}</p>
                        <p className="text-[10px] font-mono text-cyan-400">{status.currentContractType} · ${status.currentStake.toFixed(2)}</p>
                      </div>
                      {status.lastResult && (
                        <span className={`text-[10px] font-bold px-2 py-1 rounded-md ${
                          status.lastResult === "won"
                            ? "bg-green-500/20 text-green-400 border border-green-500/20"
                            : "bg-red-500/20 text-red-400 border border-red-500/20"
                        }`}>
                          {status.lastResult === "won" ? "WIN" : "LOSS"}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Recovery indicator */}
                  {status?.inRecovery && (
                    <div className="flex items-center gap-2 bg-amber-500/5 rounded-lg px-3 py-2 border border-amber-500/20">
                      <motion.span
                        className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0"
                        animate={{ opacity: [1, 0.3, 1] }}
                        transition={{ duration: 1, repeat: Infinity }}
                      />
                      <span className="text-xs text-amber-400">
                        Recovery step {status.recoveryStep} · ${status.unrecoveredAmount.toFixed(2)} to recover
                      </span>
                    </div>
                  )}

                  {/* Controls */}
                  <div className="flex gap-2">
                    {isRunning ? (
                      <Button onClick={handleStop} disabled={loading} variant="destructive" className="flex-1 h-9 text-xs">
                        <StopCircle className="w-3.5 h-3.5 mr-1.5" />
                        Stop APEX
                      </Button>
                    ) : (
                      <>
                        <Button onClick={handleReset} variant="outline" className="flex-1 h-9 text-xs border-white/10">
                          New Session
                        </Button>
                        <Button onClick={handleScan} disabled={loading} className="flex-1 h-9 text-xs bg-gradient-to-r from-cyan-600 to-blue-600">
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

      {/* FAB button */}
      <motion.button
        onClick={() => setOpen(o => !o)}
        whileHover={{ scale: 1.07 }}
        whileTap={{ scale: 0.94 }}
        className="fixed bottom-5 right-5 z-50"
        aria-label="APEX Engine"
      >
        {/* Outer glow ring when running */}
        {isRunning && (
          <motion.span
            className="absolute inset-0 rounded-2xl bg-cyan-500/25"
            animate={{ scale: [1, 1.18, 1], opacity: [0.5, 0, 0.5] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut" }}
          />
        )}

        <div className={`
          relative w-14 h-14 rounded-2xl flex flex-col items-center justify-center gap-0.5
          transition-all duration-300
          ${isRunning
            ? "bg-gradient-to-br from-cyan-500 to-blue-600 shadow-lg shadow-cyan-500/40"
            : "bg-gradient-to-br from-[#0d1a2d] to-[#0a1525] border border-cyan-500/40 shadow-lg shadow-black/50 hover:border-cyan-400/70"}
        `}>
          {/* Shimmer overlay */}
          <div className="absolute inset-0 rounded-2xl bg-gradient-to-tr from-white/5 to-transparent pointer-events-none" />

          <ApexIcon running={isRunning} />
          <span className={`text-[8px] font-bold tracking-widest leading-none ${isRunning ? "text-white/90" : "text-cyan-500"}`}>
            {isRunning ? "LIVE" : "APEX"}
          </span>

          {/* Trade count badge */}
          {isRunning && status && status.tradeCount > 0 && (
            <motion.span
              className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-cyan-400 text-[8px] font-bold text-black flex items-center justify-center shadow-md"
              initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: "spring" }}
            >
              {status.tradeCount}
            </motion.span>
          )}
        </div>
      </motion.button>
    </>
  );
}
