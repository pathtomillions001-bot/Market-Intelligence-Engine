import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useExecuteTrade } from "@workspace/api-client-react";
import { toast } from "sonner";
import { RotateCcw, Zap, TrendingUp, TrendingDown, ChevronDown, ChevronUp } from "lucide-react";

// ── Base flip card wrapper ─────────────────────────────────────────────────────
interface FlashCard3DProps {
  front: React.ReactNode;
  back: React.ReactNode;
  flipped: boolean;
  onFlip: () => void;
  className?: string;
  glowColor?: string;
}

export function FlashCard3D({ front, back, flipped, onFlip, className = "", glowColor = "rgba(0,255,255,0.35)" }: FlashCard3DProps) {
  return (
    <div className={`relative select-none ${className}`} style={{ perspective: "1200px" }}>
      <motion.div
        animate={{ rotateY: flipped ? 180 : 0 }}
        transition={{ duration: 0.55, ease: [0.4, 0, 0.2, 1] }}
        style={{ transformStyle: "preserve-3d", position: "relative", width: "100%", height: "100%" }}
      >
        {/* Front */}
        <div
          style={{ backfaceVisibility: "hidden", WebkitBackfaceVisibility: "hidden", pointerEvents: flipped ? "none" : "auto" }}
          className="absolute inset-0 rounded-2xl"
        >
          <div
            className="relative w-full h-full rounded-2xl border border-primary/30 bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-950 overflow-hidden"
            style={{ boxShadow: `0 0 30px ${glowColor}, 0 0 60px ${glowColor.replace("0.35", "0.1")}, inset 0 1px 0 rgba(255,255,255,0.05)` }}
          >
            <span className="absolute top-0 left-0 w-6 h-6 border-t-2 border-l-2 border-primary rounded-tl-2xl" />
            <span className="absolute top-0 right-0 w-6 h-6 border-t-2 border-r-2 border-primary rounded-tr-2xl" />
            <span className="absolute bottom-0 left-0 w-6 h-6 border-b-2 border-l-2 border-primary rounded-bl-2xl" />
            <span className="absolute bottom-0 right-0 w-6 h-6 border-b-2 border-r-2 border-primary rounded-br-2xl" />
            <motion.div
              className="absolute inset-x-0 h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent"
              animate={{ top: ["0%", "100%", "0%"] }}
              transition={{ duration: 4, ease: "linear", repeat: Infinity }}
            />
            <div className="absolute inset-0 opacity-[0.03]" style={{
              backgroundImage: "linear-gradient(rgba(0,255,255,1) 1px, transparent 1px), linear-gradient(90deg, rgba(0,255,255,1) 1px, transparent 1px)",
              backgroundSize: "24px 24px"
            }} />
            <div className="relative z-10 w-full h-full flex flex-col">{front}</div>
            <button
              onClick={(e) => { e.stopPropagation(); onFlip(); }}
              className="absolute bottom-2.5 right-3 z-20 flex items-center gap-1 text-[10px] font-mono text-primary/50 hover:text-primary transition-colors group"
              title="Flip card"
            >
              <RotateCcw className="w-3 h-3 group-hover:rotate-180 transition-transform duration-300" />
              <span className="tracking-widest uppercase">flip</span>
            </button>
          </div>
        </div>

        {/* Back */}
        <div
          style={{ backfaceVisibility: "hidden", WebkitBackfaceVisibility: "hidden", transform: "rotateY(180deg)", pointerEvents: flipped ? "auto" : "none" }}
          className="absolute inset-0 rounded-2xl"
        >
          <div
            className="relative w-full h-full rounded-2xl border border-primary/50 bg-gradient-to-br from-zinc-950 via-zinc-900 to-zinc-900 overflow-hidden"
            style={{ boxShadow: `0 0 40px ${glowColor}, 0 0 80px ${glowColor.replace("0.35", "0.12")}, inset 0 1px 0 rgba(255,255,255,0.07)` }}
          >
            <span className="absolute top-0 left-0 w-6 h-6 border-t-2 border-l-2 border-primary rounded-tl-2xl" />
            <span className="absolute top-0 right-0 w-6 h-6 border-t-2 border-r-2 border-primary rounded-tr-2xl" />
            <span className="absolute bottom-0 left-0 w-6 h-6 border-b-2 border-l-2 border-primary rounded-bl-2xl" />
            <span className="absolute bottom-0 right-0 w-6 h-6 border-b-2 border-r-2 border-primary rounded-br-2xl" />
            <motion.div
              className="absolute inset-x-0 h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent"
              animate={{ top: ["100%", "0%", "100%"] }}
              transition={{ duration: 4, ease: "linear", repeat: Infinity }}
            />
            <div className="absolute inset-0 opacity-[0.03]" style={{
              backgroundImage: "linear-gradient(rgba(0,255,255,1) 1px, transparent 1px), linear-gradient(90deg, rgba(0,255,255,1) 1px, transparent 1px)",
              backgroundSize: "24px 24px"
            }} />
            <div className="relative z-10 w-full h-full flex flex-col overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-700 scrollbar-track-transparent">{back}</div>
            <button
              onClick={(e) => { e.stopPropagation(); onFlip(); }}
              className="absolute bottom-2.5 right-3 flex items-center gap-1 text-[10px] font-mono text-primary/50 hover:text-primary transition-colors group z-20"
              title="Flip card"
            >
              <RotateCcw className="w-3 h-3 group-hover:-rotate-180 transition-transform duration-300" />
              <span className="tracking-widest uppercase">flip</span>
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

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
  if (ct === "PUT" || ct === "FALL")  return "#ef4444";
  if (ct === "DIGITOVER")             return "#06b6d4";
  if (ct === "DIGITUNDER")            return "#f59e0b";
  if (ct === "DIGITEVEN")             return "#8b5cf6";
  if (ct === "DIGITODD")              return "#ec4899";
  return "#00ffff";
}

function ConfidenceArc({ value }: { value: number }) {
  const r = 38, circ = Math.PI * r;
  const offset = circ - (value / 100) * circ;
  const color = value >= 70 ? "#10b981" : value >= 50 ? "#f59e0b" : "#ef4444";
  return (
    <svg width="90" height="52" viewBox="0 0 90 52">
      <path d="M 7 50 A 38 38 0 0 1 83 50" fill="none" stroke="#27272a" strokeWidth="6" strokeLinecap="round" />
      <path d="M 7 50 A 38 38 0 0 1 83 50" fill="none" stroke={color} strokeWidth="6" strokeLinecap="round"
        strokeDasharray={circ} strokeDashoffset={offset}
        style={{ transition: "stroke-dashoffset 0.8s ease, stroke 0.4s" }} />
      <text x="45" y="48" textAnchor="middle" fill={color} fontSize="13" fontFamily="monospace" fontWeight="bold">
        {value.toFixed(0)}%
      </text>
    </svg>
  );
}

// ── Quick Strike Flash Card ────────────────────────────────────────────────────
interface MarketOpportunityCardProps {
  topMarket?: any;
  onTrade?: () => void;
  isTradePending?: boolean;
}

export function MarketOpportunityFlashCard({ onTrade }: MarketOpportunityCardProps) {
  const [flipped, setFlipped] = useState(false);
  const [executingSymbol, setExecutingSymbol] = useState<string | null>(null);
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);

  const executeTrade = useExecuteTrade();

  // Fetch all markets ranked by AI quality score
  const { data: allMarkets } = useQuery<any[]>({
    queryKey: ["markets", "ranked-all"],
    queryFn: () => fetch("/api/markets?limit=50").then(r => r.json()),
    refetchInterval: 8000,
  });

  // Fetch best recommendation (has full detail: stake, ticks, barrier, direction)
  const { data: bestRec } = useQuery<any>({
    queryKey: ["ai", "best-recommendation"],
    queryFn: () => fetch("/api/ai/recommendation").then(r => r.json()),
    refetchInterval: 8000,
  });

  // Markets that the AI considers tradeable, sorted by quality
  const tradeableMarkets = (allMarkets ?? []).filter((m: any) => m.shouldTrade);
  const top5 = tradeableMarkets.slice(0, 6);

  const bestMarket = allMarkets?.find((m: any) => m.symbol === bestRec?.symbol) ?? allMarkets?.[0];
  const rec = bestRec;

  const conf = rec?.confidence ?? 0;
  const contractType = rec?.contractType ?? bestMarket?.recommendedContractType ?? "CALL";
  const ctColor = contractColor(contractType);
  const glowColor = `${ctColor}40`;
  const isUp = contractToDirection(contractType) === "up";

  const handleExecute = (market: any, ct?: string, barrier?: number | null, stake?: number, direction?: string, duration?: number) => {
    const sym = market.symbol ?? market;
    const finalCt = ct ?? market.recommendedContractType ?? "CALL";
    const finalStake = stake ?? rec?.stake ?? 1;
    const finalDir = (direction ?? contractToDirection(finalCt)) as "up" | "down";
    const finalBarrier = barrier ?? (finalCt.includes("DIGIT") ? rec?.digitBarrier ?? undefined : undefined);
    const finalDuration = duration ?? rec?.recommendedDuration ?? 5;

    setExecutingSymbol(sym);
    executeTrade.mutate({
      data: {
        symbol: sym,
        contractType: finalCt,
        stake: finalStake,
        direction: finalDir,
        ...(finalBarrier != null && { barrier: finalBarrier }),
        duration: finalDuration,
        durationUnit: "t",
      } as any
    }, {
      onSuccess: (trade: any) => {
        const won = trade.status === "won";
        toast[won ? "success" : "error"](
          `${won ? "✓ Won" : "✗ Lost"} $${Math.abs(Number(trade.profit ?? 0)).toFixed(2)} on ${market.displayName ?? sym}`
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

  // ── Front: Quick Strike card ────────────────────────────────────────────────
  const front = (
    <div className="flex flex-col h-full p-5 gap-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Zap className="w-3.5 h-3.5 text-primary shrink-0" />
        <span className="text-[10px] font-mono uppercase tracking-widest text-primary/70">Quick Strike</span>
        <span className="ml-auto w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
      </div>

      {/* Market + confidence */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-base font-bold leading-tight truncate">{bestMarket?.displayName ?? "Scanning…"}</div>
          <div className="text-[11px] font-mono text-muted-foreground">{bestMarket?.symbol ?? "—"}</div>
          <div className="mt-1.5 flex items-center gap-1.5">
            {isUp ? <TrendingUp className="w-3 h-3 shrink-0" style={{ color: ctColor }} /> : <TrendingDown className="w-3 h-3 shrink-0" style={{ color: ctColor }} />}
            <span
              className="text-sm font-mono font-bold px-2 py-0.5 rounded-full border"
              style={{ color: ctColor, borderColor: `${ctColor}40`, background: `${ctColor}12` }}
            >
              {formatContractLabel(contractType, rec?.digitBarrier ?? rec?.barrier)}
            </span>
            <span className="text-[10px] text-muted-foreground font-mono capitalize">{bestMarket?.regime?.replace(/_/g, " ") ?? "—"}</span>
          </div>
        </div>
        <div className="flex flex-col items-center shrink-0">
          <ConfidenceArc value={conf} />
          <div className="text-[9px] font-mono text-muted-foreground -mt-1">confidence</div>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: "Win Prob", value: rec ? `${rec.winProbability?.toFixed(0) ?? conf.toFixed(0)}%` : "—" },
          { label: "EV", value: rec ? (rec.expectedValue > 0 ? `+$${rec.expectedValue.toFixed(2)}` : `$${rec.expectedValue?.toFixed(2) ?? "—"}`) : "—" },
          { label: "Ticks", value: rec ? `${rec.recommendedDuration ?? 5}t` : "—" },
        ].map(({ label, value }) => (
          <div key={label} className="text-center p-2 rounded-lg bg-white/[0.04] border border-white/[0.06]">
            <div className="text-[9px] text-muted-foreground uppercase tracking-wide">{label}</div>
            <div className="text-xs font-mono font-bold mt-0.5">{value}</div>
          </div>
        ))}
      </div>

      {/* Stake + Execute */}
      <div className="flex items-center justify-between mt-auto gap-3">
        <div>
          <div className="text-[9px] text-muted-foreground uppercase tracking-wide">AI Stake</div>
          <div className="text-xl font-mono font-bold" style={{ color: ctColor }}>
            ${rec?.stake?.toFixed(2) ?? "—"}
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (!bestMarket || !rec) return;
            handleExecute(bestMarket, contractType, rec.digitBarrier ?? rec.barrier, rec.stake, rec.direction, rec.recommendedDuration);
          }}
          disabled={!rec?.shouldTrade || executingSymbol === bestMarket?.symbol}
          className="flex-1 py-3 rounded-xl text-sm font-bold font-mono border transition-all active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            background: rec?.shouldTrade ? `${ctColor}18` : "transparent",
            borderColor: rec?.shouldTrade ? `${ctColor}60` : "rgba(255,255,255,0.1)",
            color: rec?.shouldTrade ? ctColor : "rgba(255,255,255,0.3)",
            boxShadow: rec?.shouldTrade ? `0 0 16px ${ctColor}25` : "none",
          }}
        >
          {executingSymbol === bestMarket?.symbol
            ? "EXECUTING…"
            : rec?.shouldTrade
              ? `⚡ EXECUTE`
              : "LOW CONF"}
        </button>
      </div>

      {/* Markets scanned indicator */}
      {allMarkets && (
        <div className="text-[9px] font-mono text-muted-foreground text-center -mt-1">
          {allMarkets.length} markets scanned · {tradeableMarkets.length} tradeable
        </div>
      )}
    </div>
  );

  // ── Back: Top opportunities ─────────────────────────────────────────────────
  const back = (
    <div className="flex flex-col p-4 gap-2 pb-10">
      <div className="flex items-center gap-2 mb-1">
        <Zap className="w-3 h-3 text-primary" />
        <span className="text-[10px] font-mono uppercase tracking-widest text-primary/70">Top Opportunities</span>
        <span className="text-[9px] text-muted-foreground ml-auto">{allMarkets?.length ?? 0} scanned</span>
      </div>

      {top5.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground py-8">
          Scanning markets for opportunities…
        </div>
      ) : (
        top5.map((market: any, idx: number) => {
          const ct = market.recommendedContractType ?? "CALL";
          const ctCol = contractColor(ct);
          const conf2 = market.confidenceScore ?? 0;
          const isExecuting = executingSymbol === market.symbol;
          const isExpanded = expandedSymbol === market.symbol;

          return (
            <div key={market.symbol} className="rounded-xl border border-white/[0.07] bg-white/[0.03] overflow-hidden">
              <div className="flex items-center gap-2.5 p-2.5">
                {/* Rank */}
                <div
                  className="w-5 h-5 rounded-full flex items-center justify-center shrink-0 text-[9px] font-bold"
                  style={{ background: idx === 0 ? `${ctCol}25` : "rgba(255,255,255,0.05)", color: idx === 0 ? ctCol : "rgba(255,255,255,0.4)" }}
                >
                  {idx + 1}
                </div>

                {/* Market info */}
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold leading-tight truncate">{market.displayName}</div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span
                      className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border"
                      style={{ color: ctCol, borderColor: `${ctCol}40`, background: `${ctCol}10` }}
                    >
                      {formatContractLabel(ct)}
                    </span>
                    <span className="text-[9px] font-mono text-muted-foreground">{conf2.toFixed(0)}%</span>
                  </div>
                </div>

                {/* Quality bar */}
                <div className="w-12 shrink-0">
                  <div className="h-1 w-full bg-white/10 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${market.qualityScore ?? 0}%`, background: ctCol }}
                    />
                  </div>
                  <div className="text-[8px] font-mono text-center text-muted-foreground mt-0.5">Q:{market.qualityScore?.toFixed(0) ?? 0}</div>
                </div>

                {/* Execute + expand */}
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={(e) => { e.stopPropagation(); setExpandedSymbol(isExpanded ? null : market.symbol); }}
                    className="p-1 rounded-lg border border-white/10 hover:border-primary/30 transition-colors"
                  >
                    {isExpanded ? <ChevronUp className="w-3 h-3 text-muted-foreground" /> : <ChevronDown className="w-3 h-3 text-muted-foreground" />}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleExecute(market, ct, null, undefined, contractToDirection(ct));
                    }}
                    disabled={isExecuting}
                    className="px-2 py-1 rounded-lg text-[9px] font-bold font-mono border transition-all active:scale-[0.97] disabled:opacity-40"
                    style={{
                      background: `${ctCol}15`,
                      borderColor: `${ctCol}50`,
                      color: ctCol,
                    }}
                  >
                    {isExecuting ? "…" : "⚡"}
                  </button>
                </div>
              </div>

              {/* Expanded details */}
              <AnimatePresence>
                {isExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div className="px-3 pb-2.5 grid grid-cols-3 gap-1.5 border-t border-white/[0.05] pt-2">
                      {[
                        { label: "Regime", value: market.regime?.replace(/_/g, " ") ?? "—" },
                        { label: "Trend", value: market.trend ?? "—" },
                        { label: "Volatility", value: market.volatility ?? "—" },
                      ].map(({ label, value }) => (
                        <div key={label} className="text-center">
                          <div className="text-[8px] text-muted-foreground uppercase">{label}</div>
                          <div className="text-[9px] font-mono font-bold capitalize">{value}</div>
                        </div>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })
      )}
    </div>
  );

  return (
    <FlashCard3D
      front={front}
      back={back}
      flipped={flipped}
      onFlip={() => setFlipped(f => !f)}
      glowColor={glowColor || "rgba(0,255,255,0.35)"}
      className="h-full min-h-[200px]"
    />
  );
}
