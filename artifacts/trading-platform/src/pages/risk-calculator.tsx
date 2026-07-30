import { useState, useMemo } from "react";
import { motion } from "framer-motion";
import { useLocation } from "wouter";
import {
  Calculator, TrendingUp, TrendingDown, ShieldAlert, Shield,
  AlertTriangle, Zap, GitBranch, Info, ChevronDown, Target,
  BarChart3, RefreshCw, ArrowRight, DollarSign,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  calcRisk, getPayout, getWinProb, streakProb,
  OVER_PAYOUTS, UNDER_PAYOUTS,
  type ContractType,
} from "@/lib/risk-math";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number, dec = 2) {
  return n.toFixed(dec);
}
function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}
function usd(n: number) {
  return `$${fmt(n)}`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHeader({ icon: Icon, title }: { icon: React.ElementType; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon className="w-4 h-4 text-primary" />
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</span>
    </div>
  );
}

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 border-b border-border/40 last:border-0">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

function NumField({
  value, onChange, min = 0, max, step = 1, prefix, suffix, width = "w-24",
}: {
  value: number; onChange: (v: number) => void;
  min?: number; max?: number; step?: number;
  prefix?: string; suffix?: string; width?: string;
}) {
  return (
    <div className="flex items-center gap-1">
      {prefix && <span className="text-xs text-muted-foreground">{prefix}</span>}
      <Input
        type="number" value={value} min={min} max={max} step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`${width} text-right font-mono text-sm bg-secondary/50`}
      />
      {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
    </div>
  );
}

// Circular risk score gauge
function RiskGauge({ score, color, label }: { score: number; color: string; label: string }) {
  const r = 42;
  const circ = 2 * Math.PI * r;
  const offset = circ - (score / 100) * circ;
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative flex items-center justify-center">
        <svg width="110" height="110" viewBox="0 0 110 110">
          <circle cx="55" cy="55" r={r} fill="none" stroke="#1e293b" strokeWidth="11" />
          <circle
            cx="55" cy="55" r={r} fill="none"
            stroke={color} strokeWidth="11" strokeLinecap="round"
            strokeDasharray={circ} strokeDashoffset={offset}
            transform="rotate(-90 55 55)"
            style={{ transition: "stroke-dashoffset 0.6s ease, stroke 0.4s ease" }}
          />
        </svg>
        <div className="absolute text-center">
          <div className="text-3xl font-bold tabular-nums leading-none" style={{ color }}>{score}</div>
          <div className="text-[9px] text-muted-foreground mt-0.5 uppercase tracking-widest">/ 100</div>
        </div>
      </div>
      <div
        className="text-xs font-bold uppercase tracking-widest px-3 py-0.5 rounded-full"
        style={{ color, backgroundColor: `${color}20`, border: `1px solid ${color}40` }}
      >
        {label}
      </div>
    </div>
  );
}

