import { useState, useMemo, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useLocation } from "wouter";
import { toast } from "sonner";
import {
  Calculator, TrendingUp, TrendingDown, ShieldAlert, Shield,
  AlertTriangle, Zap, GitBranch, Info, Target, BarChart3,
  RefreshCw, ArrowRight, DollarSign, Sparkles, Wallet, Lock,
  Unlock, ChevronDown, CheckCircle2, Copy, Check, RotateCcw,
  Flame, Gauge, Layers, Send, Minus, Plus, Crown,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useGetAccount, useUpdateSettings, useGetSettings } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  calcRisk, calcSuggestedStake, getPayout, getWinProb, streakProb,
  suggestedStakeBreakdown, OVER_PAYOUTS, UNDER_PAYOUTS,
  type ContractType,
} from "@/lib/risk-math";

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_TP_PCT = 0.10;   // 10 % of balance
const DEFAULT_SL_PCT = 0.30;   // 30 % of balance
const MIN_STAKE      = 0.35;   // Deriv minimum

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt  = (n: number, d = 2) => n.toFixed(d);
const pct  = (n: number)        => `${(n * 100).toFixed(1)}%`;
const usd  = (n: number)        => `$${fmt(n)}`;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ── Presets ───────────────────────────────────────────────────────────────────
interface Preset {
  id: "conservative" | "balanced" | "aggressive";
  label: string;
  tagline: string;
  icon: React.ElementType;
  maxLosses: number;
  tpPct: number;
  slPct: number;
  multiplier: number;
  method: "instant" | "split";
  tradesPerSession: number;
}
const PRESETS: Preset[] = [
  {
    id: "conservative", label: "Conservative", tagline: "Sleep at night",
    icon: Shield, maxLosses: 3, tpPct: 5, slPct: 15,
    multiplier: 1.5, method: "split", tradesPerSession: 20,
  },
  {
    id: "balanced", label: "Balanced", tagline: "Steady growth",
    icon: Gauge, maxLosses: 5, tpPct: 10, slPct: 30,
    multiplier: 1.62, method: "instant", tradesPerSession: 30,
  },
  {
    id: "aggressive", label: "Aggressive", tagline: "Max upside",
    icon: Flame, maxLosses: 8, tpPct: 20, slPct: 50,
    multiplier: 2.0, method: "instant", tradesPerSession: 50,
  },
];

// ── Tiny primitives ───────────────────────────────────────────────────────────
function GlassCard({ children, className = "", glow = false }: {
  children: React.ReactNode; className?: string; glow?: boolean;
}) {
  return (
    <div
      className={`relative rounded-2xl border border-white/10 bg-[#0b1220]/70 backdrop-blur-sm overflow-hidden ${glow ? "shadow-[0_0_40px_rgba(34,211,238,0.08)]" : ""} ${className}`}
    >
      {/* top gradient hairline */}
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/40 to-transparent pointer-events-none" />
      {children}
    </div>
  );
}

function CardTitle({ icon: Icon, title, sub, accent = "text-cyan-400" }: {
  icon: React.ElementType; title: string; sub?: string; accent?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className={`w-8 h-8 rounded-xl bg-gradient-to-br from-cyan-500/20 to-blue-600/10 border border-cyan-400/20 flex items-center justify-center flex-shrink-0`}>
        <Icon className={`w-4 h-4 ${accent}`} />
      </div>
      <div className="min-w-0">
        <div className="text-sm font-bold tracking-wide text-white">{title}</div>
        {sub && <div className="text-[11px] text-muted-foreground truncate">{sub}</div>}
      </div>
    </div>
  );
}

/** Tactile +/- stepper input */
function Stepper({
  value, onChange, min = 0, max = Infinity, step = 1, prefix, suffix, decimals = 2, disabled,
}: {
  value: number; onChange: (v: number) => void;
  min?: number; max?: number; step?: number;
  prefix?: string; suffix?: string; decimals?: number; disabled?: boolean;
}) {
  const set = (v: number) => onChange(clamp(parseFloat(v.toFixed(decimals)), min, max));
  return (
    <div className={`flex items-center gap-1 rounded-xl border border-white/10 bg-black/30 p-1 ${disabled ? "opacity-50 pointer-events-none" : ""}`}>
      <button
        type="button"
        onClick={() => set(value - step)}
        className="w-6 h-6 rounded-lg bg-white/5 hover:bg-white/15 text-muted-foreground hover:text-white flex items-center justify-center transition-colors flex-shrink-0"
        aria-label="decrease"
      >
        <Minus className="w-3 h-3" />
      </button>
      <div className="flex items-center justify-center gap-0.5 min-w-[4.5rem] px-1">
        {prefix && <span className="text-[11px] text-muted-foreground">{prefix}</span>}
        <Input
          type="number" value={value} min={min} max={max} step={step} disabled={disabled}
          onChange={(e) => set(Number(e.target.value))}
          className="h-6 w-14 px-1 text-right font-mono text-sm bg-transparent border-0 focus:ring-0 focus-visible:ring-0 shadow-none"
        />
        {suffix && <span className="text-[11px] text-muted-foreground">{suffix}</span>}
      </div>
      <button
        type="button"
        onClick={() => set(value + step)}
        className="w-6 h-6 rounded-lg bg-white/5 hover:bg-white/15 text-muted-foreground hover:text-white flex items-center justify-center transition-colors flex-shrink-0"
        aria-label="increase"
      >
        <Plus className="w-3 h-3" />
      </button>
    </div>
  );
}

function FieldRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-3 border-b border-white/5 last:border-0">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-white/90 truncate">{label}</div>
        {hint && <div className="text-[11px] text-muted-foreground/80 truncate">{hint}</div>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

/** Animated stat tile */
function StatTile({ label, value, sub, color = "text-white", icon: Icon, delay = 0 }: {
  label: string; value: string; sub?: string; color?: string;
  icon: React.ElementType; delay?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.3 }}
      className="rounded-xl border border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent p-3 hover:border-cyan-400/30 transition-colors"
    >
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon className="w-3 h-3 text-muted-foreground" />
        <div className="text-[9px] text-muted-foreground uppercase tracking-widest font-semibold">{label}</div>
      </div>
      <div className={`text-lg font-bold tabular-nums leading-none ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground mt-1">{sub}</div>}
    </motion.div>
  );
}

// ── Risk gauge (gradient donut) ───────────────────────────────────────────────
function RiskGauge({ score, color, label }: { score: number; color: string; label: string }) {
  const r = 44, circ = 2 * Math.PI * r;
  const offset = circ - (score / 100) * circ;
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative">
        <svg width="128" height="128" viewBox="0 0 128 128">
          <defs>
            <linearGradient id="gaugeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor={color} />
              <stop offset="100%" stopColor="#22d3ee" />
            </linearGradient>
          </defs>
          {/* track */}
          <circle cx="64" cy="64" r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="12" />
          {/* value arc with glow */}
          <circle
            cx="64" cy="64" r={r} fill="none"
            stroke="url(#gaugeGrad)" strokeWidth="12" strokeLinecap="round"
            strokeDasharray={circ} strokeDashoffset={offset}
            transform="rotate(-90 64 64)"
            style={{
              transition: "stroke-dashoffset 0.7s cubic-bezier(0.22,1,0.36,1), stroke 0.4s ease",
              filter: `drop-shadow(0 0 10px ${color}66)`,
            }}
          />
          {/* tick dots at key positions */}
          {[0, 25, 50, 75, 100].map((t) => {
            const ang = ((t / 100) * 2 * Math.PI) - Math.PI / 2;
            const x = 64 + (r - 4) * Math.cos(ang);
            const y = 64 + (r - 4) * Math.sin(ang);
            return <circle key={t} cx={x} cy={y} r="1.6" fill={t <= score ? color : "rgba(255,255,255,0.15)"} />;
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <motion.div
            key={score}
            initial={{ scale: 0.7, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
            className="text-4xl font-black tabular-nums leading-none tracking-tight"
            style={{ color }}
          >
            {score}
          </motion.div>
          <div className="text-[9px] text-muted-foreground uppercase tracking-[0.2em] mt-1">safety</div>
        </div>
      </div>
      <div
        className="text-[11px] font-bold uppercase tracking-widest px-3 py-1 rounded-full"
        style={{ color, backgroundColor: `${color}1a`, border: `1px solid ${color}40`, boxShadow: `0 0 16px ${color}22` }}
      >
        {label}
      </div>
    </div>
  );
}

// ── Contract picker (segmented) ───────────────────────────────────────────────
const CONTRACT_GROUPS: { group: string; options: { value: ContractType; label: string; emoji?: string }[] }[] = [
  { group: "Direction", options: [{ value: "CALL", label: "Rise" }, { value: "PUT", label: "Fall" }] },
  { group: "Parity", options: [{ value: "DIGITEVEN", label: "Even" }, { value: "DIGITODD", label: "Odd" }] },
  { group: "Over / Under", options: [{ value: "DIGITOVER", label: "Over" }, { value: "DIGITUNDER", label: "Under" }] },
  { group: "Match / Diff", options: [{ value: "DIGITMATCH", label: "Matches" }, { value: "DIGITDIFF", label: "Differs" }] },
];

function ContractPicker({
  type, barrier, onTypeChange, onBarrierChange, accent = "cyan",
}: {
  type: ContractType; barrier: number;
  onTypeChange: (t: ContractType) => void;
  onBarrierChange: (b: number) => void;
  accent?: "cyan" | "violet";
}) {
  const showBarrier = type === "DIGITOVER" || type === "DIGITUNDER";
  const barriers =
    type === "DIGITOVER"
      ? Object.keys(OVER_PAYOUTS).map(Number).sort((a, b) => a - b)
      : Object.keys(UNDER_PAYOUTS).map(Number).sort((a, b) => b - a);
  const payout  = getPayout(type, barrier);
  const winProb = getWinProb(type, barrier);
  const ev      = winProb * (payout - 1) - (1 - winProb);
  const accentCls = accent === "cyan"
    ? "data-[on=true]:border-cyan-400/50 data-[on=true]:bg-cyan-400/10 data-[on=true]:text-cyan-300"
    : "data-[on=true]:border-violet-400/50 data-[on=true]:bg-violet-400/10 data-[on=true]:text-violet-300";

  return (
    <div className="space-y-3">
      {/* segmented contract type chips */}
      <div className="space-y-2">
        {CONTRACT_GROUPS.map((g) => (
          <div key={g.group}>
            <div className="text-[9px] uppercase tracking-widest text-muted-foreground/70 mb-1">{g.group}</div>
            <div className="grid grid-cols-2 gap-1.5">
              {g.options.map((o) => {
                const active = type === o.value;
                return (
                  <button
                    key={o.value}
                    data-on={active}
                    onClick={() => onTypeChange(o.value)}
                    className={`px-2.5 py-1.5 rounded-lg border border-white/10 bg-white/[0.03] text-muted-foreground hover:text-white hover:border-white/25 transition-all text-xs font-medium ${accentCls} ${active ? "shadow-[0_0_12px_rgba(34,211,238,0.12)]" : ""}`}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* barrier + payout chips */}
      <div className="flex items-center gap-2 flex-wrap">
        {showBarrier ? (
          <div className="flex items-center gap-1.5 flex-wrap">
            {barriers.map((b) => {
              const p = type === "DIGITOVER" ? OVER_PAYOUTS[b] : UNDER_PAYOUTS[b];
              const active = b === barrier;
              return (
                <button
                  key={b}
                  data-on={active}
                  onClick={() => onBarrierChange(b)}
                  className={`px-2 py-1 rounded-lg border text-[11px] font-mono transition-all ${accentCls} ${
                    active
                      ? "shadow-[0_0_10px_rgba(34,211,238,0.15)]"
                      : "border-white/10 bg-white/[0.03] text-muted-foreground hover:text-white"
                  }`}
                >
                  {type === "DIGITOVER" ? ">" : "<"} {b}
                  <span className="opacity-60"> · {p}×</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="text-[10px] text-muted-foreground/70">No barrier needed for this contract</div>
        )}
      </div>

      {/* stats chips */}
      <div className="flex gap-2 flex-wrap text-[11px]">
        <span className="bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 px-2 py-0.5 rounded-md font-medium">
          {pct(winProb)} win
        </span>
        <span className="bg-white/5 text-muted-foreground border border-white/10 px-2 py-0.5 rounded-md font-mono">
          {payout}× payout
        </span>
        <span
          className={`px-2 py-0.5 rounded-md font-mono font-semibold border ${
            ev >= 0
              ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/25"
              : "bg-rose-500/10 text-rose-300 border-rose-500/25"
          }`}
        >
          EV {ev >= 0 ? "+" : ""}{fmt(ev, 3)}
        </span>
      </div>
    </div>
  );
}

// ── Ladder runway (visual) ────────────────────────────────────────────────────
function LadderRunway({ ladder, totalCost, balance }: {
  ladder: number[]; totalCost: number; balance: number;
}) {
  const maxStake = Math.max(...ladder);
  return (
    <div className="space-y-1.5">
      {ladder.map((stake, i) => {
        const cumulative = ladder.slice(0, i + 1).reduce((a, b) => a + b, 0);
        const intensity = stake / maxStake;
        const width = 18 + intensity * 82; // % width
        const color =
          intensity > 0.7 ? "#fb7185" :
          intensity > 0.4 ? "#fb923c" :
          intensity > 0.2 ? "#facc15" : "#34d399";
        return (
          <div key={i} className="flex items-center gap-2">
            <div className="w-9 text-[10px] font-mono text-muted-foreground flex-shrink-0">
              {i === 0 ? <span className="text-cyan-400 font-semibold">BASE</span> : `L${i}`}
            </div>
            <div className="flex-1 h-5 rounded-md bg-white/[0.04] overflow-hidden relative">
              <motion.div
                className="h-full rounded-md"
                style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}44` }}
                initial={{ width: 0 }}
                animate={{ width: `${width}%` }}
                transition={{ duration: 0.45, delay: i * 0.05, ease: "easeOut" }}
              />
              <div className="absolute inset-0 flex items-center justify-between px-2">
                <span className="text-[10px] text-white/70 font-mono">{usd(stake)}</span>
                <span className="text-[9px] text-white/50 font-mono">{fmt((cumulative / balance) * 100, 1)}% bal</span>
              </div>
            </div>
          </div>
        );
      })}
      {/* Total */}
      <div className="flex items-center gap-2 pt-1.5">
        <div className="w-9 text-[10px] font-mono text-muted-foreground flex-shrink-0">Σ</div>
        <div className="flex-1 h-6 rounded-lg bg-gradient-to-r from-cyan-500/20 to-blue-600/20 border border-cyan-400/30 flex items-center justify-between px-3">
          <span className="text-[10px] uppercase tracking-widest text-cyan-300 font-semibold">Total at risk</span>
          <span className="text-xs font-mono font-bold text-cyan-200">
            {usd(totalCost)} <span className="text-cyan-400/60">· {fmt((totalCost / balance) * 100, 1)}%</span>
          </span>
        </div>
      </div>
    </div>
  );
}

