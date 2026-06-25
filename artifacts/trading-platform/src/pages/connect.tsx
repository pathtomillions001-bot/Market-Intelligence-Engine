import { useConnectDerivAccount, useGetAccount, useDisconnectAccount } from "@workspace/api-client-react";
import { ApiError } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { motion } from "framer-motion";
import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Link, useLocation } from "wouter";
import { CheckCircle, ExternalLink, ShieldCheck, Unlink, Wifi, LogIn, KeyRound } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

const DERIV_APP_ID = "1089";
const DERIV_OAUTH_URL = `https://oauth.deriv.com/oauth2/authorize?app_id=${DERIV_APP_ID}&l=EN&brand=deriv`;

function buildOAuthRedirectUrl(): string {
  const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
  return `${window.location.origin}${base}/connect`;
}

export default function Connect() {
  const { data: account } = useGetAccount({
    query: {
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status === 404) return false;
        return failureCount < 1;
      },
    },
  });
  const connect = useConnectDerivAccount();
  const disconnect = useDisconnectAccount();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [oauthPending, setOauthPending] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthToken = params.get("token1");
    const loginId = params.get("acct1");

    if (oauthToken && loginId) {
      setOauthPending(true);
      window.history.replaceState({}, "", window.location.pathname);
      connect.mutate({ data: { token: oauthToken } }, {
        onSuccess: () => {
          toast.success("Logged in with Deriv — live trading enabled!");
          setOauthPending(false);
          queryClient.invalidateQueries();
        },
        onError: (err: unknown) => {
          const msg = err instanceof ApiError
            ? (typeof err.data === "object" && err.data && "error" in (err.data as object)
              ? String((err.data as { error: string }).error)
              : err.message)
            : "OAuth login failed — please try again";
          toast.error(msg);
          setOauthPending(false);
        },
      });
    }
  }, []);

  const handleDerivLogin = () => {
    const redirectUri = buildOAuthRedirectUrl();
    const url = `${DERIV_OAUTH_URL}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    window.location.href = url;
  };

  const handleConnect = (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    connect.mutate({ data: { token } }, {
      onSuccess: () => {
        toast.success("Account connected — live trading on Deriv");
        setToken("");
        queryClient.invalidateQueries();
      },
      onError: (err: unknown) => {
        const msg = err instanceof ApiError
          ? (typeof err.data === "object" && err.data && "error" in (err.data as object)
            ? String((err.data as { error: string }).error)
            : err.message)
          : "Failed to connect account";
        toast.error(msg);
      },
    });
  };

  const handleDisconnect = () => {
    disconnect.mutate(undefined, {
      onSuccess: () => {
        toast.success("Account unlinked — switched to demo mode");
        queryClient.invalidateQueries();
      },
      onError: (err: any) => {
        toast.error(err?.error || "Failed to disconnect account");
      },
    });
  };

  if (oauthPending) {
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 md:p-8 max-w-2xl mx-auto flex flex-col items-center justify-center min-h-[50vh] gap-4">
        <div className="relative w-16 h-16">
          <div className="absolute inset-0 rounded-full border-2 border-primary/30 animate-ping" />
          <div className="absolute inset-2 rounded-full border-2 border-primary animate-spin border-t-transparent" />
        </div>
        <p className="text-muted-foreground text-sm font-mono">Authenticating with Deriv…</p>
      </motion.div>
    );
  }

  if (account) {
    return (
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-4 md:p-8 max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Account Connected</h1>
          <p className="text-muted-foreground mt-1 text-sm">Your Deriv account is linked and trading is live.</p>
        </div>

        <Card className="bg-card border-green-500/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-green-500">
              <CheckCircle className="w-5 h-5" /> Connected to Deriv
            </CardTitle>
            <CardDescription>Trades are executing in real-time on your Deriv account.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3 bg-secondary/30 p-4 rounded-lg">
              <div>
                <Label className="text-muted-foreground text-xs uppercase">Login ID</Label>
                <div className="font-mono text-base md:text-lg mt-1">{account.loginId}</div>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs uppercase">Balance</Label>
                <div className="font-mono text-base md:text-lg mt-1 text-green-400">{account.currency} {account.balance.toFixed(2)}</div>
              </div>
              {account.email && (
                <div>
                  <Label className="text-muted-foreground text-xs uppercase">Email</Label>
                  <div className="text-sm mt-1 text-muted-foreground">{account.email}</div>
                </div>
              )}
              <div>
                <Label className="text-muted-foreground text-xs uppercase">Account Type</Label>
                <div className="text-sm mt-1">{account.isVirtual ? "Demo Account" : "Real Account"}</div>
              </div>
            </div>

            <div className="p-3 bg-green-500/5 border border-green-500/20 rounded-lg flex items-center gap-3">
              <Wifi className="w-4 h-4 text-green-500 flex-shrink-0" />
              <div className="text-sm text-green-400">Live trading active — all trades reflect on your Deriv account in real-time.</div>
            </div>

            <div className="flex flex-col sm:flex-row gap-3 pt-2">
              <Link href="/" className="flex-1">
                <Button className="w-full">Go to Dashboard</Button>
              </Link>
              <Button
                variant="outline"
                className="flex-1 border-red-500/30 text-red-400 hover:bg-red-500/10 hover:border-red-500/50"
                onClick={handleDisconnect}
                disabled={disconnect.isPending}
              >
                <Unlink className="w-4 h-4 mr-2" />
                {disconnect.isPending ? "Unlinking..." : "Unlink Account"}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card">
          <CardHeader>
            <CardTitle className="text-sm">What happens when you unlink?</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-2">
            <p>• NeuroTrade switches to Demo Mode (simulated $10,000 balance)</p>
            <p>• Your trade history and settings are preserved</p>
            <p>• The AI engine continues scanning markets in simulation mode</p>
            <p>• You can re-link your Deriv account at any time</p>
          </CardContent>
        </Card>
      </motion.div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-4 md:p-8 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Connect Deriv Account</h1>
        <p className="text-muted-foreground mt-1 text-sm">Sign in with your Deriv account to enable live trading.</p>
      </div>

      {/* Primary: OAuth Login */}
      <Card className="bg-card border-primary/30 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent pointer-events-none" />
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LogIn className="w-5 h-5 text-primary" />
            Sign in with Deriv
          </CardTitle>
          <CardDescription>
            Use your existing Deriv account — including Google, Facebook, or email login. No API key needed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button
            className="w-full h-12 text-base font-semibold bg-primary text-black hover:bg-primary/90 shadow-[0_0_20px_rgba(0,255,255,0.25)] transition-all hover:shadow-[0_0_30px_rgba(0,255,255,0.4)]"
            onClick={handleDerivLogin}
          >
            <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z" />
            </svg>
            Continue with Deriv
          </Button>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="w-3.5 h-3.5 text-primary flex-shrink-0" />
            <span>You'll be redirected to Deriv's secure login page. No passwords stored here.</span>
          </div>

          <div className="grid grid-cols-3 gap-2 pt-1">
            {["Google", "Facebook", "Email"].map((method) => (
              <div key={method} className="text-center p-2 rounded-lg bg-secondary/50 border border-border text-xs text-muted-foreground">
                {method}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Divider */}
      <div className="flex items-center gap-3">
        <div className="flex-1 h-px bg-border" />
        <span className="text-xs text-muted-foreground">or use API token manually</span>
        <div className="flex-1 h-px bg-border" />
      </div>

      {/* Secondary: Manual token */}
      {showManual ? (
        <Card className="bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <KeyRound className="w-4 h-4 text-muted-foreground" /> API Token
            </CardTitle>
            <CardDescription>
              Paste a Deriv API token with <strong>Read</strong> and <strong>Trade</strong> permissions.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleConnect} className="space-y-4">
              <div className="space-y-2">
                <div className="relative">
                  <Input
                    id="token"
                    type={showToken ? "text" : "password"}
                    placeholder="Paste your token here…"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    className="font-mono bg-secondary/50 border-border pr-16"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken(!showToken)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
                  >
                    {showToken ? "Hide" : "Show"}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Get your token at{" "}
                  <a href="https://app.deriv.com/account/api-token" target="_blank" rel="noopener noreferrer" className="text-primary underline">
                    app.deriv.com/account/api-token
                  </a>
                </p>
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setShowManual(false)}>
                  Cancel
                </Button>
                <Button type="submit" className="flex-1" disabled={connect.isPending || !token}>
                  {connect.isPending ? "Connecting…" : "Connect with Token"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : (
        <button
          onClick={() => setShowManual(true)}
          className="w-full text-xs text-muted-foreground hover:text-foreground py-2 transition-colors"
        >
          Use an API token instead →
        </button>
      )}

      <div className="p-4 rounded-lg bg-amber-500/5 border border-amber-500/20">
        <p className="text-sm text-amber-400">
          <strong>Demo Mode active</strong> — trading on a simulated $10,000 balance.
          Connect your Deriv account to trade with real funds.
        </p>
      </div>
    </motion.div>
  );
}