// Stat pill
function Stat({ label, value, sub, color = "text-foreground" }: {
  label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div className="bg-secondary/40 rounded-lg p-3 border border-border/50">
      <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-xl font-bold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

// Contract type selector with barrier sub-selector
const CONTRACT_OPTIONS = [
  { value: "CALL",       label: "Rise (CALL)",      group: "Direction" },
  { value: "PUT",        label: "Fall (PUT)",        group: "Direction" },
  { value: "DIGITEVEN",  label: "Even Digit",        group: "Parity" },
  { value: "DIGITODD",   label: "Odd Digit",         group: "Parity" },
  { value: "DIGITOVER",  label: "Over (Digit)",      group: "Over/Under" },
  { value: "DIGITUNDER", label: "Under (Digit)",     group: "Over/Under" },
  { value: "DIGITMATCH", label: "Matches (Digit)",   group: "Match/Diff" },
  { value: "DIGITDIFF",  label: "Differs (Digit)",   group: "Match/Diff" },
];

function ContractPicker({
  type, barrier, onTypeChange, onBarrierChange, label,
}: {
  type: ContractType; barrier: number;
  onTypeChange: (t: ContractType) => void;
  onBarrierChange: (b: number) => void;
  label: string;
}) {
  const showBarrier = type === "DIGITOVER" || type === "DIGITUNDER";
  const barriers = type === "DIGITOVER"
    ? Object.keys(OVER_PAYOUTS).map(Number).sort((a, b) => a - b)
    : Object.keys(UNDER_PAYOUTS).map(Number).sort((a, b) => b - a);

  const payout  = getPayout(type, barrier);
  const winProb = getWinProb(type, barrier);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Select value={type} onValueChange={(v) => onTypeChange(v as ContractType)}>
          <SelectTrigger className="flex-1 bg-secondary/50">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONTRACT_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {showBarrier && (
          <Select value={String(barrier)} onValueChange={(v) => onBarrierChange(Number(v))}>
            <SelectTrigger className="w-28 bg-secondary/50">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {barriers.map((b) => {
                const p = type === "DIGITOVER" ? OVER_PAYOUTS[b] : UNDER_PAYOUTS[b];
                return (
                  <SelectItem key={b} value={String(b)}>
                    {type === "DIGITOVER" ? `> ${b}` : `< ${b}`} ({p}×)
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        )}
      </div>
      <div className="flex gap-2 text-[11px]">
        <span className="bg-primary/10 text-primary border border-primary/20 px-2 py-0.5 rounded">
          {pct(winProb)} win
        </span>
        <span className="bg-secondary text-muted-foreground border border-border px-2 py-0.5 rounded">
          {payout}× payout
        </span>
        <span className="bg-secondary text-muted-foreground border border-border px-2 py-0.5 rounded">
          EV {fmt(winProb * (payout - 1) - (1 - winProb), 3)}
        </span>
      </div>
    </div>
  );
}

// Recovery ladder table
function LadderTable({ ladder, totalCost, balance }: {
  ladder: number[]; totalCost: number; balance: number;
}) {
  const maxStake = Math.max(...ladder);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border/50">
            <th className="text-left text-[10px] uppercase tracking-wider text-muted-foreground py-1.5 font-medium">Loss #</th>
            <th className="text-right text-[10px] uppercase tracking-wider text-muted-foreground py-1.5 font-medium">Stake</th>
            <th className="text-right text-[10px] uppercase tracking-wider text-muted-foreground py-1.5 font-medium">Cumulative</th>
            <th className="text-right text-[10px] uppercase tracking-wider text-muted-foreground py-1.5 font-medium">% Balance</th>
          </tr>
        </thead>
        <tbody>
          {ladder.map((stake, i) => {
            const cumulative = ladder.slice(0, i + 1).reduce((a, b) => a + b, 0);
            const pctBal = (cumulative / balance) * 100;
            const intensity = stake / maxStake;
            const stakeColor =
              intensity > 0.7 ? "text-red-400" :
              intensity > 0.4 ? "text-orange-400" :
              intensity > 0.2 ? "text-yellow-400" :
              "text-green-400";
            return (
              <tr key={i} className="border-b border-border/30 last:border-0">
                <td className="py-2 text-muted-foreground">
                  {i === 0 ? (
                    <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded">Base</span>
                  ) : (
                    <span className="font-mono">L{i}</span>
                  )}
                </td>
                <td className={`py-2 text-right font-mono font-semibold ${stakeColor}`}>
                  {usd(stake)}
                </td>
                <td className="py-2 text-right font-mono text-muted-foreground">
                  {usd(cumulative)}
                </td>
                <td className={`py-2 text-right font-mono text-xs ${pctBal > 40 ? "text-red-400" : pctBal > 20 ? "text-orange-400" : "text-muted-foreground"}`}>
                  {fmt(pctBal, 1)}%
                </td>
              </tr>
            );
          })}
          <tr className="border-t border-primary/30 bg-primary/5">
            <td className="py-2 text-xs font-semibold text-primary" colSpan={2}>Total at risk</td>
            <td className="py-2 text-right font-mono font-bold text-primary">{usd(totalCost)}</td>
            <td className="py-2 text-right font-mono text-xs text-primary">{fmt((totalCost / balance) * 100, 1)}%</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function RiskCalculator() {
  const [, setLocation] = useLocation();

  // ─ Inputs ─
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

  // ─ Derived ─
  const primaryPayout  = getPayout(primaryType, primaryBarrier);
  const primaryWinProb = getWinProb(primaryType, primaryBarrier);
  const recoveryPayout = getPayout(recoveryType, recoveryBarrier);

  const result = useMemo(() => calcRisk({
    baseStake,
    balance,
    primaryPayout,
    primaryWinProb,
    recoveryPayout,
    maxLosses,
    recoveryMethod,
    recoveryMultiplier,
    tradesPerSession,
  }), [
    baseStake, balance, primaryPayout, primaryWinProb, recoveryPayout,
    maxLosses, recoveryMethod, recoveryMultiplier, tradesPerSession,
  ]);

  const stakeAsPct = balance > 0 ? (baseStake / balance) * 100 : 0;

  return (
    <div className="min-h-full bg-background">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border px-4 md:px-6 py-3 flex items-center gap-3">
        <div className="w-8 h-8 rounded bg-primary/15 border border-primary/30 flex items-center justify-center flex-shrink-0">
          <Calculator className="w-4 h-4 text-primary" />
        </div>
        <div>
          <h1 className="text-base font-bold leading-tight">Risk Calculator</h1>
          <p className="text-xs text-muted-foreground">Strategy stress-tester — TP / SL / recovery ladder</p>
        </div>
        <Button
          variant="outline" size="sm" className="ml-auto gap-1.5 text-xs"
          onClick={() => setLocation("/settings")}
        >
          <ArrowRight className="w-3 h-3" />
          Apply in Settings
        </Button>
      </div>

      <div className="p-4 md:p-6">
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_480px] gap-5 max-w-[1400px] mx-auto">

          {/* ── LEFT: Inputs ── */}
          <div className="space-y-4">

            {/* Trade Setup */}
            <Card className="border-border/60">
              <CardHeader className="pb-1 pt-4 px-4">
                <SectionHeader icon={DollarSign} title="Account & Stake" />
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-0">
                <Row label="Account Balance" hint="Your current trading balance">
                  <NumField value={balance} onChange={setBalance} min={1} step={10} prefix="$" />
                </Row>
                <Row
                  label="Base Stake"
                  hint={`${fmt(stakeAsPct, 2)}% of balance`}
                >
                  <NumField value={baseStake} onChange={setBaseStake} min={0.35} step={0.5} prefix="$" />
                </Row>
                <Row label="Max Consecutive Losses" hint="Point where you stop and reassess">
                  <NumField value={maxLosses} onChange={setMaxLosses} min={1} max={15} width="w-16" />
                </Row>
                <Row label="Trades per Session" hint="Used for streak probability">
                  <NumField value={tradesPerSession} onChange={setTradesPerSession} min={5} max={200} width="w-20" />
                </Row>
              </CardContent>
            </Card>

            {/* Primary Contract */}
            <Card className="border-border/60">
              <CardHeader className="pb-1 pt-4 px-4">
                <SectionHeader icon={TrendingUp} title="Primary Contract (Normal Mode)" />
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <ContractPicker
                  type={primaryType} barrier={primaryBarrier}
                  onTypeChange={setPrimaryType} onBarrierChange={setPrimaryBarrier}
                  label="Primary"
                />
                <div className="mt-3 p-2.5 rounded-md bg-secondary/30 border border-border/40 text-xs text-muted-foreground">
                  <Info className="w-3 h-3 inline mr-1.5 text-primary" />
                  Breakeven win rate needed: <strong className="text-foreground">{pct(result.breakevenWinRate)}</strong>.
                  {" "}Current EV per trade:{" "}
                  <strong className={result.evPerTrade >= 0 ? "text-green-400" : "text-red-400"}>
                    {result.evPerTrade >= 0 ? "+" : ""}{fmt(result.evPerTrade * 100, 2)}¢ per $1 staked
                  </strong>
                </div>
              </CardContent>
            </Card>

            {/* Recovery Contract */}
            <Card className="border-border/60">
              <CardHeader className="pb-1 pt-4 px-4">
                <SectionHeader icon={RefreshCw} title="Recovery Contract (After Losses)" />
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-4">
                <ContractPicker
                  type={recoveryType} barrier={recoveryBarrier}
                  onTypeChange={setRecoveryType} onBarrierChange={setRecoveryBarrier}
                  label="Recovery"
                />

                {/* Recovery Method */}
                <div className="pt-1">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Recovery Method</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {(["instant", "split"] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => setRecoveryMethod(m)}
                        className={`flex items-center gap-2 p-3 rounded-lg border text-sm font-medium transition-colors ${
                          recoveryMethod === m
                            ? "bg-primary/10 border-primary/40 text-primary"
                            : "bg-secondary/40 border-border/50 text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {m === "instant" ? <Zap className="w-4 h-4" /> : <GitBranch className="w-4 h-4" />}
                        <div className="text-left">
                          <div className="font-semibold capitalize">{m}</div>
                          <div className="text-[10px] opacity-70">
                            {m === "instant" ? "One trade to recover" : "Progressive steps"}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>

                  {recoveryMethod === "split" && (
                    <div className="mt-3">
                      <Row label="Recovery Multiplier" hint="Stake multiplier per step (e.g. 1.62 → 2.62 → 3.62×)">
                        <NumField
                          value={recoveryMultiplier} onChange={setRecoveryMultiplier}
                          min={1.1} max={5} step={0.1} width="w-20"
                        />
                      </Row>
                    </div>
                  )}
                </div>

                <div className="p-2.5 rounded-md bg-secondary/30 border border-border/40 text-xs text-muted-foreground">
                  <Info className="w-3 h-3 inline mr-1.5 text-primary" />
                  {recoveryMethod === "instant"
                    ? "Instant mode: one winning recovery trade recoups all losses + base profit."
                    : "Split mode: losses spread across multiple increasing-stake trades, reducing per-trade pressure."}
                  {" "}Net P&L after a full cycle:{" "}
                  <strong className="text-green-400">+{usd(result.netAfterRecovery)}</strong>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* ── RIGHT: Results ── */}
          <div className="space-y-4">

            {/* Risk Score */}
            <Card className="border-border/60" style={{ borderColor: `${result.riskColor}30` }}>
              <CardContent className="pt-5 pb-4 px-4">
                <div className="flex items-start gap-4">
                  <RiskGauge score={result.riskScore} color={result.riskColor} label={result.riskLabel} />
                  <div className="flex-1 space-y-2.5 pt-1">
                    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Strategy Overview</div>
                    <div className="grid grid-cols-2 gap-2">
                      <Stat
                        label="Balance covers"
                        value={`${result.balanceCoverage >= 100 ? "99+" : fmt(result.balanceCoverage, 1)}×`}
                        sub="recovery cycles"
                        color={result.balanceCoverage < 2 ? "text-red-400" : result.balanceCoverage < 4 ? "text-yellow-400" : "text-green-400"}
                      />
                      <Stat
                        label="Session risk"
                        value={pct(result.streakProbSession)}
                        sub={`of ${tradesPerSession} trades`}
                        color={result.streakProbSession > 0.5 ? "text-red-400" : result.streakProbSession > 0.25 ? "text-yellow-400" : "text-green-400"}
                      />
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Recommendations */}
            <Card className="border-border/60">
              <CardHeader className="pb-1 pt-4 px-4">
                <SectionHeader icon={Target} title="Recommendations" />
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-3">
                    <div className="flex items-center gap-1.5 mb-1">
                      <TrendingUp className="w-3.5 h-3.5 text-green-400" />
                      <span className="text-[10px] uppercase tracking-wider text-green-400 font-semibold">Daily Take Profit</span>
                    </div>
                    <div className="text-2xl font-bold text-green-400 tabular-nums">{usd(result.recommendedTP)}</div>
                    <div className="text-[11px] text-muted-foreground mt-1">
                      ≈ {maxLosses * 2} base-stake wins
                    </div>
                  </div>
                  <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
                    <div className="flex items-center gap-1.5 mb-1">
                      <TrendingDown className="w-3.5 h-3.5 text-red-400" />
                      <span className="text-[10px] uppercase tracking-wider text-red-400 font-semibold">Daily Stop Loss</span>
                    </div>
                    <div className="text-2xl font-bold text-red-400 tabular-nums">{usd(result.recommendedSL)}</div>
                    <div className="text-[11px] text-muted-foreground mt-1">
                      Full ladder + 10% buffer
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <Stat
                    label="Min balance needed"
                    value={usd(result.totalLadderCost * 3)}
                    sub="3× ladder cost"
                    color="text-foreground"
                  />
                  <Stat
                    label="SL / TP ratio"
                    value={`${fmt(result.recommendedSL / Math.max(result.recommendedTP, 0.01), 1)}:1`}
                    sub="(binary = SL > TP)"
                    color="text-muted-foreground"
                  />
                  <Stat
                    label="Cycle profit"
                    value={`+${usd(result.netAfterRecovery)}`}
                    sub="per full cycle"
                    color="text-green-400"
                  />
                </div>

                <div className="p-2.5 bg-secondary/30 rounded-md border border-border/40 text-xs text-muted-foreground leading-relaxed">
                  <strong className="text-foreground">Why SL &gt; TP in binary trading?</strong>{" "}
                  You risk the entire stake on each trade. A single losing streak can exceed many small wins.
                  Setting SL = full ladder protects your account; TP = achievable session target keeps you disciplined.
                </div>
              </CardContent>
            </Card>

            {/* Session Probability */}
            <Card className="border-border/60">
              <CardHeader className="pb-1 pt-4 px-4">
                <SectionHeader icon={BarChart3} title="Streak Survival Analysis" />
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-2">
                {[
                  { trades: tradesPerSession, prob: result.streakProbSession, label: `${tradesPerSession}-trade session` },
                  { trades: 50, prob: result.streakProb50, label: "50-trade session" },
                  { trades: 100, prob: streakProbValue(primaryWinProb, maxLosses, 100), label: "100-trade session" },
                ].map(({ label, prob }) => (
                  <div key={label}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-muted-foreground">{label}</span>
                      <span className={`text-xs font-bold tabular-nums ${prob > 0.5 ? "text-red-400" : prob > 0.25 ? "text-yellow-400" : "text-green-400"}`}>
                        {pct(prob)}
                      </span>
                    </div>
                    <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                      <motion.div
                        className="h-full rounded-full"
                        style={{
                          backgroundColor: prob > 0.5 ? "#ef4444" : prob > 0.25 ? "#f59e0b" : "#10b981",
                        }}
                        initial={{ width: 0 }}
                        animate={{ width: `${prob * 100}%` }}
                        transition={{ duration: 0.5, ease: "easeOut" }}
                      />
                    </div>
                  </div>
                ))}
                <div className="pt-1 text-[11px] text-muted-foreground">
                  Probability of hitting <strong className="text-foreground">{maxLosses} consecutive losses</strong> in
                  the given number of trades. Keep this below 25% for a safe strategy.
                </div>
              </CardContent>
            </Card>

            {/* Recovery Ladder */}
            <Card className="border-border/60">
              <CardHeader className="pb-2 pt-4 px-4">
                <div className="flex items-center justify-between">
                  <SectionHeader icon={GitBranch} title="Recovery Ladder" />
                  <button
                    onClick={() => setShowLadder((s) => !s)}
                    className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                  >
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showLadder ? "rotate-180" : ""}`} />
                    {showLadder ? "Hide" : "Show"}
                  </button>
                </div>
              </CardHeader>
              {showLadder && (
                <CardContent className="px-4 pb-4">
                  <LadderTable ladder={result.ladder} totalCost={result.totalLadderCost} balance={balance} />
                </CardContent>
              )}
            </Card>

            {/* Warnings */}
            {result.warnings.length > 0 && (
              <Card className="border-yellow-500/30 bg-yellow-500/5">
                <CardContent className="px-4 py-3 space-y-2">
                  <div className="flex items-center gap-2 mb-1">
                    <AlertTriangle className="w-4 h-4 text-yellow-400" />
                    <span className="text-xs font-semibold uppercase tracking-wider text-yellow-400">Risk Warnings</span>
                  </div>
                  {result.warnings.map((w, i) => (
                    <div key={i} className="flex gap-2 text-xs text-yellow-200/80">
                      <span className="text-yellow-500 mt-0.5 flex-shrink-0">•</span>
                      <span>{w}</span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Apply hint */}
            <div className="text-xs text-muted-foreground text-center py-1">
              Head to{" "}
              <button
                className="text-primary underline underline-offset-2"
                onClick={() => setLocation("/settings")}
              >
                Settings
              </button>
              {" "}→ Daily Limits to enter your TP ({usd(result.recommendedTP)}) and SL ({usd(result.recommendedSL)}).
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// thin wrapper so JSX can call the pure function without import collision
function streakProbValue(winP: number, streak: number, trades: number): number {
  return streakProb(winP, streak, trades);
}
