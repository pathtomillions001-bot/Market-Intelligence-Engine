import { motion } from "framer-motion";
import { Brain, Zap, Shield, TrendingUp, ChevronRight, Activity, BarChart2, Cpu, Check } from "lucide-react";

const AGENTS = [
  { icon: "🔭", name: "Market Scanner", desc: "Scans all 17 synthetics every 2–3s from live tick buffers" },
  { icon: "📈", name: "Trend Analysis", desc: "Random Forest + Gradient Boosting ensemble" },
  { icon: "⚡", name: "Volatility Analysis", desc: "Entropy-based Hurst exponent regime detection" },
  { icon: "🔍", name: "Pattern Recognition", desc: "Spectral + autocorrelation microstructure features" },
  { icon: "🛡️", name: "Risk Management", desc: "Dynamic stake sizing with volatility-adjusted exposure" },
  { icon: "💰", name: "Capital Preservation", desc: "Enforces loss limits, drawdown caps, daily targets" },
  { icon: "⚙️", name: "Trade Execution", desc: "Tick-velocity timing with optimal entry windows" },
  { icon: "🧠", name: "Self-Learning", desc: "Persisted win-rate DB per symbol × contract × barrier" },
];

const STATS = [
  { label: "Markets Monitored", value: "17", unit: "live" },
  { label: "Scan Speed", value: "<3", unit: "seconds" },
  { label: "Contract Types", value: "6", unit: "types" },
  { label: "ML Agents", value: "8", unit: "active" },
];

