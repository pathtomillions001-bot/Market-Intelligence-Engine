import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useExecuteTrade, useGetSettings } from "@workspace/api-client-react";
import { toast } from "sonner";
import { Zap, TrendingUp, TrendingDown, ChevronDown, ChevronUp, AlertTriangle } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

// ── Contract type groups ────────────────────────────────────────────────────────
const CONTRACT_GROUPS = [
  { label: "Rise / Fall",  short: "R/F", types: ["CALL", "PUT"] },
  { label: "Over / Under", short: "O/U", types: ["DIGITOVER", "DIGITUNDER"] },
  { label: "Even / Odd",   short: "E/O", types: ["DIGITEVEN", "DIGITODD"] },
] as const;

// ── Helpers ────────────────────────────────────────────────────────────────────
function formatContractLabel(contractType?: string, barrier?: number | null): string {
  if (!contractType) return "—";
  if (contractType === "DIGITOVER")  return barrier != null ? `OVER ${barrier}` : "OVER";
  if (contractType === "DIGITUNDER") return barrier != null ? `UNDER ${barrier}` : "UNDER";
  if (contractType === "DIGITEVEN")  return "EVEN";
  if (contractType === "DIGITODD")   return "ODD";
  if (contractType === "CALL")       return "RISE";
  if (contractType === "PUT")        return "FALL";
  return contractType;
}

function contractToDirection(ct: string): "up" | "down" {
  if (ct === "CALL" || ct === "RISE" || ct === "DIGITOVER" || ct === "DIGITEVEN") return "up";
  return "down";
}

function contractColor(ct: string): string {
  if (ct === "CALL" || ct === "RISE") return "#10b981";
  if (ct === "PUT"  || ct === "FALL") return "#ef4444";
  if (ct === "DIGITOVER")             return "#06b6d4";
  if (ct === "DIGITUNDER")            return "#f59e0b";
  if (ct === "DIGITEVEN")             return "#8b5cf6";
  if (ct === "DIGITODD")              return "#ec4899";
  return "#00ffff";
}

// ── FlashCard3D kept for compatibility ────────────────────────────────────────
export function FlashCard3D({ front }: { front: React.ReactNode; back?: React.ReactNode; flipped?: boolean; onFlip?: () => void; className?: string; glowColor?: string }) {
  return <div className="w-full h-full">{front}</div>;
}

