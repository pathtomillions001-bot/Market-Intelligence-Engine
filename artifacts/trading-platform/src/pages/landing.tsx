import { motion } from "framer-motion";
import { Brain, ChevronRight, Activity } from "lucide-react";
import { useEffect, useRef } from "react";

function NeuralOrb() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width = 220;
    const H = canvas.height = 220;
    const cx = W / 2, cy = H / 2;
    let frame = 0;

    const nodes = Array.from({ length: 14 }, (_, i) => {
      const angle = (i / 14) * Math.PI * 2;
      const r = 62 + Math.random() * 24;
      return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r, phase: Math.random() * Math.PI * 2 };
    });

    function draw() {
      if (!ctx) return;
      ctx.clearRect(0, 0, W, H);

      const t = frame * 0.012;

      // Outer glow ring
      const grad = ctx.createRadialGradient(cx, cy, 30, cx, cy, 100);
      grad.addColorStop(0, "rgba(99,102,241,0.18)");
      grad.addColorStop(0.5, "rgba(99,102,241,0.06)");
      grad.addColorStop(1, "rgba(99,102,241,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, 100, 0, Math.PI * 2);
      ctx.fill();

      // Orbit rings
      for (let r = 0; r < 3; r++) {
        const radius = 44 + r * 22;
        const rot = t * (r % 2 === 0 ? 1 : -1) * (0.4 + r * 0.15);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(rot);
        ctx.strokeStyle = `rgba(99,102,241,${0.18 - r * 0.04})`;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 8 + r * 4]);
        ctx.beginPath();
        ctx.ellipse(0, 0, radius, radius * 0.38, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // Connections
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i].x - nodes[j].x;
          const dy = nodes[i].y - nodes[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 80) {
            const alpha = (1 - dist / 80) * 0.3 * Math.abs(Math.sin(t * 0.5 + i * 0.4));
            ctx.strokeStyle = `rgba(139,92,246,${alpha})`;
            ctx.lineWidth = 0.7;
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.moveTo(nodes[i].x, nodes[i].y);
            ctx.lineTo(nodes[j].x, nodes[j].y);
            ctx.stroke();
          }
        }
      }

      // Nodes
      nodes.forEach((n, i) => {
        const pulse = 0.5 + 0.5 * Math.sin(t * 1.2 + n.phase);
        const alpha = 0.4 + pulse * 0.55;
        const size = 2 + pulse * 2.5;
        ctx.beginPath();
        ctx.arc(n.x, n.y, size, 0, Math.PI * 2);
        ctx.fillStyle = i % 3 === 0 ? `rgba(165,180,252,${alpha})` : `rgba(99,102,241,${alpha})`;
        ctx.fill();
      });

      // Center core
      const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 28);
      coreGrad.addColorStop(0, "rgba(165,180,252,0.9)");
      coreGrad.addColorStop(0.4, "rgba(99,102,241,0.5)");
      coreGrad.addColorStop(1, "rgba(99,102,241,0)");
      ctx.beginPath();
      ctx.arc(cx, cy, 28, 0, Math.PI * 2);
      ctx.fillStyle = coreGrad;
      ctx.fill();

      // Center dot
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.fill();

      frame++;
    }

    const id = setInterval(draw, 16);
    return () => clearInterval(id);
  }, []);

  return <canvas ref={canvasRef} width={220} height={220} style={{ imageRendering: "auto" }} />;
}

const STATS = [
  { value: "8", label: "AI Agents" },
  { value: "33+", label: "Live Markets" },
  { value: "100ms", label: "Scan Interval" },
];