export default function LandingPage({ onEnter }: { onEnter: () => void }) {
  const handleDeriv = () => {
    window.location.href = "https://oauth.deriv.com/oauth2/authorize?app_id=1089&l=EN&brand=deriv";
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex flex-col overflow-x-hidden">
      {/* Background grid */}
      <div className="fixed inset-0 pointer-events-none" style={{
        backgroundImage: "linear-gradient(rgba(99,102,241,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,0.03) 1px, transparent 1px)",
        backgroundSize: "56px 56px",
      }} />
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[900px] h-[500px] rounded-full pointer-events-none"
        style={{ background: "radial-gradient(ellipse, rgba(99,102,241,0.06) 0%, transparent 65%)" }} />

      {/* Nav */}
      <nav className="relative z-10 flex items-center justify-between px-6 md:px-12 py-5 border-b border-white/5">
        <div className="flex items-center gap-2">
          <Cpu className="w-5 h-5 text-indigo-400" />
          <span className="font-bold text-white tracking-tight">NeuroTrade</span>
          <span className="text-[10px] font-mono text-indigo-400/70 tracking-widest uppercase ml-1 hidden sm:inline">AI</span>
        </div>
        <div className="flex items-center gap-2">
          <motion.button
            whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
            onClick={onEnter}
            className="px-4 py-1.5 rounded-lg text-sm text-zinc-400 border border-zinc-800 hover:border-zinc-600 transition-colors"
          >
            Demo
          </motion.button>
          <motion.button
            whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
            onClick={handleDeriv}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm text-white font-medium"
            style={{ background: "linear-gradient(135deg, #6366f1, #4f46e5)" }}
          >
            Connect Deriv
            <ChevronRight className="w-3.5 h-3.5" />
          </motion.button>
        </div>
      </nav>

      {/* Hero */}
      <div className="relative z-10 flex flex-col items-center justify-center text-center px-6 pt-16 pb-10">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-indigo-500/30 bg-indigo-500/5 mb-5">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            <span className="text-xs text-indigo-300">17 synthetic indices live</span>
          </div>
          <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight text-white leading-tight mb-4">
            AI Trading, <br className="hidden sm:block" />
            <span className="text-transparent bg-clip-text" style={{
              backgroundImage: "linear-gradient(135deg, #a5b4fc 0%, #818cf8 40%, #6366f1 100%)"
            }}>Fully Autonomous</span>
          </h1>
          <p className="text-zinc-400 text-base md:text-lg max-w-xl mx-auto mb-8 leading-relaxed">
            8-agent ML ensemble trading Deriv Synthetic Indices 24/7. Self-learning, adaptive recovery, real-time digit and directional analysis.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <motion.button
              whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
              onClick={handleDeriv}
              className="flex items-center justify-center gap-2 w-full sm:w-auto px-8 py-3.5 rounded-xl font-semibold text-white"
              style={{
                background: "linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)",
                boxShadow: "0 0 32px rgba(99,102,241,0.35)",
              }}
            >
              <Brain className="w-4 h-4" />
              Connect with Deriv
            </motion.button>
            <motion.button
              whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
              onClick={onEnter}
              className="flex items-center gap-2 w-full sm:w-auto px-8 py-3.5 rounded-xl font-semibold text-zinc-300 border border-zinc-700 bg-zinc-900/50"
            >
              Explore in Demo Mode
            </motion.button>
          </div>
          <p className="text-xs text-zinc-600 mt-4">OAuth — no credentials stored · Synthetic Indices only</p>
        </motion.div>
      </div>

      {/* Stats row */}
      <motion.div
        initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.5 }}
        className="relative z-10 grid grid-cols-2 sm:grid-cols-4 gap-3 px-6 md:px-12 pb-10 max-w-4xl mx-auto w-full"
      >
        {STATS.map((s) => (
          <div key={s.label} className="flex flex-col items-center text-center p-4 rounded-xl border border-white/5 bg-white/2">
            <div className="text-2xl font-bold text-white font-mono">{s.value}</div>
            <div className="text-[10px] text-indigo-400 font-medium uppercase tracking-wider">{s.unit}</div>
            <div className="text-xs text-zinc-500 mt-1">{s.label}</div>
          </div>
        ))}
      </motion.div>

      {/* Two-column: features + agents */}
      <motion.div
        initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3, duration: 0.5 }}
        className="relative z-10 grid grid-cols-1 md:grid-cols-2 gap-4 px-6 md:px-12 pb-16 max-w-4xl mx-auto w-full"
      >
        {/* Features card */}
        <div className="rounded-2xl border border-white/8 bg-zinc-900/60 p-6 space-y-3">
          <div className="text-[10px] font-mono text-indigo-400/80 tracking-widest uppercase mb-4">Platform Features</div>
          {[
            { icon: <Zap className="w-4 h-4 text-indigo-400" />, label: "Real-time digit analysis", desc: "Live OVER/UNDER distribution per tick" },
            { icon: <TrendingUp className="w-4 h-4 text-indigo-400" />, label: "Rise & Fall + Put & Call analysis", desc: "Trend momentum with streak detection" },
            { icon: <Activity className="w-4 h-4 text-indigo-400" />, label: "Millisecond market scanning", desc: "All 17 markets from in-memory tick buffers" },
            { icon: <Shield className="w-4 h-4 text-indigo-400" />, label: "Adaptive recovery system", desc: "Switches contract type to cover losses" },
            { icon: <BarChart2 className="w-4 h-4 text-indigo-400" />, label: "Self-learning ML models", desc: "Win-rate DB per symbol × contract × barrier" },
            { icon: <Brain className="w-4 h-4 text-indigo-400" />, label: "No fixed confidence threshold", desc: "Engine decides autonomously from context" },
          ].map((f) => (
            <div key={f.label} className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                {f.icon}
              </div>
              <div>
                <div className="text-sm font-medium text-zinc-200">{f.label}</div>
                <div className="text-xs text-zinc-500">{f.desc}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Agents card */}
        <div className="rounded-2xl border border-white/8 bg-zinc-900/60 p-6">
          <div className="text-[10px] font-mono text-purple-400/80 tracking-widest uppercase mb-4">8 Autonomous ML Agents</div>
          <div className="space-y-2">
            {AGENTS.map((a) => (
              <div key={a.name} className="flex items-start gap-3 p-2.5 rounded-lg bg-white/2 border border-white/5">
                <span className="text-lg leading-none">{a.icon}</span>
                <div>
                  <div className="text-xs font-semibold text-zinc-200">{a.name}</div>
                  <div className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">{a.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </motion.div>

      {/* Footer CTA */}
      <div className="relative z-10 border-t border-white/5 py-8 px-6 text-center">
        <p className="text-zinc-500 text-sm mb-3">Ready to start trading with AI?</p>
        <motion.button
          whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
          onClick={handleDeriv}
          className="inline-flex items-center gap-2 px-6 py-3 rounded-xl font-semibold text-white text-sm"
          style={{ background: "linear-gradient(135deg, #6366f1, #4f46e5)", boxShadow: "0 0 24px rgba(99,102,241,0.3)" }}
        >
          Connect Deriv Account
          <ChevronRight className="w-4 h-4" />
        </motion.button>
      </div>
    </div>
  );
}
