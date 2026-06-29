import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useExecuteTrade } from "@workspace/api-client-react";
import { toast } from "sonner";
import { Zap, TrendingUp, TrendingDown, ChevronDown, ChevronUp } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

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

function ConfidenceArc({ value }: { value: number }) {
  const r = 32, circ = Math.PI * r;
  const offset = circ - (value / 100) * circ;
  const color = value >= 70 ? "#10b981" : value >= 50 ? "#f59e0b" : "#ef4444";
  return (
    <svg width="76" height="44" viewBox="0 0 76 44">
      <path d="M 6 42 A 32 32 0 0 1 70 42" fill="none" stroke="#27272a" strokeWidth="5" strokeLinecap="round" />
      <path d="M 6 42 A 32 32 0 0 1 70 42" fill="none" stroke={color} strokeWidth="5" strokeLinecap="round"
        strokeDasharray={circ} strokeDashoffset={offset}
        style={{ transition: "stroke-dashoffset 0.8s ease, stroke 0.4s" }} />
      <text x="38" y="40" textAnchor="middle" fill={color} fontSize="12" fontFamily="monospace" fontWeight="bold">
        {value.toFixed(0)}%
      </text>
    </svg>
  );
}

// ── FlashCard3D kept for compatibility (no longer used for flip) ───────────────
export function FlashCard3D({ front }: { front: React.ReactNode; back?: React.ReactNode; flipped?: boolean; onFlip?: () => void; className?: string; glowColor?: string }) {
  return <div className="w-full h-full">{front}</div>;
}

// ── Quick Strike Card ──────────────────────────────────────────────────────────
interface MarketOpportunityCardProps {
  topMarket?: any;
  onTrade?: () => void;
  isTradePending?: boolean;
}

