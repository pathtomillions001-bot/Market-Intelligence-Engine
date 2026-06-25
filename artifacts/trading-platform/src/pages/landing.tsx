import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { Brain, Zap, Shield, TrendingUp, ChevronRight, Activity, BarChart2, Cpu } from "lucide-react";

const AGENTS = [
  { icon: "🔭", name: "Market Scanner", desc: "Monitors all 17 synthetic indices simultaneously — zero latency." },
  { icon: "📈", name: "Trend Analysis", desc: "Random Forest + Gradient Boosting + Logistic Regression ensemble." },
  { icon: "⚡", name: "Volatility Analysis", desc: "Entropy-based Hurst exponent regime detection." },
  { icon: "🔍", name: "Pattern Recognition", desc: "Spectral + autocorrelation microstructure features." },
  { icon: "🛡️", name: "Risk Management", desc: "Dynamic stake sizing with volatility-adjusted exposure." },
  { icon: "💰", name: "Capital Preservation", desc: "Enforces loss limits, drawdown caps, daily targets." },
  { icon: "⚙️", name: "Trade Execution", desc: "Tick-velocity timing with optimal entry windows." },
  { icon: "🧠", name: "Self-Learning", desc: "Persisted win-rate DB per symbol × contract × barrier." },
];

const FEATURES = [
  { icon: <Zap className="w-5 h-5" />, label: "8 ML Agents" },
  { icon: <Activity className="w-5 h-5" />, label: "Live Deriv Markets" },
  { icon: <Shield className="w-5 h-5" />, label: "Auto Recovery" },
  { icon: <Brain className="w-5 h-5" />, label: "Self-Learning AI" },
  { icon: <BarChart2 className="w-5 h-5" />, label: "Expected Value Filter" },
  { icon: <TrendingUp className="w-5 h-5" />, label: "Digit Barrier Analysis" },
];