export default function LandingPage({ onEnter }: { onEnter: () => void }) {
  const handleDeriv = () => {
    window.location.href = "https://oauth.deriv.com/oauth2/authorize?app_id=1089&l=EN&brand=deriv";
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4 overflow-hidden">
      {/* Ambient background */}
      <div className="absolute inset-0 pointer-events-none" style={{
        backgroundImage: "radial-gradient(ellipse 80% 50% at 50% 40%, rgba(99,102,241,0.06) 0%, transparent 100%)",
      }} />
      <div className="absolute inset-0 pointer-events-none opacity-30" style={{
        backgroundImage: "linear-gradient(rgba(99,102,241,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,0.04) 1px, transparent 1px)",
        backgroundSize: "48px 48px",
      }} />

      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
        className="relative z-10 w-full max-w-[400px]"
      >
        <div
          className="relative rounded-2xl overflow-hidden"
          style={{
            background: "linear-gradient(160deg, #1a1a22 0%, #101014 55%, #13131a 100%)",
            boxShadow: "0 40px 100px rgba(0,0,0,0.75), 0 0 0 1px rgba(255,255,255,0.07), 0 0 60px rgba(99,102,241,0.08), inset 0 1px 0 rgba(255,255,255,0.07)",
            transform: "perspective(900px) rotateX(2deg)",
          }}
        >
          {/* Top shimmer */}
          <div className="absolute top-0 left-0 right-0 h-px"
            style={{ background: "linear-gradient(90deg, transparent 10%, rgba(139,92,246,0.7) 50%, transparent 90%)" }} />

          <div className="p-6">
            {/* Logo row */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center"
                  style={{ background: "linear-gradient(135deg, rgba(99,102,241,0.3), rgba(99,102,241,0.1))", border: "1px solid rgba(99,102,241,0.35)" }}>
                  <Activity className="w-4 h-4 text-indigo-400" />
                </div>
                <span className="font-bold text-white text-sm tracking-tight">NeuroTrade AI</span>
              </div>
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-full" style={{ border: "1px solid rgba(34,197,94,0.25)", background: "rgba(34,197,94,0.06)" }}>
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse inline-block" />
                <span className="text-[10px] text-green-400 font-medium tracking-wide">LIVE</span>
              </div>
            </div>

            {/* Neural orb — hero visual */}
            <div className="flex justify-center -mx-2 my-1">
              <NeuralOrb />
            </div>

            {/* Headline */}
            <div className="text-center mb-5 -mt-2">
              <h1 className="text-xl font-bold text-white tracking-tight leading-snug">
                Autonomous Trading
              </h1>
              <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
                ML ensemble scanning Deriv Synthetic Indices in real time.<br />
                No crowd indicators. No guesswork.
              </p>
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-3 gap-2 mb-5">
              {STATS.map((s) => (
                <div key={s.label} className="text-center rounded-xl py-2.5"
                  style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                  <div className="text-base font-bold font-mono text-indigo-300">{s.value}</div>
                  <div className="text-[9px] text-zinc-500 mt-0.5 tracking-wide">{s.label}</div>
                </div>
              ))}
            </div>

            {/* Separator */}
            <div className="h-px mb-4" style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent)" }} />

            {/* CTAs */}
            <div className="space-y-2">
              <motion.button
                whileHover={{ scale: 1.015 }} whileTap={{ scale: 0.985 }}
                onClick={handleDeriv}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-sm text-white"
                style={{
                  background: "linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)",
                  boxShadow: "0 0 32px rgba(99,102,241,0.4), inset 0 1px 0 rgba(255,255,255,0.15)",
                }}
              >
                <Brain className="w-4 h-4" />
                Connect with Deriv
                <ChevronRight className="w-3.5 h-3.5" />
              </motion.button>
              <motion.button
                whileHover={{ scale: 1.015 }} whileTap={{ scale: 0.985 }}
                onClick={onEnter}
                className="w-full py-2.5 rounded-xl font-medium text-sm transition-colors"
                style={{ color: "#71717a", border: "1px solid rgba(255,255,255,0.07)", background: "rgba(255,255,255,0.02)" }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.14)"; e.currentTarget.style.color = "#a1a1aa"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.07)"; e.currentTarget.style.color = "#71717a"; }}
              >
                Explore Demo Mode
              </motion.button>
            </div>

            <p className="text-[10px] text-zinc-700 text-center mt-3">OAuth · No credentials stored · Paper trade mode available</p>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
