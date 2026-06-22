import { ReactNode, useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useGetAiEngineStatus, useToggleAutonomousEngine } from "@workspace/api-client-react";
import { Activity, BarChart2, Briefcase, LayoutDashboard, Settings as SettingsIcon, Link as LinkIcon, Menu, X } from "lucide-react";
import { Switch } from "./ui/switch";
import { Label } from "./ui/label";
import { motion, AnimatePresence } from "framer-motion";

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/markets", label: "Markets", icon: BarChart2 },
  { href: "/trades", label: "Journal", icon: Briefcase },
  { href: "/analytics", label: "Analytics", icon: Activity },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
  { href: "/connect", label: "Connect", icon: LinkIcon },
];

function NavContent({ location, onNavigate }: { location: string; onNavigate?: () => void }) {
  const { data: engineStatus } = useGetAiEngineStatus({ query: { refetchInterval: 2000 } } as { query: any });
  const toggleEngine = useToggleAutonomousEngine();

  return (
    <div className="flex flex-col h-full">
      <div className="p-5 border-b border-border flex items-center gap-3">
        <div className="w-8 h-8 rounded bg-primary/20 flex items-center justify-center border border-primary/50 flex-shrink-0">
          <Activity className="w-5 h-5 text-primary" />
        </div>
        <span className="font-bold text-lg tracking-tight">NeuroTrade</span>
      </div>

      <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
          return (
            <Link key={item.href} href={item.href}>
              <div
                onClick={onNavigate}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-md cursor-pointer transition-colors ${isActive ? "bg-primary/10 text-primary border border-primary/20" : "text-muted-foreground hover:text-foreground hover:bg-secondary"}`}
              >
                <item.icon className="w-4 h-4 flex-shrink-0" />
                <span className="font-medium text-sm">{item.label}</span>
              </div>
            </Link>
          );
        })}
      </nav>

      {engineStatus && (
        <div className="p-3 border-t border-border">
          <div className={`p-3 rounded-lg border ${engineStatus.mode === "autonomous" ? "bg-primary/5 border-primary/30" : "bg-secondary border-border"}`}>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Engine Mode</Label>
              <div className={`w-2 h-2 rounded-full ${engineStatus.isRunning ? "bg-green-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]" : "bg-red-500"}`} />
            </div>
            <div className="flex items-center justify-between">
              <span className="font-mono text-sm font-medium">{engineStatus.mode === "autonomous" ? "AUTONOMOUS" : "MANUAL"}</span>
              <Switch
                checked={engineStatus.mode === "autonomous"}
                onCheckedChange={(checked) => toggleEngine.mutate({ data: { running: checked } })}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close mobile menu on location change
  useEffect(() => {
    setMobileOpen(false);
  }, [location]);

  // Prevent body scroll when mobile menu is open
  useEffect(() => {
    if (mobileOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [mobileOpen]);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-56 lg:w-64 border-r border-border bg-card flex-col flex-shrink-0">
        <NavContent location={location} />
      </aside>

      {/* Mobile overlay */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 bg-black/60 z-40 md:hidden"
              onClick={() => setMobileOpen(false)}
            />
            <motion.aside
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "tween", duration: 0.25 }}
              className="fixed left-0 top-0 h-full w-72 bg-card border-r border-border z-50 md:hidden flex flex-col"
            >
              <NavContent location={location} onNavigate={() => setMobileOpen(false)} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Mobile top bar */}
        <header className="md:hidden flex items-center gap-3 px-4 py-3 border-b border-border bg-card flex-shrink-0">
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            aria-label="Toggle menu"
          >
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-primary/20 flex items-center justify-center border border-primary/50">
              <Activity className="w-4 h-4 text-primary" />
            </div>
            <span className="font-bold text-base tracking-tight">NeuroTrade</span>
          </div>
          <div className="ml-auto">
            {navItems.find((n) => n.href === location || (n.href !== "/" && location.startsWith(n.href))) && (
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                {navItems.find((n) => n.href === location || (n.href !== "/" && location.startsWith(n.href)))?.label}
              </span>
            )}
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