export function MarketOpportunityFlashCard({ onTrade }: MarketOpportunityCardProps) {
  const [executingSymbol, setExecutingSymbol] = useState<string | null>(null);
  const [showMarkets, setShowMarkets] = useState(false);

  const executeTrade = useExecuteTrade();

  const { data: allMarkets } = useQuery<any[]>({
    queryKey: ["markets", "ranked-all"],
    queryFn: () => fetch("/api/markets?limit=50").then(r => r.json()),
    refetchInterval: 8000,
  });

  const { data: bestRec } = useQuery<any>({
    queryKey: ["ai", "best-recommendation"],
    queryFn: () => fetch("/api/ai/recommendation").then(r => r.json()),
    refetchInterval: 8000,
  });

  const tradeableMarkets = (allMarkets ?? []).filter((m: any) => m.shouldTrade);
  const top5 = tradeableMarkets.slice(0, 5);
  const bestMarket = allMarkets?.find((m: any) => m.symbol === bestRec?.symbol) ?? allMarkets?.[0];
  const rec = bestRec;

  const conf = rec?.confidence ?? 0;
  const contractType: string = rec?.contractType ?? bestMarket?.recommendedContractType ?? "CALL";
  const ctColor = contractColor(contractType);
  const isUp = contractToDirection(contractType) === "up";

  const handleExecute = (market: any, ct?: string, barrier?: number | null, stake?: number, direction?: string, duration?: number) => {
    const sym = typeof market === "string" ? market : market?.symbol;
    const finalCt = ct ?? market?.recommendedContractType ?? "CALL";
    const finalStake = stake ?? rec?.stake ?? 1;
    const finalDir = (direction ?? contractToDirection(finalCt)) as "up" | "down";
    const finalBarrier = barrier ?? (finalCt.includes("DIGIT") && rec?.digitBarrier != null ? rec.digitBarrier : undefined);
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
          `${won ? "✓ Won" : "✗ Lost"} $${Math.abs(Number(trade.profit ?? 0)).toFixed(2)} on ${market?.displayName ?? sym}`
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

  const isExecuting = executingSymbol === bestMarket?.symbol;

  return (
    <div
      className="relative w-full h-full rounded-2xl border border-primary/30 bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-950 overflow-hidden"
      style={{ boxShadow: `0 0 30px ${ctColor}30, 0 0 60px ${ctColor}10, inset 0 1px 0 rgba(255,255,255,0.05)` }}
    >
      {/* Corner accents */}
      <span className="absolute top-0 left-0 w-5 h-5 border-t-2 border-l-2 border-primary rounded-tl-2xl" />
      <span className="absolute top-0 right-0 w-5 h-5 border-t-2 border-r-2 border-primary rounded-tr-2xl" />
      <span className="absolute bottom-0 left-0 w-5 h-5 border-b-2 border-l-2 border-primary rounded-bl-2xl" />
      <span className="absolute bottom-0 right-0 w-5 h-5 border-b-2 border-r-2 border-primary rounded-br-2xl" />

      {/* Scan line */}
      <motion.div
        className="absolute inset-x-0 h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent"
        animate={{ top: ["0%", "100%", "0%"] }}
        transition={{ duration: 4, ease: "linear", repeat: Infinity }}
      />

      {/* Grid overlay */}
      <div className="absolute inset-0 opacity-[0.025]" style={{
        backgroundImage: "linear-gradient(rgba(0,255,255,1) 1px, transparent 1px), linear-gradient(90deg, rgba(0,255,255,1) 1px, transparent 1px)",
        backgroundSize: "20px 20px"
      }} />

      <div className="relative z-10 p-4 flex flex-col gap-3 h-full">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Zap className="w-3.5 h-3.5 text-primary shrink-0" />
          <span className="text-[10px] font-mono uppercase tracking-widest text-primary/70">Quick Strike</span>
          <span className="ml-auto w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
        </div>

        {/* Main row: Market info | Confidence | Execute */}
        <div className="flex items-center gap-3">
          {/* Left: Market info */}
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold leading-tight truncate">{bestMarket?.displayName ?? "Scanning…"}</div>
            <div className="text-[10px] font-mono text-muted-foreground">{bestMarket?.symbol ?? "—"}</div>
            <div className="mt-2 flex items-center gap-1.5">
              {isUp
                ? <TrendingUp className="w-3 h-3 shrink-0" style={{ color: ctColor }} />
                : <TrendingDown className="w-3 h-3 shrink-0" style={{ color: ctColor }} />}
              <span
                className="text-sm font-mono font-bold px-2 py-0.5 rounded-full border"
                style={{ color: ctColor, borderColor: `${ctColor}50`, background: `${ctColor}15` }}
              >
                {formatContractLabel(contractType, rec?.digitBarrier ?? rec?.barrier)}
              </span>
              <span className="text-[9px] text-muted-foreground font-mono capitalize truncate">{bestMarket?.regime?.replace(/_/g, " ") ?? ""}</span>
            </div>
          </div>

          {/* Center: Confidence arc */}
          <div className="flex flex-col items-center shrink-0">
            <ConfidenceArc value={conf} />
            <div className="text-[8px] font-mono text-muted-foreground -mt-0.5">confidence</div>
          </div>

          {/* Right: Execute button */}
          <div className="shrink-0">
            <button
              onClick={() => {
                if (!bestMarket || !rec) return;
                handleExecute(bestMarket, contractType, rec.digitBarrier ?? rec.barrier, rec.stake, rec.direction, rec.recommendedDuration);
              }}
              disabled={!rec?.shouldTrade || isExecuting}
              className="flex flex-col items-center justify-center w-16 h-16 rounded-xl border-2 font-bold font-mono text-[10px] transition-all active:scale-[0.95] disabled:opacity-40 disabled:cursor-not-allowed"
              style={rec?.shouldTrade ? {
                borderColor: ctColor,
                background: `${ctColor}20`,
                color: ctColor,
                boxShadow: `0 0 20px ${ctColor}30`,
              } : {
                borderColor: "rgba(255,255,255,0.1)",
                color: "rgba(255,255,255,0.3)",
              }}
            >
              {isExecuting ? (
                <span className="text-[8px] leading-tight text-center">EXEC…</span>
              ) : rec?.shouldTrade ? (
                <>
                  <span className="text-lg leading-none">⚡</span>
                  <span className="text-[8px] mt-0.5 uppercase tracking-widest">Execute</span>
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

        {/* Stats row */}
        <div className="grid grid-cols-4 gap-1.5">
          {[
            { label: "Win Prob", value: rec ? `${rec.winProbability?.toFixed(0) ?? conf.toFixed(0)}%` : "—" },
            { label: "EV", value: rec ? (rec.expectedValue > 0 ? `+$${rec.expectedValue.toFixed(2)}` : `$${rec.expectedValue?.toFixed(2) ?? "—"}`) : "—" },
            { label: "Ticks", value: rec ? `${rec.recommendedDuration ?? 5}t` : "—" },
            { label: "Stake", value: rec ? `$${rec.stake?.toFixed(2) ?? "—"}` : "—" },
          ].map(({ label, value }) => (
            <div key={label} className="text-center p-1.5 rounded-lg bg-white/[0.04] border border-white/[0.06]">
              <div className="text-[8px] text-muted-foreground uppercase tracking-wide">{label}</div>
              <div className="text-[11px] font-mono font-bold mt-0.5">{value}</div>
            </div>
          ))}
        </div>

        {/* Footer: markets count + expand toggle */}
        <div className="flex items-center justify-between mt-auto">
          <span className="text-[9px] font-mono text-muted-foreground">
            {allMarkets?.length ?? 0} markets scanned · {tradeableMarkets.length} tradeable
          </span>
          {top5.length > 0 && (
            <button
              onClick={() => setShowMarkets(s => !s)}
              className="flex items-center gap-1 text-[9px] font-mono text-primary/50 hover:text-primary transition-colors"
            >
              Top 5 {showMarkets ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          )}
        </div>

        {/* Expandable top-5 list */}
        <AnimatePresence>
          {showMarkets && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="space-y-1 pt-1 border-t border-white/[0.07]">
                {top5.map((market: any, idx: number) => {
                  const ct = market.recommendedContractType ?? "CALL";
                  const ctCol = contractColor(ct);
                  const isExec = executingSymbol === market.symbol;
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
                      <span className="text-[9px] font-mono text-muted-foreground w-8 text-right">{market.confidenceScore?.toFixed(0) ?? 0}%</span>
                      <button
                        onClick={() => handleExecute(market, ct, null, undefined, contractToDirection(ct))}
                        disabled={isExec}
                        className="px-2 py-0.5 rounded text-[8px] font-bold font-mono border transition-all active:scale-[0.97] disabled:opacity-40"
                        style={{ background: `${ctCol}15`, borderColor: `${ctCol}50`, color: ctCol }}
                      >
                        {isExec ? "…" : "⚡"}
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