// ── TP / SL tiles ─────────────────────────────────────────────────────────────
function TargetTile({
  kind, value, pctOf, sub, ok, okText, badText, icon: Icon, delay,
}: {
  kind: "tp" | "sl";
  value: number; pctOf: number; sub: string;
  ok?: boolean; okText?: string; badText?: string;
  icon: React.ElementType; delay: number;
}) {
  const tp = kind === "tp";
  const grad = tp
    ? "from-emerald-500/15 to-teal-600/5 border-emerald-500/25"
    : "from-rose-500/15 to-red-600/5 border-rose-500/25";
  const text = tp ? "text-emerald-300" : "text-rose-300";
  const glow = tp ? "0 0 24px rgba(16,185,129,0.15)" : "0 0 24px rgba(244,63,94,0.15)";
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.35 }}
      className={`relative rounded-2xl border bg-gradient-to-b p-4 overflow-hidden ${grad}`}
      style={{ boxShadow: glow }}
    >
      <div className="absolute -top-6 -right-6 w-24 h-24 rounded-full bg-white/[0.03] pointer-events-none" />
      <div className="flex items-center gap-1.5 mb-2">
        <Icon className={`w-3.5 h-3.5 ${text}`} />
        <span className={`text-[10px] uppercase tracking-widest font-semibold ${text}`}>
          {tp ? "Take Profit" : "Stop Loss"}
        </span>
      </div>
      <div className={`text-3xl font-black tabular-nums leading-none ${text}`}>{usd(value)}</div>
      <div className="text-[11px] text-muted-foreground mt-1.5">{pctOf}% of balance · {sub}</div>
      {(ok !== undefined) && (
        <div className={`mt-2 inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-md ${
          ok ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300"
        }`}>
          {ok ? <CheckCircle2 className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
          {ok ? (okText ?? "Covers full ladder") : (badText ?? "Exceeds ladder")}
        </div>
      )}
    </motion.div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function RiskCalculator() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  // Live account balance + settings
  const { data: account } = useGetAccount({} as any);
  const { data: settings } = useGetSettings();
  const liveBalance = account?.balance ? parseFloat(String(account.balance)) : null;
  const applySettings = useUpdateSettings();

  // Inputs
  const [autoBalance,        setAutoBalance]        = useState(true);
  const [balance,            setBalance]            = useState(500);
  const [baseStake,          setBaseStake]          = useState(1);
  const [maxLosses,          setMaxLosses]          = useState(5);
  const [tradesPerSession,   setTradesPerSession]   = useState(30);
  const [primaryType,        setPrimaryType]        = useState<ContractType>("DIGITDIFF");
  const [primaryBarrier,     setPrimaryBarrier]     = useState(5);
  const [recoveryType,       setRecoveryType]       = useState<ContractType>("DIGITMATCH");
  const [recoveryBarrier,    setRecoveryBarrier]    = useState(5);
  const [recoveryMethod,     setRecoveryMethod]     = useState<"instant" | "split">("instant");
  const [recoveryMultiplier, setRecoveryMultiplier] = useState(1.62);
  const [showLadder,         setShowLadder]         = useState(true);
  const [tpPct,              setTpPct]              = useState(DEFAULT_TP_PCT * 100);  // shown as %
  const [slPct,              setSlPct]              = useState(DEFAULT_SL_PCT * 100);
  const [activePreset,       setActivePreset]       = useState<string | null>(null);
  const [copied,             setCopied]             = useState(false);

  // Sync live balance
  useEffect(() => {
    if (autoBalance && liveBalance && liveBalance > 0) {
      setBalance(parseFloat(liveBalance.toFixed(2)));
    }
  }, [autoBalance, liveBalance]);

  // Derived payouts / probs
  const primaryPayout  = getPayout(primaryType, primaryBarrier);
  const primaryWinProb = getWinProb(primaryType, primaryBarrier);
  const recoveryPayout = getPayout(recoveryType, recoveryBarrier);

  // Balance-based targets
  const targetTP = parseFloat(((tpPct / 100) * balance).toFixed(2));
  const targetSL = parseFloat(((slPct / 100) * balance).toFixed(2));

  // Suggested stake + which constraint binds
  const breakdown = useMemo(() => suggestedStakeBreakdown(
    balance, slPct / 100, recoveryMethod, recoveryPayout, recoveryMultiplier,
    maxLosses, primaryPayout, primaryWinProb, tpPct / 100,
  ), [balance, slPct, recoveryMethod, recoveryPayout, recoveryMultiplier,
      maxLosses, primaryPayout, primaryWinProb, tpPct]);
  const suggestedStake = breakdown.suggested;

  // Full risk calculation
  const result = useMemo(() => calcRisk({
    baseStake, balance, primaryPayout, primaryWinProb, recoveryPayout,
    maxLosses, recoveryMethod, recoveryMultiplier, tradesPerSession,
  }), [baseStake, balance, primaryPayout, primaryWinProb, recoveryPayout,
      maxLosses, recoveryMethod, recoveryMultiplier, tradesPerSession]);

  const stakeAsPct = balance > 0 ? (baseStake / balance) * 100 : 0;
  const slOk = result.totalLadderCost * 1.1 <= targetSL;
  const stakeAtMin = baseStake <= MIN_STAKE + 0.005;

  // ── Preset application ────────────────────────────────────────────────────
  const applyPreset = (p: Preset) => {
    setActivePreset(p.id);
    setMaxLosses(p.maxLosses);
    setTpPct(p.tpPct);
    setSlPct(p.slPct);
    setRecoveryMultiplier(p.multiplier);
    setRecoveryMethod(p.method);
    setTradesPerSession(p.tradesPerSession);
    toast.success(`${p.label} preset applied`, { duration: 1800 });
  };

  // ── Apply to settings (real persistence) ──────────────────────────────────
  const handleApply = () => {
    applySettings.mutate({
      data: {
        riskAmountValue: suggestedStake,
        maxTradeStake: suggestedStake,
        dailyTarget: targetTP,
        dailyLossLimit: targetSL,
        maxRecoverySteps: maxLosses,
        consecutiveLossLimit: maxLosses,
        recoveryMethod,
        ...(recoveryMethod === "split" ? { recoveryMultiplier } : {}),
      } as any,
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries();
        toast.success("Applied to Settings — NeuroAI & engine will use these values", { duration: 3500 });
      },
      onError: (err: any) => {
        toast.error(err?.error ?? "Failed to apply settings");
      },
    });
  };

  // ── Copy plan ─────────────────────────────────────────────────────────────
  const handleCopy = async () => {
    const plan = [
      "⚡ NeuroTrade Risk Plan",
      `Contract: ${primaryType}${showBarrierLabel(primaryType) ? ` barrier ${primaryBarrier}` : ""} · ${primaryPayout}× payout`,
      `Recovery: ${recoveryType}${showBarrierLabel(recoveryType) ? ` barrier ${recoveryBarrier}` : ""} (${recoveryMethod})`,
      `Base stake: $${suggestedStake.toFixed(2)} (${((suggestedStake / Math.max(balance, 1)) * 100).toFixed(2)}% of balance)`,
      `Daily TP: $${targetTP.toFixed(2)} · Daily SL: $${targetSL.toFixed(2)}`,
      `Max losses: ${maxLosses} · Ladder cost: $${result.totalLadderCost.toFixed(2)}`,
      `Safety score: ${result.riskScore}/100 (${result.riskLabel})`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(plan);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Could not copy — clipboard unavailable");
    }
  };

  const handleReset = () => {
    setActivePreset(null);
    setMaxLosses(5);
    setTpPct(DEFAULT_TP_PCT * 100);
    setSlPct(DEFAULT_SL_PCT * 100);
    setRecoveryMultiplier(1.62);
    setRecoveryMethod("instant");
    setTradesPerSession(30);
    setPrimaryType("DIGITDIFF");
    setPrimaryBarrier(5);
    setRecoveryType("DIGITMATCH");
    setRecoveryBarrier(5);
    setBaseStake(1);
    toast.success("Reset to defaults", { duration: 1500 });
  };

  const bindingInfo: Record<string, { text: string; tone: string }> = {
    "stop-loss":    { text: "Stop-loss budget caps the stake — raise SL % or cut max losses to size up.", tone: "text-amber-300" },
    "take-profit":  { text: "Stake sized to realistically reach your TP target within a session.", tone: "text-cyan-300" },
    "balance-cap":  { text: "1% balance cap is the tightest limit — the safest default.", tone: "text-emerald-300" },
    "minimum":      { text: "Deriv's $0.35 minimum — balance is too small for this ladder.", tone: "text-rose-300" },
  };
  const binding = bindingInfo[breakdown.binding];

  return (
    <div className="min-h-full relative">
      {/* ambient background glows */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden z-0">
        <div className="absolute -top-32 -left-32 w-96 h-96 rounded-full bg-cyan-500/[0.07] blur-3xl" />
        <div className="absolute top-1/3 -right-32 w-96 h-96 rounded-full bg-blue-600/[0.06] blur-3xl" />
        <div className="absolute bottom-0 left-1/3 w-96 h-96 rounded-full bg-violet-600/[0.05] blur-3xl" />
      </div>

      <div className="relative z-10">
        {/* ── Sticky header ── */}
        <div className="sticky top-0 z-20 bg-background/80 backdrop-blur-xl border-b border-white/10 px-4 md:px-6 py-3 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-cyan-400 to-blue-600 shadow-[0_0_20px_rgba(34,211,238,0.35)] flex items-center justify-center flex-shrink-0">
            <Calculator className="w-4.5 h-4.5 text-black" />
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-bold tracking-tight leading-tight">Risk Calculator</h1>
            <p className="text-[11px] text-muted-foreground hidden sm:block">
              Size every trade so a losing streak can never hurt you
            </p>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {/* live balance chip */}
            <div className={`hidden sm:flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-mono ${
              liveBalance
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                : "border-white/10 bg-white/[0.03] text-muted-foreground"
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${liveBalance ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]" : "bg-muted-foreground"}`} />
              {liveBalance ? usd(liveBalance) : "No account"}
            </div>
            <Button
              variant="outline" size="sm"
              className="gap-1.5 text-xs border-white/15 bg-white/[0.03] hover:bg-white/[0.08]"
              onClick={handleReset}
            >
              <RotateCcw className="w-3 h-3" /> Reset
            </Button>
          </div>
        </div>

        <div className="p-4 md:p-6">
          <div className="grid grid-cols-1 xl:grid-cols-[1fr_460px] gap-5 max-w-[1400px] mx-auto">

            {/* ══ LEFT COLUMN ══ */}
            <div className="space-y-4">

              {/* Presets */}
              <div className="grid grid-cols-3 gap-2">
                {PRESETS.map((p, i) => (
                  <motion.button
                    key={p.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.06 }}
                    data-on={activePreset === p.id}
                    onClick={() => applyPreset(p)}
                    className={`relative rounded-2xl border p-3 text-left transition-all overflow-hidden ${
                      activePreset === p.id
                        ? "border-cyan-400/50 bg-gradient-to-b from-cyan-400/15 to-transparent shadow-[0_0_24px_rgba(34,211,238,0.15)]"
                        : "border-white/10 bg-white/[0.03] hover:border-white/25 hover:bg-white/[0.05]"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <p.icon className={`w-4 h-4 ${activePreset === p.id ? "text-cyan-300" : "text-muted-foreground"}`} />
                      {activePreset === p.id && <CheckCircle2 className="w-3.5 h-3.5 text-cyan-300" />}
                    </div>
                    <div className="text-xs font-bold text-white">{p.label}</div>
                    <div className="text-[10px] text-muted-foreground">{p.tagline}</div>
                  </motion.button>
                ))}
              </div>

              {/* Account & Stake ─────────────────────────────────────── */}
              <GlassCard glow>
                <div className="p-4 pb-1">
                  <CardTitle icon={Wallet} title="Account & Stake" sub="Your exposure starts here" />
                </div>
                <div className="px-4 pb-2">
                  {/* Balance */}
                  <div className="flex items-center justify-between gap-3 py-3 border-b border-white/5">
                    <div>
                      <div className="text-[13px] font-medium text-white/90">Account Balance</div>
                      <div className="text-[11px] text-muted-foreground">
                        {liveBalance ? (
                          <span className="flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]" />
                            Live: {usd(liveBalance)}
                          </span>
                        ) : (
                          <span>No account connected — manual balance</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5">
                        {autoBalance && liveBalance
                          ? <Lock className="w-3 h-3 text-cyan-400" />
                          : <Unlock className="w-3 h-3 text-muted-foreground" />}
                        <Switch
                          checked={autoBalance && !!liveBalance}
                          disabled={!liveBalance}
                          onCheckedChange={setAutoBalance}
                          className="scale-75 data-[state=checked]:bg-cyan-500"
                        />
                      </div>
                      <Stepper value={balance} onChange={setBalance} min={1} step={10} prefix="$" decimals={0} disabled={autoBalance && !!liveBalance} />
                    </div>
                  </div>

                  {/* Base stake */}
                  <div className="flex items-center justify-between gap-3 py-3 border-b border-white/5">
                    <div>
                      <div className="text-[13px] font-medium text-white/90">Base Stake</div>
                      <div className="text-[11px] text-muted-foreground">{fmt(stakeAsPct, 2)}% of balance</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {Math.abs(baseStake - suggestedStake) > 0.01 && (
                        <motion.button
                          initial={{ opacity: 0, scale: 0.9 }}
                          animate={{ opacity: 1, scale: 1 }}
                          onClick={() => setBaseStake(suggestedStake)}
                          className="text-[10px] flex items-center gap-1 px-2 py-1 rounded-lg bg-gradient-to-r from-cyan-500/20 to-blue-600/20 text-cyan-300 border border-cyan-400/30 hover:from-cyan-500/30 hover:to-blue-600/30 transition-all"
                        >
                          <Sparkles className="w-2.5 h-2.5" />
                          {usd(suggestedStake)}
                        </motion.button>
                      )}
                      <Stepper value={baseStake} onChange={setBaseStake} min={MIN_STAKE} step={0.5} prefix="$" />
                    </div>
                  </div>

                  <FieldRow label="Max Consecutive Losses" hint="Your loss limit — where you stop & reassess">
                    <Stepper value={maxLosses} onChange={setMaxLosses} min={1} max={15} step={1} decimals={0} />
                  </FieldRow>
                  <FieldRow label="Trades per Session" hint="Used to compute streak probability">
                    <Stepper value={tradesPerSession} onChange={setTradesPerSession} min={5} max={200} step={5} decimals={0} />
                  </FieldRow>
                </div>
              </GlassCard>

              {/* Session Targets ─────────────────────────────────────── */}
              <GlassCard>
                <div className="p-4 pb-1">
                  <CardTitle icon={Target} title="Daily TP / SL Targets" sub="Balance-based guardrails" />
                </div>
                <div className="px-4 pb-4">
                  <FieldRow label="Take Profit %" hint={`Target = ${usd(targetTP)}`}>
                    <Stepper value={tpPct} onChange={setTpPct} min={1} max={100} step={1} suffix="%" decimals={0} />
                  </FieldRow>
                  <FieldRow label="Stop Loss %" hint={`Limit = ${usd(targetSL)}`}>
                    <Stepper value={slPct} onChange={setSlPct} min={1} max={100} step={1} suffix="%" decimals={0} />
                  </FieldRow>
                  <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-[11px] text-muted-foreground leading-relaxed">
                    <Info className="w-3 h-3 inline mr-1.5 text-cyan-400" />
                    Defaults: <span className="text-emerald-300 font-semibold">TP 10%</span> · <span className="text-rose-300 font-semibold">SL 30%</span> of balance.
                    SL is larger than TP by design — one losing streak can outweigh many small wins.
                  </div>
                </div>
              </GlassCard>

              {/* Normal Contract ────────────────────────────────────── */}
              <GlassCard>
                <div className="p-4 pb-1">
                  <CardTitle icon={TrendingUp} title="Normal Mode Contract" sub="Your main entry" />
                </div>
                <div className="px-4 pb-4">
                  <ContractPicker
                    type={primaryType} barrier={primaryBarrier}
                    onTypeChange={setPrimaryType} onBarrierChange={setPrimaryBarrier}
                  />
                  <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-[11px] text-muted-foreground">
                    <Info className="w-3 h-3 inline mr-1.5 text-cyan-400" />
                    Break-even: <span className="text-white font-semibold">{pct(result.breakevenWinRate)}</span>
                    <span className="mx-1.5 opacity-40">·</span>
                    EV/trade:{" "}
                    <span className={result.evPerTrade >= 0 ? "text-emerald-300 font-semibold" : "text-rose-300 font-semibold"}>
                      {result.evPerTrade >= 0 ? "+" : ""}{fmt(result.evPerTrade * 100, 2)}¢ / $1
                    </span>
                  </div>
                </div>
              </GlassCard>

              {/* Recovery ───────────────────────────────────────────── */}
              <GlassCard>
                <div className="p-4 pb-1">
                  <CardTitle icon={RefreshCw} title="Recovery Mode Contract" sub="The safety net that recovers losses" accent="text-violet-400" />
                </div>
                <div className="px-4 pb-4 space-y-4">
                  <ContractPicker
                    type={recoveryType} barrier={recoveryBarrier}
                    onTypeChange={setRecoveryType} onBarrierChange={setRecoveryBarrier}
                    accent="violet"
                  />

                  {/* Method toggle */}
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold mb-2">Recovery Method</div>
                    <div className="grid grid-cols-2 gap-2">
                      {(["instant", "split"] as const).map((m) => (
                        <button
                          key={m}
                          data-on={recoveryMethod === m}
                          onClick={() => setRecoveryMethod(m)}
                          className={`flex items-center gap-2.5 p-3 rounded-xl border transition-all ${
                            recoveryMethod === m
                              ? "border-violet-400/50 bg-violet-400/10 shadow-[0_0_16px_rgba(167,139,250,0.15)]"
                              : "border-white/10 bg-white/[0.03] hover:border-white/25"
                          }`}
                        >
                          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${recoveryMethod === m ? "bg-violet-400/20 text-violet-300" : "bg-white/5 text-muted-foreground"}`}>
                            {m === "instant" ? <Zap className="w-4 h-4" /> : <GitBranch className="w-4 h-4" />}
                          </div>
                          <div className="text-left">
                            <div className={`text-xs font-bold ${recoveryMethod === m ? "text-violet-300" : "text-white/90"}`}>
                              {m === "instant" ? "Instant" : "Split"}
                            </div>
                            <div className="text-[10px] text-muted-foreground">
                              {m === "instant" ? "One trade recovers all" : "Progressive steps"}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                    {recoveryMethod === "split" && (
                      <div className="mt-3">
                        <FieldRow label="Recovery Multiplier" hint="Stake multiplier per step">
                          <Stepper value={recoveryMultiplier} onChange={setRecoveryMultiplier} min={1.1} max={5} step={0.1} suffix="×" decimals={1} />
                        </FieldRow>
                      </div>
                    )}
                  </div>

                  <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-[11px] text-muted-foreground">
                    <Info className="w-3 h-3 inline mr-1.5 text-violet-400" />
                    {recoveryMethod === "instant"
                      ? "One winning trade covers all losses + base profit."
                      : "Losses spread over multiple increasing-stake trades."}
                    <span className="mx-1.5 opacity-40">·</span>
                    Net after full cycle: <span className="text-emerald-300 font-semibold">+{usd(result.netAfterRecovery)}</span>
                  </div>
                </div>
              </GlassCard>
            </div>

            {/* ══ RIGHT COLUMN: Results ══ */}
            <div className="space-y-4">

              {/* Hero: recommendation ───────────────────────────────── */}
              <GlassCard glow>
                <div className="p-5">
                  <div className="flex items-start gap-4">
                    <RiskGauge score={result.riskScore} color={result.riskColor} label={result.riskLabel} />

                    <div className="flex-1 space-y-3 pt-0.5 min-w-0">
                      <div className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">
                        Recommended Setup
                      </div>

                      {/* Stake hero */}
                      <div className="relative rounded-xl border border-cyan-400/25 bg-gradient-to-br from-cyan-500/10 to-blue-600/5 p-3 overflow-hidden">
                        <div className="absolute -right-4 -top-4 w-20 h-20 rounded-full bg-cyan-400/10 blur-xl pointer-events-none" />
                        <div className="text-[9px] uppercase tracking-widest text-cyan-400/80 mb-0.5">Stake per trade</div>
                        <div className="flex items-end gap-2">
                          <span className="text-3xl font-black tabular-nums text-cyan-300 leading-none drop-shadow-[0_0_12px_rgba(34,211,238,0.35)]">
                            {usd(suggestedStake)}
                          </span>
                          <span className="text-[11px] text-muted-foreground mb-0.5">
                            {fmt((suggestedStake / Math.max(balance, 1)) * 100, 2)}% of balance
                          </span>
                        </div>
                        {stakeAtMin && (
                          <div className="text-[10px] text-amber-300 mt-1.5 flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3" /> Deriv minimum — balance too small for this ladder
                          </div>
                        )}
                      </div>

                      {/* binding constraint */}
                      <div className={`rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 text-[10px] leading-relaxed ${binding.tone}`}>
                        <Gauge className="w-3 h-3 inline mr-1 -mt-0.5" />
                        <span className="font-semibold uppercase tracking-wider text-muted-foreground mr-1">Why this stake:</span>
                        {binding.text}
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <StatTile
                          label="Balance covers" delay={0.1}
                          value={`${result.balanceCoverage >= 100 ? "99+" : fmt(result.balanceCoverage, 1)}×`}
                          sub="full recovery cycles"
                          icon={Wallet}
                          color={result.balanceCoverage < 2 ? "text-rose-400" : result.balanceCoverage < 4 ? "text-amber-300" : "text-emerald-300"}
                        />
                        <StatTile
                          label="Session risk" delay={0.16}
                          value={pct(result.streakProbSession)}
                          sub={`${tradesPerSession}-trade session`}
                          icon={ShieldAlert}
                          color={result.streakProbSession > 0.5 ? "text-rose-400" : result.streakProbSession > 0.25 ? "text-amber-300" : "text-emerald-300"}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </GlassCard>

              {/* TP / SL ────────────────────────────────────────────── */}
              <GlassCard>
                <div className="p-4 pb-1">
                  <CardTitle icon={Shield} title="Daily Targets" sub="Guardrails for the session" />
                </div>
                <div className="px-4 py-3">
                  <div className="grid grid-cols-2 gap-3">
                    <TargetTile
                      kind="tp" value={targetTP} pctOf={tpPct}
                      sub={`≈ ${fmt(targetTP / Math.max(baseStake * (primaryPayout - 1), 0.001), 0)} winning trades`}
                      icon={TrendingUp} delay={0.05}
                    />
                    <TargetTile
                      kind="sl" value={targetSL} pctOf={slPct}
                      sub={slOk ? "Covers full recovery ladder" : "Ladder exceeds this SL"}
                      ok={slOk} okText="Ladder covered ✓" badText="⚠ Ladder exceeds SL"
                      icon={TrendingDown} delay={0.1}
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-2 mt-3">
                    <StatTile label="SL : TP" value={`${fmt(targetSL / Math.max(targetTP, 0.01), 1)}:1`} sub="binary norm > 2:1" icon={Layers} delay={0.15} />
                    <StatTile label="Cycle profit" value={`+${usd(result.netAfterRecovery)}`} sub="per full cycle" icon={Crown} delay={0.2} color="text-emerald-300" />
                    <StatTile
                      label="Min balance" value={usd(result.totalLadderCost * 3)} sub="3× ladder cost"
                      icon={DollarSign} delay={0.25}
                      color={balance < result.totalLadderCost * 3 ? "text-rose-400" : "text-white"}
                    />
                  </div>
                </div>
              </GlassCard>

              {/* Streak survival ────────────────────────────────────── */}
              <GlassCard>
                <div className="p-4 pb-1">
                  <CardTitle icon={BarChart3} title="Streak Survival" sub="Chance of hitting your loss limit" />
                </div>
                <div className="px-4 py-3 space-y-3">
                  {[
                    { trades: tradesPerSession, prob: result.streakProbSession, label: `${tradesPerSession}-trade session` },
                    { trades: 50,              prob: result.streakProb50,      label: "50-trade session" },
                    { trades: 100,             prob: streakProbValue(primaryWinProb, maxLosses, 100), label: "100-trade session" },
                  ].map(({ label, prob }, i) => (
                    <div key={label}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[11px] text-muted-foreground">{label}</span>
                        <span className={`text-xs font-bold tabular-nums ${prob > 0.5 ? "text-rose-400" : prob > 0.25 ? "text-amber-300" : "text-emerald-300"}`}>
                          {pct(prob)}
                        </span>
                      </div>
                      <div className="h-2 bg-white/[0.05] rounded-full overflow-hidden">
                        <motion.div
                          className="h-full rounded-full"
                          style={{
                            background: `linear-gradient(90deg, ${
                              prob > 0.5 ? "#f43f5e" : prob > 0.25 ? "#f59e0b" : "#10b981"
                            }, ${
                              prob > 0.5 ? "#fb923c" : prob > 0.25 ? "#fbbf24" : "#34d399"
                            })`,
                            boxShadow: `0 0 8px ${
                              prob > 0.5 ? "rgba(244,63,94,0.4)" : prob > 0.25 ? "rgba(245,158,11,0.4)" : "rgba(16,185,129,0.4)"
                            }`,
                          }}
                          initial={{ width: 0 }}
                          animate={{ width: `${prob * 100}%` }}
                          transition={{ duration: 0.5, delay: i * 0.08, ease: "easeOut" }}
                        />
                      </div>
                    </div>
                  ))}
                  <div className="text-[10px] text-muted-foreground leading-relaxed pt-1">
                    Probability of <span className="text-white font-semibold">{maxLosses} consecutive losses</span> within N trades.
                    Keep below <span className="text-emerald-300 font-semibold">25%</span> for a safe strategy.
                  </div>
                </div>
              </GlassCard>

              {/* Recovery ladder ────────────────────────────────────── */}
              <GlassCard>
                <div className="p-4 pb-1">
                  <div className="flex items-center justify-between">
                    <CardTitle icon={GitBranch} title="Recovery Ladder" sub="Stake escalation per loss" accent="text-violet-400" />
                    <button
                      onClick={() => setShowLadder((s) => !s)}
                      className="text-[11px] text-muted-foreground hover:text-white flex items-center gap-1 transition-colors"
                    >
                      <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showLadder ? "rotate-180" : ""}`} />
                      {showLadder ? "Hide" : "Show"}
                    </button>
                  </div>
                </div>
                <AnimatePresence initial={false}>
                  {showLadder && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.25, ease: "easeInOut" }}
                      style={{ overflow: "hidden" }}
                    >
                      <div className="px-4 pb-4">
                        <LadderRunway ladder={result.ladder} totalCost={result.totalLadderCost} balance={balance} />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </GlassCard>

              {/* Warnings ───────────────────────────────────────────── */}
              <AnimatePresence>
                {result.warnings.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="rounded-2xl border border-amber-500/25 bg-gradient-to-b from-amber-500/[0.08] to-transparent p-4"
                  >
                    <div className="flex items-center gap-2 mb-2.5">
                      <div className="w-7 h-7 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center">
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                      </div>
                      <span className="text-[11px] font-bold uppercase tracking-widest text-amber-400">Risk Warnings</span>
                    </div>
                    <div className="space-y-2">
                      {result.warnings.map((w, i) => (
                        <motion.div
                          key={i}
                          initial={{ opacity: 0, x: -6 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: i * 0.06 }}
                          className="flex gap-2 text-[11px] text-amber-200/80 leading-relaxed"
                        >
                          <span className="text-amber-500 mt-0.5 flex-shrink-0">◆</span>
                          <span>{w}</span>
                        </motion.div>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Apply bar ──────────────────────────────────────────── */}
              <div className="rounded-2xl border border-cyan-400/25 bg-gradient-to-br from-cyan-500/10 to-blue-600/5 p-4 space-y-3">
                <div className="flex items-start gap-2 text-[11px] text-muted-foreground leading-relaxed">
                  <Info className="w-3.5 h-3.5 text-cyan-400 mt-0.5 flex-shrink-0" />
                  <span>
                    Push these values straight into the engine: stake <span className="text-cyan-300 font-semibold">{usd(suggestedStake)}</span>,
                    daily TP <span className="text-emerald-300 font-semibold">{usd(targetTP)}</span>,
                    daily SL <span className="text-rose-300 font-semibold">{usd(targetSL)}</span>,
                    max losses <span className="text-white font-semibold">{maxLosses}</span>. NeuroAI and the autonomous engine will use them immediately.
                  </span>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="flex-1 gap-1.5 text-xs bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-black font-semibold shadow-[0_0_16px_rgba(34,211,238,0.25)]"
                    onClick={handleApply}
                    disabled={applySettings.isPending}
                  >
                    {applySettings.isPending ? (
                      <RefreshCw className="w-3 h-3 animate-spin" />
                    ) : (
                      <Send className="w-3 h-3" />
                    )}
                    {applySettings.isPending ? "Applying…" : "Apply to Settings"}
                  </Button>
                  <Button
                    size="sm" variant="outline"
                    className="gap-1.5 text-xs border-white/15 bg-white/[0.03] hover:bg-white/[0.08]"
                    onClick={handleCopy}
                  >
                    {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    {copied ? "Copied" : "Copy Plan"}
                  </Button>
                  <Button
                    size="sm" variant="outline"
                    className="gap-1.5 text-xs border-white/15 bg-white/[0.03] hover:bg-white/[0.08]"
                    onClick={() => setLocation("/settings")}
                  >
                    <ArrowRight className="w-3 h-3" />
                    Settings
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// helper: does this contract use a barrier display?
function showBarrierLabel(type: ContractType): boolean {
  return type === "DIGITOVER" || type === "DIGITUNDER";
}

// thin wrapper so JSX can call the pure function without import collision
function streakProbValue(winP: number, streak: number, trades: number): number {
  return streakProb(winP, streak, trades);
}
