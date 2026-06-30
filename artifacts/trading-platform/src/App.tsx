import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEffect, useState } from "react";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/layout";
import LandingPage from "./pages/landing";

import Dashboard from "./pages/dashboard";
import Markets from "./pages/markets";
import MarketDetail from "./pages/market-detail";
import Trades from "./pages/trades";
import Analytics from "./pages/analytics";
import Connect from "./pages/connect";
import Settings from "./pages/settings";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30000 } },
});

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function getApiUrl(path: string) {
  return `${BASE}/api${path}`;
}

function useLandingGate() {
  const [dismissed, setDismissed] = useState(false);
  const { data: account } = useQuery({
    queryKey: ["account-gate"],
    queryFn: async () => {
      const r = await fetch(getApiUrl("/auth/account"));
      if (!r.ok) return null;
      const data = await r.json();
      return data?.loginId ? data : null;
    },
    staleTime: 10000,
  });

  const hasAccount = !!account;

  const dismiss = () => {
    setDismissed(true);
  };

  return { showLanding: !dismissed && !hasAccount, dismiss };
}

function Router() {
  const { showLanding, dismiss } = useLandingGate();
  const [, setLocation] = useLocation();

  if (showLanding) {
    return <LandingPage onEnter={() => { dismiss(); setLocation("/connect"); }} />;
  }

  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/markets" component={Markets} />
        <Route path="/markets/:symbol" component={MarketDetail} />
        <Route path="/trades" component={Trades} />
        <Route path="/analytics" component={Analytics} />
        <Route path="/settings" component={Settings} />
        <Route path="/connect" component={Connect} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={BASE}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
