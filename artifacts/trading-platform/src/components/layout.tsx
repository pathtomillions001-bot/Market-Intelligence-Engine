import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useGetAiEngineStatus, useToggleAutonomousEngine } from "@workspace/api-client-react";
import { Activity, BarChart2, Briefcase, LayoutDashboard, Settings as SettingsIcon, Link as LinkIcon } from "lucide-react";
import { Switch } from "./ui/switch";
import { Label } from "./ui/label";

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { data: engineStatus } = useGetAiEngineStatus({
    query: { refetchInterval: 5000 }
  });
  const toggleEngine = useToggleAutonomousEngine();

  const navItems = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/markets", label: "Markets", icon: BarChart2 },
    { href: "/trades", label: "Journal", icon: Briefcase },
    { href: "/analytics", label: "Analytics", icon: Activity },
    { href: "/settings", label: "Settings", icon: SettingsIcon },
    { href: "/connect", label: "Connect", icon: LinkIcon },
  ];

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <aside className="w-64 border-r border-border bg-card flex flex-col">
        <div className="p-6 border-b border-border flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-primary/20 flex items-center justify-center border border-primary/50">
            <Activity className="w-5 h-5 text-primary" />
          </div>
          <span className="font-bold text-lg tracking-tight">NeuroTrade</span>
        </div>
        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            return (
              <Link key={item.href} href={item.href}>
                <div className={`flex items-center gap-3 px-3 py-2.5 rounded-md cursor-pointer transition-colors ${isActive ? "bg-primary/10 text-primary border border-primary/20" : "text-muted-foreground hover:text-foreground hover:bg-secondary"}`}>
                  <item.icon className="w-4 h-4" />
                  <span className="font-medium text-sm">{item.label}</span>
                </div>
              </Link>
            );
          })}
        </nav>
        {engineStatus && (
          <div className="p-4 border-t border-border">
            <div className={`p-4 rounded-lg border ${engineStatus.mode === "autonomous" ? "bg-primary/5 border-primary/30" : "bg-secondary border-border"}`}>
              <div className="flex items-center justify-between mb-2">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Engine Mode</Label>
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
      </aside>
      <main className="flex-1 overflow-y-auto relative">
        {children}
      </main>
    </div>
  );
}
