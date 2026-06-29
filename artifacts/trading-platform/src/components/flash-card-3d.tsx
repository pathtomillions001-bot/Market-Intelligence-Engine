import { useState } from "react";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";

interface FlashCard3DProps {
  front: React.ReactNode;
  back: React.ReactNode;
  className?: string;
  glowColor?: string;
}

export function FlashCard3D({ front, back, className = "", glowColor = "rgba(0,255,255,0.35)" }: FlashCard3DProps) {
  const [flipped, setFlipped] = useState(false);

  return (
    <div
      className={`relative cursor-pointer select-none ${className}`}
      style={{ perspective: "1200px" }}
      onClick={() => setFlipped((f) => !f)}
    >
      <motion.div
        animate={{ rotateY: flipped ? 180 : 0 }}
        transition={{ duration: 0.55, ease: [0.4, 0, 0.2, 1] }}
        style={{ transformStyle: "preserve-3d", position: "relative", width: "100%", height: "100%" }}
      >
        {/* Front */}
        <div
          style={{ backfaceVisibility: "hidden", WebkitBackfaceVisibility: "hidden" }}
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

            <div className="relative z-10 w-full h-full flex flex-col">
              {front}
            </div>

            <div className="absolute bottom-3 right-4 text-[10px] font-mono text-primary/40 tracking-widest uppercase">
              tap to flip ↻
            </div>
          </div>
        </div>

        {/* Back */}
        <div
          style={{ backfaceVisibility: "hidden", WebkitBackfaceVisibility: "hidden", transform: "rotateY(180deg)" }}
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

            <div className="relative z-10 w-full h-full flex flex-col">
              {back}
            </div>

            <div className="absolute bottom-3 right-4 text-[10px] font-mono text-primary/40 tracking-widest uppercase">
              tap to flip ↻
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}


interface MarketOpportunityCardProps {
  topMarket: {
    symbol: string;
    displayName: string;
    category: string;
    recommendation?: {
      confidence: number;
      direction?: string;
      contractType?: string;
      stake?: number;
      shouldTrade?: boolean;
      digitBarrier?: number | null;
      barrier?: number | null;
    } | null;
  } | undefined;
  onTrade?: () => void;
  isTradePending?: boolean;
}

type FilterType = "auto" | "rise-fall" | "even-odd" | "over-under";

const FILTER_OPTIONS: { id: FilterType; label: string; contractTypes: string }[] = [
  { id: "auto",       label: "Auto",       contractTypes: "" },
  { id: "rise-fall",  label: "Rise/Fall",  contractTypes: "CALL,PUT" },
  { id: "even-odd",   label: "Even/Odd",   contractTypes: "DIGITEVEN,DIGITODD" },
  { id: "over-under", label: "Over/Under", contractTypes: "DIGITOVER,DIGITUNDER" },
];

function formatContractLabel(contractType?: string, digitBarrier?: number | null): string {
  if (!contractType) return "—";
  if (contractType === "DIGITOVER") return digitBarrier != null ? `OVER ${digitBarrier}` : "OVER";
  if (contractType === "DIGITUNDER") return digitBarrier != null ? `UNDER ${digitBarrier}` : "UNDER";
  return contractType;
}

function ConfidenceArc({ value }: { value: number }) {
  const r = 38;
  const circ = Math.PI * r;
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

export function MarketOpportunityFlashCard({ topMarket, onTrade, isTradePending }: MarketOpportunityCardProps) {
  const [filterType, setFilterType] = useState<FilterType>("auto");

  const activeFilter = FILTER_OPTIONS.find(f => f.id === filterType)!;

  const { data: filteredMarket } = useQuery<typeof topMarket>({
    queryKey: ["markets", "top", filterType],
    queryFn: () =>
      fetch(`/api/markets/top?contractTypeFilter=${activeFilter.contractTypes}`)
        .then(r => r.json()),
    refetchInterval: 8000,
    enabled: filterType !== "auto",
  });

  const displayMarket = filterType === "auto" ? topMarket : filteredMarket;

  const conf = displayMarket?.recommendation?.confidence ?? 0;
  const confColor = conf >= 70 ? "#10b981" : conf >= 50 ? "#f59e0b" : "#ef4444";
  const glowColor = conf >= 70 ? "rgba(16,185,129,0.3)" : conf >= 50 ? "rgba(245,158,11,0.3)" : "rgba(0,255,255,0.3)";

  const front = (
    <div className="flex flex-col h-full p-5 gap-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="text-[10px] font-mono uppercase tracking-widest text-primary/70">Best Opportunity</div>
            {filterType !== "auto" && (
              <span className="px-1.5 py-0.5 rounded text-[9px] font-mono uppercase tracking-wide bg-primary/10 text-primary border border-primary/20">
                {activeFilter.label}
              </span>
            )}
          </div>
          <div className="text-lg font-bold leading-tight">{displayMarket?.displayName ?? "Scanning…"}</div>
          <div className="text-xs font-mono text-muted-foreground">{displayMarket?.symbol ?? "—"}</div>
        </div>
        <div className="flex flex-col items-center">
          <ConfidenceArc value={conf} />
          <div className="text-[9px] font-mono text-muted-foreground -mt-1">confidence</div>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {displayMarket?.recommendation?.direction && (
          <span
            className="px-2.5 py-0.5 rounded-full text-[11px] font-bold font-mono border"
            style={{ color: displayMarket.recommendation.direction === "up" ? "#10b981" : "#ef4444", borderColor: displayMarket.recommendation.direction === "up" ? "rgba(16,185,129,0.3)" : "rgba(239,68,68,0.3)" }}
          >
            {displayMarket.recommendation.direction.toUpperCase()} · {formatContractLabel(displayMarket.recommendation.contractType, displayMarket.recommendation.digitBarrier ?? displayMarket.recommendation.barrier)}
          </span>
        )}
        {displayMarket?.category && (
          <span className="px-2 py-0.5 rounded-full text-[11px] text-muted-foreground border border-border font-mono">
            {displayMarket.category}
          </span>
        )}
      </div>

      <div className="mt-auto flex items-center justify-between">
        <div>
          <div className="text-[10px] text-muted-foreground uppercase">Stake</div>
          <div className="font-mono font-bold text-lg">${displayMarket?.recommendation?.stake?.toFixed(2) ?? "—"}</div>
        </div>

        <button
          onClick={(e) => { e.stopPropagation(); onTrade?.(); }}
          disabled={isTradePending || !displayMarket?.recommendation?.shouldTrade}
          className="px-4 py-2 rounded-xl text-xs font-bold font-mono border transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            background: displayMarket?.recommendation?.shouldTrade ? `${confColor}18` : "transparent",
            borderColor: displayMarket?.recommendation?.shouldTrade ? `${confColor}60` : "rgba(255,255,255,0.1)",
            color: displayMarket?.recommendation?.shouldTrade ? confColor : "rgba(255,255,255,0.3)",
            boxShadow: displayMarket?.recommendation?.shouldTrade ? `0 0 12px ${confColor}30` : "none",
          }}
        >
          {isTradePending ? "EXECUTING…" : displayMarket?.recommendation?.shouldTrade ? "EXECUTE" : "LOW CONF"}
        </button>
      </div>
    </div>
  );

  const back = (
    <div className="flex flex-col h-full p-5 gap-3">
      <div className="text-[10px] font-mono uppercase tracking-widest text-primary/70">Market Type Filter</div>

      <div className="grid grid-cols-2 gap-2">
        {FILTER_OPTIONS.map((opt) => {
          const isActive = filterType === opt.id;
          return (
            <button
              key={opt.id}
              onClick={(e) => { e.stopPropagation(); setFilterType(opt.id); }}
              className="relative py-2 px-3 rounded-xl text-xs font-bold font-mono border transition-all"
              style={{
                background: isActive ? "rgba(0,255,255,0.08)" : "rgba(255,255,255,0.02)",
                borderColor: isActive ? "rgba(0,255,255,0.4)" : "rgba(255,255,255,0.07)",
                color: isActive ? "#00ffff" : "rgba(255,255,255,0.45)",
                boxShadow: isActive ? "0 0 10px rgba(0,255,255,0.15)" : "none",
              }}
            >
              {isActive && (
                <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
              )}
              {opt.label}
            </button>
          );
        })}
      </div>

      <div className="mt-1 space-y-2">
        <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-wide">Signal Analysis</div>
        <div className="grid grid-cols-2 gap-2">
          {[
            { label: "Signal", value: displayMarket?.recommendation?.direction?.toUpperCase() ?? "—" },
            { label: "Type", value: formatContractLabel(displayMarket?.recommendation?.contractType, displayMarket?.recommendation?.digitBarrier) },
            { label: "Confidence", value: `${conf.toFixed(1)}%` },
            { label: "Stake", value: `$${displayMarket?.recommendation?.stake?.toFixed(2) ?? "0.00"}` },
          ].map((item) => (
            <div key={item.label} className="bg-white/[0.03] rounded-xl p-2.5 border border-white/[0.06]">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">{item.label}</div>
              <div className="font-mono font-bold text-sm text-foreground">{item.value}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-auto space-y-1">
        <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-wide">Confidence</div>
        <div className="h-2 w-full bg-zinc-800 rounded-full overflow-hidden">
          <motion.div
            className="h-full rounded-full"
            initial={{ width: 0 }}
            animate={{ width: `${conf}%` }}
            transition={{ duration: 0.8, ease: "easeOut" }}
            style={{ background: `linear-gradient(90deg, ${confColor}80, ${confColor})` }}
          />
        </div>
        <div className="flex justify-between text-[10px] font-mono text-muted-foreground">
          <span>0%</span><span>50%</span><span>100%</span>
        </div>
      </div>
    </div>
  );

  return (
    <FlashCard3D
      front={front}
      back={back}
      glowColor={glowColor}
      className="h-full min-h-[200px]"
    />
  );
}
