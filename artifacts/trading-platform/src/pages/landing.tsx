import { motion } from "framer-motion";
import { Brain, Zap, Shield, TrendingUp, ChevronRight, Activity, BarChart2, Cpu } from "lucide-react";

const AGENTS = [
  { icon: "🔭", name: "Market Scanner", desc: "Scans all 17 synthetics in milliseconds" },
  { icon: "📈", name: "Trend Analysis", desc: "RF + GBM ensemble direction model" },
  { icon: "⚡", name: "Volatility", desc: "Hurst exponent regime detection" },
  { icon: "🔍", name: "Pattern Recognition", desc: "Spectral + autocorrelation features" },
  { icon: "🛡️", name: "Risk Management", desc: "Dynamic stake with volatility exposure" },
  { icon: "💰", name: "Capital Preservation", desc: "Loss limits, drawdown caps, targets" },
  { icon: "⚙️", name: "Trade Execution", desc: "Tick-velocity optimal entry timing" },
  { icon: "🧠", name: "Self-Learning", desc: "Win-rate DB per symbol × contract × barrier" },
];

const FEATURES = [
  { icon: <Zap className="w-4 h-4" />, label: "8 ML Agents" },
  { icon: <Activity className="w-4 h-4" />, label: "Live Digit Analysis" },
  { icon: <TrendingUp className="w-4 h-4" />, label: "Rise & Fall · Over & Under" },
  { icon: <Shield className="w-4 h-4" />, label: "Adaptive Recovery" },
  { icon: <BarChart2 className="w-4 h-4" />, label: "Self-Learning AI" },
  { icon: <Brain className="w-4 h-4" />, label: "17 Synthetic Indices" },
];

export default function LandingPage({ onEnter }: { onEnter: () => void }) {
  const handleDeriv = () => {
    window.location.href = "https://oauth.deriv.com/oauth2/authorize?app_id=1089&l=EN&brand=deriv";
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4 overflow-hidden">
      {/* Subtle background */}
      <div className="absolute inset-0 pointer-events-none" style={{
        backgroundImage: "linear-gradient(rgba(99,102,241,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,0.03) 1px, transparent 1px)",
        backgroundSize: "60px 60px",
      }} />
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] pointer-events-none"
        style={{ background: "radial-gradient(circle, rgba(99,102,241,0.07) 0%, transparent 70%)" }} />

      <motion.div
        initial={{ opacity: 0, y: 24, rotateX: 6 }}
        animate={{ opacity: 1, y: 0, rotateX: 0 }}
        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        className="relative z-10 w-full max-w-[480px]"
        style={{ perspective: "1200px" }}
      >
        {/* 3D Card — single face, no flip */}
        <div
          className="relative rounded-3xl overflow-hidden"
          style={{
            background: "linear-gradient(145deg, #18181b 0%, #0f0f11 60%, #111116 100%)",
            boxShadow: "0 32px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.06), inset 0 1px 0 rgba(255,255,255,0.08)",
            transform: "rotateX(4deg) rotateY(-2deg)",
            transformStyle: "preserve-3d",
          }}
        >
          {/* Shimmer stripe */}
          <div className="absolute top-0 left-0 right-0 h-px"
            style={{ background: "linear-gradient(90deg, transparent, rgba(99,102,241,0.6), transparent)" }} />

          {/* Corner accent */}
          <div className="absolute top-0 right-0 w-24 h-24 pointer-events-none"
            style={{ background: "radial-gradient(circle at top right, rgba(99,102,241,0.12), transparent 70%)" }} />

          <div className="p-7">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center">
                  <Cpu className="w-4.5 h-4.5 text-indigo-400" />
                </div>
                <div>
                  <div className="font-bold text-white text-sm tracking-tight">NeuroTrade AI</div>
                  <div className="text-[10px] text-indigo-400/70 font-mono tracking-widest">SYNTHETIC INDICES</div>
                </div>
              </div>
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-green-500/30 bg-green-500/5">
                <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                <span className="text-[10px] text-green-400 font-medium">17 live</span>
              </div>
            </div>

            {/* Title */}
            <div className="mb-5">
              <h1 className="text-2xl font-bold text-white tracking-tight leading-snug mb-1.5">
                AI-Powered Trading,<br />
                <span className="text-transparent bg-clip-text" style={{
                  backgroundImage: "linear-gradient(135deg, #a5b4fc 0%, #818cf8 50%, #6366f1 100%)"
                }}>Fully Autonomous</span>
              </h1>
              <p className="text-zinc-500 text-xs leading-relaxed">
                8-agent ML ensemble. Live digit + directional analysis. Self-learning across all Deriv Synthetic Indices.
              </p>
            </div>

            {/* Feature chips */}
            <div className="grid grid-cols-3 gap-1.5 mb-5">
              {FEATURES.map((f) => (
                <div key={f.label} className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg border border-white/5 bg-white/2">
                  <span className="text-indigo-400 flex-shrink-0">{f.icon}</span>
                  <span className="text-[10px] text-zinc-300 font-medium leading-tight">{f.label}</span>
                </div>
              ))}
            </div>

            {/* Agent list — compact 2-col */}
            <div className="grid grid-cols-2 gap-1 mb-5">
              {AGENTS.map((a) => (
                <div key={a.name} className="flex items-start gap-1.5 p-2 rounded-lg bg-zinc-900/60 border border-white/4">
                  <span className="text-sm leading-none mt-px">{a.icon}</span>
                  <div>
                    <div className="text-[10px] font-semibold text-zinc-200">{a.name}</div>
                    <div className="text-[9px] text-zinc-600 leading-relaxed mt-px">{a.desc}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Divider */}
            <div className="h-px bg-white/5 mb-5" />

            {/* CTAs */}
            <div className="space-y-2">
              <motion.button
                whileHover={{ scale: 1.015 }} whileTap={{ scale: 0.985 }}
                onClick={handleDeriv}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-sm text-white"
                style={{
                  background: "linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)",
                  boxShadow: "0 0 28px rgba(99,102,241,0.35), inset 0 1px 0 rgba(255,255,255,0.12)",
                }}
              >
                <Brain className="w-4 h-4" />
                Continue with Deriv
                <ChevronRight className="w-3.5 h-3.5" />
              </motion.button>
              <motion.button
                whileHover={{ scale: 1.015 }} whileTap={{ scale: 0.985 }}
                onClick={onEnter}
                className="w-full py-2.5 rounded-xl font-medium text-sm text-zinc-400 border border-zinc-800 bg-zinc-900/50 hover:border-zinc-700 hover:text-zinc-300 transition-colors"
              >
                Explore Demo Mode
              </motion.button>
            </div>
            <p className="text-[10px] text-zinc-700 text-center mt-3">OAuth · No credentials stored · Synthetic Indices only</p>
          </div>
        </div>

        {/* Card reflection / floor shadow */}
        <div className="h-8 mx-8 rounded-b-full opacity-30"
          style={{ background: "linear-gradient(to bottom, rgba(99,102,241,0.15), transparent)", filter: "blur(12px)" }} />
      </motion.div>
    </div>
  );
}
