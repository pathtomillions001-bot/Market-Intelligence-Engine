import { useConnectDerivAccount, useGetAccount, useDisconnectAccount } from "@workspace/api-client-react";
import { ApiError } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { motion } from "framer-motion";
import { useState } from "react";
import { toast } from "sonner";
import { Link } from "wouter";
import { CheckCircle, ExternalLink, ShieldCheck, Unlink, Wifi } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

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
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);

  const handleConnect = (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    connect.mutate({ data: { token } }, {
      onSuccess: () => {
        toast.success("Account connected successfully — trading live on Deriv");
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
      }
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
      }
    });
  };

  if (account) {
    return (
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-4 md:p-8 max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">API Connection</h1>
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
              <div className="text-sm text-green-400">Live trading active — all trades will reflect on your Deriv account in real-time.</div>
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
                {disconnect.isPending ? "Unlinking..." : "Unlink API"}
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
            <p>• You can re-link your Deriv API at any time</p>
          </CardContent>
        </Card>
      </motion.div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-4 md:p-8 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Connect Exchange</h1>
        <p className="text-muted-foreground mt-1 text-sm">Link your Deriv API token to enable live trading.</p>
      </div>

      <Card className="bg-card">
        <CardHeader>
          <CardTitle>API Configuration</CardTitle>
          <CardDescription>
            NeuroTrade uses your API token to execute real trades on Deriv.
            Your token requires <strong>Read</strong> and <strong>Trade</strong> permissions.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleConnect} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="token">Deriv API Token</Label>
              <div className="relative">
                <Input
                  id="token"
                  type={showToken ? "text" : "password"}
                  placeholder="Paste your token here (e.g. abc123def456...)"
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
            </div>
            <Button type="submit" className="w-full" disabled={connect.isPending || !token}>
              {connect.isPending ? "Connecting to Deriv..." : "Connect & Enable Live Trading"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card className="bg-card/50">
          <CardContent className="pt-5 space-y-2">
            <ShieldCheck className="w-6 h-6 text-primary" />
            <div className="font-medium text-sm">Secure Connection</div>
            <div className="text-xs text-muted-foreground">Your token is stored securely and never shared. Only the Deriv API is contacted.</div>
          </CardContent>
        </Card>
        <Card className="bg-card/50">
          <CardContent className="pt-5 space-y-2">
            <ExternalLink className="w-6 h-6 text-primary" />
            <div className="font-medium text-sm">Get Your Token</div>
            <div className="text-xs text-muted-foreground">
              Visit{" "}
              <a href="https://app.deriv.com/account/api-token" target="_blank" rel="noopener noreferrer" className="text-primary underline">
                app.deriv.com/account/api-token
              </a>{" "}
              — enable Read + Trade permissions.
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="p-4 rounded-lg bg-amber-500/5 border border-amber-500/20">
        <p className="text-sm text-amber-400">
          <strong>Demo Mode active</strong> — trading on a simulated $10,000 balance.
          Connect your Deriv API to trade with real funds.
        </p>
      </div>
    </motion.div>
  );
}