// ── Win probability bar ────────────────────────────────────────────────────────
function WinProbBar({ value }: { value: number }) {
  const color = value >= 65 ? "#10b981" : value >= 50 ? "#f59e0b" : "#ef4444";
  return (
    <div className="flex flex-col items-center gap-0.5 w-14">
      <div className="text-xs font-mono font-bold" style={{ color }}>{value.toFixed(0)}%</div>
      <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${Math.min(value, 100)}%`, background: color }}
        />
      </div>
      <div className="text-[8px] font-mono text-muted-foreground">WIN PROB</div>
    </div>
  );
}

// ── Quick Strike Card ──────────────────────────────────────────────────────────
export function MarketOpportunityFlashCard({
  onTrade,
  currentStreak = 0,
}: {
  onTrade?: () => void;
  currentStreak?: number;
}) {
  const [selectedGroupIdx, setSelectedGroupIdx] = useState(0);
  const [executingSymbol, setExecutingSymbol] = useState<string | null>(null);
  const [showMarkets, setShowMarkets] = useState(false);
  const [recoveryDismissed, setRecoveryDismissed] = useState(false);

  const executeTrade = useExecuteTrade();

  // Read user's enabled contract families from settings
  const { data: settings } = useGetSettings();
  const preferredTypes: string[] = (settings as any)?.preferredContractTypes ?? ["CALL", "PUT", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD"];
  // Only show tabs for enabled groups; fall back to all groups if nothing is active
  const enabledGroups = CONTRACT_GROUPS.filter(g =>
    (g.types as readonly string[]).some(t => preferredTypes.includes(t))
  );
  const visibleGroups = enabledGroups.length > 0 ? enabledGroups : [...CONTRACT_GROUPS];

  // Auto-reset selectedGroupIdx when enabled groups change (e.g. user disables Rise/Fall)
  const clampedIdx = Math.min(selectedGroupIdx, visibleGroups.length - 1);
  useEffect(() => {
    if (selectedGroupIdx !== clampedIdx) setSelectedGroupIdx(clampedIdx);
  }, [clampedIdx, selectedGroupIdx]);

  // Recovery mode: activated when losing streak is ≥ 2 consecutive losses and user hasn't dismissed it
  const isLosingStreak = currentStreak <= -2;
  const recoveryActive = isLosingStreak && !recoveryDismissed;

  // In recovery, default to Over/Under if it's enabled; otherwise use first visible group
  const recoveryGroup = visibleGroups.find(g => g.short === "O/U") ?? visibleGroups[0];
  const selectedGroup = recoveryActive ? recoveryGroup : visibleGroups[clampedIdx];
  const effectiveGroupIdx = recoveryActive
    ? CONTRACT_GROUPS.findIndex(g => g.short === recoveryGroup.short)
    : CONTRACT_GROUPS.findIndex(g => g.short === selectedGroup.short);

  // All markets ranked by quality score from background scanner
  const { data: allMarkets } = useQuery<any[]>({
    queryKey: ["markets", "ranked-all"],
    queryFn: () => fetch("/api/markets?limit=50").then(r => r.json()),
    refetchInterval: 8000,
  });

  // In recovery mode: find the best market with a tier-2 recovery barrier (OVER 4 or UNDER 5)
  const recoveryMarket = recoveryActive
    ? (allMarkets ?? []).find((m: any) =>
        (m.recommendedContractType === "DIGITOVER" || m.recommendedContractType === "DIGITUNDER") && m.shouldTrade
      ) ?? (allMarkets ?? []).find((m: any) =>
        m.recommendedContractType === "DIGITOVER" || m.recommendedContractType === "DIGITUNDER"
      )
    : null;

  // Filter to markets whose AI-recommended contract type is in the selected group
  const groupMarkets = (allMarkets ?? []).filter((m: any) =>
    (selectedGroup.types as readonly string[]).includes(m.recommendedContractType)
  );
  const tradeableGroupMarkets = groupMarkets.filter((m: any) => m.shouldTrade);

  // Best market: in recovery mode use recovery market, otherwise tradeable first then by quality score
  const bestGroupMarket = recoveryActive
    ? (recoveryMarket ?? groupMarkets[0] ?? allMarkets?.[0])
    : (tradeableGroupMarkets[0] ?? groupMarkets[0] ?? allMarkets?.[0]);

  // Fetch full recommendation for the selected market (AI-configured ticks, stake, barrier)
  const { data: marketDetail } = useQuery<any>({
    queryKey: ["market-detail-flash", bestGroupMarket?.symbol, effectiveGroupIdx, recoveryActive],
    queryFn: () => bestGroupMarket?.symbol
      ? fetch(`/api/markets/${bestGroupMarket.symbol}`).then(r => r.json())
      : Promise.resolve(null),
    refetchInterval: 8000,
    enabled: !!bestGroupMarket?.symbol,
  });

  const rec = marketDetail?.recommendation;

  // Contract type: in recovery force a recovery barrier contract, else use AI recommendation
  const recContractType: string = rec?.contractType ?? bestGroupMarket?.recommendedContractType ?? selectedGroup.types[0];
  const contractType = (selectedGroup.types as readonly string[]).includes(recContractType)
    ? recContractType
    : selectedGroup.types[0];

  // Recovery barrier override: look for tier-2 barriers in agentOutputs (OVER 4 / UNDER 5)
  const digitAgent = (rec as any)?.agentOutputs?.digitDistribution;
  const tier2Options: any[] = digitAgent?.data?.tier2Options ?? [];
  const bestRecoveryOption = tier2Options.find((o: any) =>
    (o.contractType === "DIGITOVER" && o.barrier === 4) ||
    (o.contractType === "DIGITUNDER" && o.barrier === 5)
  ) ?? tier2Options[0];

  const recoveryContractType: string = bestRecoveryOption?.contractType ?? contractType;
  const recoveryBarrier: number | undefined = bestRecoveryOption?.barrier;
  const recoveryWinProb: number = bestRecoveryOption
    ? Math.round((bestRecoveryOption.winProbability ?? 0) * 100)
    : 50;

  // Active contract type and barrier
  const activeContractType = recoveryActive ? recoveryContractType : contractType;
  const activeBarrier = recoveryActive
    ? recoveryBarrier
    : (contractType.includes("DIGIT") && rec?.digitBarrier != null ? rec.digitBarrier : undefined);

  // Execute is active:
  // - Normal mode: AI says shouldTrade=true AND recommended type matches selected group
  // - Recovery mode: we have a recovery option with positive EV
  const isGroupMatch = (selectedGroup.types as readonly string[]).includes(rec?.contractType ?? "");
  const normalShouldTrade = !!(rec?.shouldTrade && isGroupMatch);
  const recoveryShouldTrade = !!(recoveryActive && bestRecoveryOption && (bestRecoveryOption.expectedValue ?? 0) > 0);
  const shouldTrade = recoveryActive ? recoveryShouldTrade : normalShouldTrade;

  const ctColor = contractColor(activeContractType);
  const isUp = contractToDirection(activeContractType) === "up";

  const winProb = recoveryActive ? recoveryWinProb : (rec?.winProbability ?? rec?.confidence ?? 0);
  const isExecuting = executingSymbol === bestGroupMarket?.symbol;

  const handleExecute = () => {
    if (!bestGroupMarket) return;
    if (recoveryActive && !bestRecoveryOption && !rec) return;
    if (!recoveryActive && !rec) return;

    const sym = bestGroupMarket.symbol;
    const barrier = activeBarrier;
    setExecutingSymbol(sym);

    const stake = recoveryActive
      ? (bestRecoveryOption ? Number((bestRecoveryOption?.stake ?? rec?.stake ?? 1).toFixed(2)) : rec?.stake ?? 1)
      : (rec?.stake ?? 1);

    executeTrade.mutate({
      data: {
        symbol: sym,
        contractType: activeContractType,
        stake,
        direction: contractToDirection(activeContractType),
        ...(barrier != null && { barrier }),
        duration: rec?.recommendedDuration ?? 5,
        durationUnit: "t",
      } as any
    }, {
      onSuccess: (trade: any) => {
        const won = trade.status === "won";
        toast[won ? "success" : "error"](
          `${won ? "✓ Won" : "✗ Lost"} $${Math.abs(Number(trade.profit ?? 0)).toFixed(2)} on ${bestGroupMarket.displayName}`
        );
        setExecutingSymbol(null);
        onTrade?.();
      },
      onError: () => {
        toast.error("Trade failed — check account settings");
        setExecutingSymbol(null);
      }
    });
  };

  const recoveryColor = "#f59e0b";

  return (
    <div
      className="relative w-full h-full rounded-2xl border overflow-hidden"
      style={{
        background: recoveryActive
          ? "linear-gradient(135deg, #1a0f00 0%, #1a1200 50%, #0f0f0f 100%)"
          : "linear-gradient(135deg, #18181b 0%, #18181b 50%, #0f0f10 100%)",
        borderColor: recoveryActive ? `${recoveryColor}50` : "rgba(0,255,255,0.2)",
        boxShadow: recoveryActive
          ? `0 0 30px ${recoveryColor}30, 0 0 60px ${recoveryColor}10, inset 0 1px 0 rgba(255,255,255,0.05)`
          : `0 0 30px ${ctColor}30, 0 0 60px ${ctColor}10, inset 0 1px 0 rgba(255,255,255,0.05)`,
      }}
    >
      {/* Corner accents */}
      <span className="absolute top-0 left-0 w-5 h-5 border-t-2 border-l-2 border-primary rounded-tl-2xl" style={recoveryActive ? { borderColor: recoveryColor } : {}} />
      <span className="absolute top-0 right-0 w-5 h-5 border-t-2 border-r-2 border-primary rounded-tr-2xl" style={recoveryActive ? { borderColor: recoveryColor } : {}} />
      <span className="absolute bottom-0 left-0 w-5 h-5 border-b-2 border-l-2 border-primary rounded-bl-2xl" style={recoveryActive ? { borderColor: recoveryColor } : {}} />
      <span className="absolute bottom-0 right-0 w-5 h-5 border-b-2 border-r-2 border-primary rounded-br-2xl" style={recoveryActive ? { borderColor: recoveryColor } : {}} />

      {/* Scan line */}
      <motion.div
        className="absolute inset-x-0 h-px"
        style={{ background: recoveryActive ? `linear-gradient(90deg, transparent, ${recoveryColor}80, transparent)` : "linear-gradient(90deg, transparent, rgba(0,255,255,0.5), transparent)" }}
        animate={{ top: ["0%", "100%", "0%"] }}
        transition={{ duration: recoveryActive ? 2 : 4, ease: "linear", repeat: Infinity }}
      />

      {/* Grid overlay */}
      <div className="absolute inset-0 opacity-[0.025]" style={{
        backgroundImage: `linear-gradient(${recoveryActive ? "rgba(245,158,11,1)" : "rgba(0,255,255,1)"} 1px, transparent 1px), linear-gradient(90deg, ${recoveryActive ? "rgba(245,158,11,1)" : "rgba(0,255,255,1)"} 1px, transparent 1px)`,
        backgroundSize: "20px 20px"
      }} />

      <div className="relative z-10 p-4 flex flex-col gap-3 h-full">
        {/* Header: label + contract group selector + live dot */}
        <div className="flex items-center gap-2">
          {recoveryActive ? (
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" style={{ color: recoveryColor }} />
          ) : (
            <Zap className="w-3.5 h-3.5 text-primary shrink-0" />
          )}
          <span
            className="text-[10px] font-mono uppercase tracking-widest"
            style={{ color: recoveryActive ? recoveryColor : "rgba(0,255,255,0.7)" }}
          >
            {recoveryActive ? `Recovery Mode — ${Math.abs(currentStreak)} Loss Streak` : "Quick Strike"}
          </span>

          {/* Contract group tab selector — only shows enabled families; hidden in recovery mode */}
          {!recoveryActive && visibleGroups.length > 0 && (
            <div className="ml-auto flex items-center bg-black/40 rounded-lg p-0.5 gap-0.5">
              {visibleGroups.map((g, i) => (
                <button
                  key={g.short}
                  onClick={() => { setSelectedGroupIdx(i); setShowMarkets(false); }}
                  className={`text-[8px] font-mono font-bold px-2 py-1 rounded transition-all ${
                    i === clampedIdx
                      ? "text-primary border border-primary/50"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  style={i === clampedIdx ? { background: `${contractColor(g.types[0])}20` } : {}}
                >
                  {g.short}
                </button>
              ))}
            </div>
          )}

          {/* Recovery: dismiss button */}
          {recoveryActive && (
            <button
              onClick={() => setRecoveryDismissed(true)}
              className="ml-auto text-[8px] font-mono px-2 py-0.5 rounded border border-amber-500/30 text-amber-500/60 hover:text-amber-400 transition-colors"
            >
              dismiss
            </button>
          )}

          <span className="w-1.5 h-1.5 rounded-full animate-pulse ml-1" style={{ background: recoveryActive ? recoveryColor : "#22c55e" }} />
        </div>

        {/* Recovery banner */}
        {recoveryActive && (
          <div
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-[9px] font-mono"
            style={{ borderColor: `${recoveryColor}40`, background: `${recoveryColor}10`, color: recoveryColor }}
          >
            <AlertTriangle className="w-3 h-3 shrink-0" />
            <span>
              AI detected {Math.abs(currentStreak)} consecutive losses — recommending highest-EV recovery contract
              {bestRecoveryOption ? ` (${bestRecoveryOption.contractType === "DIGITOVER" ? "OVER" : "UNDER"} ${bestRecoveryOption.barrier})` : ""}
            </span>
          </div>
        )}

        {/* Market info + win prob + execute */}
        <div className="flex items-center gap-3">
          {/* Left: market name + contract badge */}
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold leading-tight truncate">{bestGroupMarket?.displayName ?? "Scanning…"}</div>
            <div className="text-[10px] font-mono text-muted-foreground">{bestGroupMarket?.symbol ?? "—"}</div>
            <div className="mt-2 flex items-center gap-1.5">
              {isUp
                ? <TrendingUp className="w-3 h-3 shrink-0" style={{ color: ctColor }} />
                : <TrendingDown className="w-3 h-3 shrink-0" style={{ color: ctColor }} />}
              <span
                className="text-sm font-mono font-bold px-2 py-0.5 rounded-full border"
                style={{ color: ctColor, borderColor: `${ctColor}50`, background: `${ctColor}15` }}
              >
                {formatContractLabel(activeContractType, activeBarrier ?? rec?.digitBarrier ?? rec?.barrier)}
              </span>
              {recoveryActive && bestRecoveryOption && (
                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded" style={{ background: `${recoveryColor}20`, color: recoveryColor }}>
                  TIER-2
                </span>
              )}
              <span className="text-[9px] text-muted-foreground font-mono capitalize truncate">
                {(bestGroupMarket?.regime ?? marketDetail?.regime ?? "").replace(/_/g, " ")}
              </span>
            </div>
          </div>

          {/* Center: win probability */}
          <WinProbBar value={winProb} />

          {/* Right: execute button */}
          <div className="shrink-0">
            <button
              onClick={handleExecute}
              disabled={!shouldTrade || isExecuting}
              className="flex flex-col items-center justify-center w-16 h-16 rounded-xl border-2 font-bold font-mono text-[10px] transition-all active:scale-[0.95] disabled:opacity-40 disabled:cursor-not-allowed"
              style={shouldTrade ? {
                borderColor: recoveryActive ? recoveryColor : ctColor,
                background: recoveryActive ? `${recoveryColor}20` : `${ctColor}20`,
                color: recoveryActive ? recoveryColor : ctColor,
                boxShadow: `0 0 20px ${recoveryActive ? recoveryColor : ctColor}30`,
              } : {
                borderColor: "rgba(255,255,255,0.1)",
                color: "rgba(255,255,255,0.3)",
              }}
            >
              {isExecuting ? (
                <span className="text-[8px] leading-tight text-center">EXEC…</span>
              ) : shouldTrade ? (
                <>
                  <span className="text-lg leading-none">{recoveryActive ? "🔄" : "⚡"}</span>
                  <span className="text-[8px] mt-0.5 uppercase tracking-widest">{recoveryActive ? "Recover" : "Execute"}</span>
                </>
              ) : (
                <>
                  <span className="text-base leading-none">⏸</span>
                  <span className="text-[8px] mt-0.5 uppercase tracking-widest">Wait</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Stats row: EV | Ticks | Stake */}
        <div className="grid grid-cols-3 gap-1.5">
          {[
            {
              label: "EV",
              value: recoveryActive && bestRecoveryOption
                ? (bestRecoveryOption.expectedValue > 0 ? `+${(bestRecoveryOption.expectedValue * 100).toFixed(1)}%` : `${(bestRecoveryOption.expectedValue * 100).toFixed(1)}%`)
                : rec ? (rec.expectedValue > 0 ? `+$${rec.expectedValue.toFixed(2)}` : `$${rec.expectedValue?.toFixed(2) ?? "—"}`) : "—"
            },
            { label: "Ticks", value: rec ? `${rec.recommendedDuration ?? 5}t` : "—" },
            {
              label: "Stake",
              value: recoveryActive && bestRecoveryOption
                ? `$${(rec?.stake ?? 1).toFixed(2)}`
                : rec ? `$${rec.stake?.toFixed(2) ?? "—"}` : "—"
            },
          ].map(({ label, value }) => (
            <div key={label} className="text-center p-1.5 rounded-lg bg-white/[0.04] border border-white/[0.06]">
              <div className="text-[8px] text-muted-foreground uppercase tracking-wide">{label}</div>
              <div className="text-[11px] font-mono font-bold mt-0.5">{value}</div>
            </div>
          ))}
        </div>

        {/* Footer: count + expand */}
        <div className="flex items-center justify-between mt-auto">
          {recoveryActive ? (
            <span className="text-[9px] font-mono" style={{ color: `${recoveryColor}80` }}>
              🔄 Recovery override — highest-EV tier-2 barrier selected
            </span>
          ) : (
            <span className="text-[9px] font-mono text-muted-foreground">
              {allMarkets?.length ?? 0} markets scanned &middot; {tradeableGroupMarkets.length} tradeable in {selectedGroup.short}
            </span>
          )}
          {!recoveryActive && groupMarkets.length > 1 && (
            <button
              onClick={() => setShowMarkets(s => !s)}
              className="flex items-center gap-1 text-[9px] font-mono text-primary/50 hover:text-primary transition-colors"
            >
              Top {Math.min(groupMarkets.length, 5)} {showMarkets ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          )}
        </div>

        {/* Expandable group market list — hidden in recovery mode */}
        <AnimatePresence>
          {!recoveryActive && showMarkets && groupMarkets.length > 1 && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="space-y-1 pt-1 border-t border-white/[0.07]">
                {groupMarkets.slice(0, 5).map((market: any, idx: number) => {
                  const ct = market.recommendedContractType ?? selectedGroup.types[0];
                  const ctCol = contractColor(ct);
                  const isExec = executingSymbol === market.symbol;
                  const hasSignal = market.shouldTrade && (selectedGroup.types as readonly string[]).includes(ct);
                  return (
                    <div key={market.symbol} className="flex items-center gap-2 py-1">
                      <span className="text-[9px] font-mono text-muted-foreground w-4 text-center">{idx + 1}</span>
                      <span className="flex-1 text-[10px] font-medium truncate">{market.displayName}</span>
                      <span
                        className="text-[8px] font-mono font-bold px-1.5 py-0.5 rounded border"
                        style={{ color: ctCol, borderColor: `${ctCol}40`, background: `${ctCol}10` }}
                      >
                        {formatContractLabel(ct)}
                      </span>
                      <span className="text-[9px] font-mono text-muted-foreground w-8 text-right">
                        {market.confidenceScore?.toFixed(0) ?? 0}%
                      </span>
                      <button
                        onClick={() => {
                          if (!hasSignal) return;
                          const sym = market.symbol;
                          setExecutingSymbol(sym);
                          executeTrade.mutate({
                            data: {
                              symbol: sym, contractType: ct,
                              stake: rec?.stake ?? 1,
                              direction: contractToDirection(ct),
                              duration: rec?.recommendedDuration ?? 5,
                              durationUnit: "t",
                            } as any
                          }, {
                            onSuccess: (trade: any) => {
                              const won = trade.status === "won";
                              toast[won ? "success" : "error"](`${won ? "✓ Won" : "✗ Lost"} on ${market.displayName}`);
                              setExecutingSymbol(null);
                            },
                            onError: () => { toast.error("Trade failed"); setExecutingSymbol(null); }
                          });
                        }}
                        disabled={isExec || !hasSignal}
                        title={!hasSignal ? "No active signal for this market" : undefined}
                        className="px-2 py-0.5 rounded text-[8px] font-bold font-mono border transition-all active:scale-[0.97] disabled:opacity-30 disabled:cursor-not-allowed"
                        style={hasSignal ? { background: `${ctCol}15`, borderColor: `${ctCol}50`, color: ctCol } : { background: "transparent", borderColor: "rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.25)" }}
                      >
                        {isExec ? "…" : hasSignal ? "⚡" : "⏸"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