export default function LandingPage({ onEnter }: { onEnter: () => void }) {
  const [flipped, setFlipped] = useState(false);
  const [, setLocation] = useLocation();

  useEffect(() => {
    const timer = setInterval(() => setFlipped((f) => !f), 6000);
    return () => clearInterval(timer);
  }, []);

  const handleDemo = () => { onEnter(); };
  const handleDeriv = () => {
    window.location.href = "https://oauth.deriv.com/oauth2/authorize?app_id=1089&l=EN&brand=deriv";
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center relative overflow-hidden">
      {/* Animated grid background */}
      <div className="absolute inset-0 pointer-events-none" style={{
        backgroundImage: "linear-gradient(rgba(99,102,241,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,0.04) 1px, transparent 1px)",
        backgroundSize: "48px 48px",
      }} />

      {/* Radial glow */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[700px] rounded-full"
          style={{ background: "radial-gradient(circle, rgba(99,102,241,0.08) 0%, transparent 70%)" }} />
      </div>

      {/* Floating particles */}
      {[...Array(12)].map((_, i) => (
        <motion.div
          key={i}
          className="absolute w-1 h-1 rounded-full bg-indigo-500/30"
          style={{ left: `${8 + i * 8}%`, top: `${20 + (i % 4) * 20}%` }}
          animate={{ y: [-12, 12, -12], opacity: [0.2, 0.6, 0.2] }}
          transition={{ duration: 3 + i * 0.4, repeat: Infinity, ease: "easeInOut", delay: i * 0.3 }}
        />
      ))}

      <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}
        className="flex flex-col items-center gap-8 px-4 w-full max-w-2xl">

        {/* Logo + badge */}
        <div className="text-center space-y-2">
          <div className="flex items-center justify-center gap-2 mb-1">
            <Cpu className="w-6 h-6 text-indigo-400" />
            <span className="text-xs font-mono tracking-[0.3em] text-indigo-400 uppercase">NeuroTrade</span>
          </div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-white">
            AI-Powered{" "}
            <span className="text-transparent bg-clip-text" style={{
              backgroundImage: "linear-gradient(135deg, #818cf8 0%, #6366f1 50%, #4f46e5 100%)"
            }}>Trading</span>
          </h1>
          <p className="text-zinc-400 text-sm md:text-base max-w-md mx-auto">
            8-agent ML ensemble trading Deriv Synthetic Indices 24/7 with adaptive self-learning.
          </p>
        </div>

        {/* 3D Flip Card */}
        <div
          className="w-full max-w-lg cursor-pointer"
          style={{ perspective: "1200px", height: "280px" }}
          onClick={() => setFlipped((f) => !f)}
        >
          <motion.div
            style={{ transformStyle: "preserve-3d", position: "relative", width: "100%", height: "100%" }}
            animate={{ rotateY: flipped ? 180 : 0 }}
            transition={{ duration: 0.7, ease: [0.43, 0.13, 0.23, 0.96] }}
          >
            {/* Front */}
            <div style={{ backfaceVisibility: "hidden", position: "absolute", inset: 0 }}
              className="rounded-2xl border border-indigo-500/20 bg-zinc-900/90 backdrop-blur-sm p-6 shadow-2xl overflow-hidden">
              {/* Scan line animation */}
              <motion.div
                className="absolute left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-indigo-400/40 to-transparent pointer-events-none"
                animate={{ top: ["0%", "100%"] }}
                transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
              />
              {/* Neon corners */}
              {["top-0 left-0", "top-0 right-0", "bottom-0 left-0", "bottom-0 right-0"].map((pos, i) => (
                <div key={i} className={`absolute ${pos} w-4 h-4 border-indigo-500/60`}
                  style={{
                    borderTopWidth: pos.includes("top") ? "2px" : "0",
                    borderBottomWidth: pos.includes("bottom") ? "2px" : "0",
                    borderLeftWidth: pos.includes("left") ? "2px" : "0",
                    borderRightWidth: pos.includes("right") ? "2px" : "0",
                  }} />
              ))}

              <div className="flex items-start justify-between mb-5">
                <div>
                  <div className="text-[10px] font-mono text-indigo-400/70 tracking-widest uppercase mb-1">AI Engine • Active</div>
                  <div className="text-lg font-bold text-white">Market Opportunity Card</div>
                </div>
                <motion.div
                  className="w-10 h-10 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center"
                  animate={{ boxShadow: ["0 0 0px rgba(99,102,241,0.3)", "0 0 16px rgba(99,102,241,0.6)", "0 0 0px rgba(99,102,241,0.3)"] }}
                  transition={{ duration: 2, repeat: Infinity }}
                >
                  <Brain className="w-5 h-5 text-indigo-400" />
                </motion.div>
              </div>

              <div className="grid grid-cols-3 gap-2 mb-5">
                {FEATURES.map((f) => (
                  <div key={f.label} className="flex items-center gap-1.5 bg-white/3 rounded-lg px-2 py-1.5 border border-white/5">
                    <span className="text-indigo-400">{f.icon}</span>
                    <span className="text-[10px] text-zinc-300 font-medium">{f.label}</span>
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-3 text-xs text-zinc-500">
                <div className="flex items-center gap-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                  <span>17 synthetics live</span>
                </div>
                <div>•</div>
                <span>Click to see agents →</span>
              </div>
            </div>

            {/* Back */}
            <div style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)", position: "absolute", inset: 0 }}
              className="rounded-2xl border border-indigo-500/20 bg-zinc-900/90 backdrop-blur-sm p-5 shadow-2xl overflow-hidden">
              <motion.div
                className="absolute left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-purple-400/30 to-transparent"
                animate={{ top: ["0%", "100%"] }}
                transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
              />
              <div className="text-[10px] font-mono text-purple-400/70 tracking-widest uppercase mb-3">8 Autonomous Agents</div>
              <div className="grid grid-cols-2 gap-1.5">
                {AGENTS.map((a) => (
                  <div key={a.name} className="flex gap-2 bg-white/2 rounded-lg p-2 border border-white/5">
                    <span className="text-base leading-none mt-0.5">{a.icon}</span>
                    <div>
                      <div className="text-[10px] font-semibold text-zinc-200">{a.name}</div>
                      <div className="text-[9px] text-zinc-500 leading-relaxed mt-0.5">{a.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        </div>

        {/* CTA buttons */}
        <div className="flex flex-col sm:flex-row gap-3 w-full max-w-sm">
          <motion.button
            whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
            onClick={handleDeriv}
            className="flex-1 flex items-center justify-center gap-2 py-3 px-6 rounded-xl font-semibold text-sm text-white"
            style={{
              background: "linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)",
              boxShadow: "0 0 24px rgba(99,102,241,0.35)",
            }}
          >
            Continue with Deriv
            <ChevronRight className="w-4 h-4" />
          </motion.button>
          <motion.button
            whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
            onClick={handleDemo}
            className="flex-1 py-3 px-6 rounded-xl font-semibold text-sm text-zinc-300 border border-zinc-700 bg-zinc-800/50 hover:border-zinc-600 transition-colors"
          >
            Demo Mode
          </motion.button>
        </div>

        <p className="text-[11px] text-zinc-600 text-center max-w-xs">
          Connects securely to your Deriv account via OAuth. No credentials stored. Synthetic Indices only.
        </p>
      </motion.div>
    </div>
  );
}
