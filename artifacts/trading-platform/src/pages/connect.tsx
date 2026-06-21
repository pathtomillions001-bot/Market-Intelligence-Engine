import { useConnectDerivAccount, useGetAccount } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { motion } from "framer-motion";
import { useState } from "react";
import { toast } from "sonner";
import { Link } from "wouter";

export default function Connect() {
  const { data: account } = useGetAccount();
  const connect = useConnectDerivAccount();
  const [token, setToken] = useState("");

  const handleConnect = (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    connect.mutate({ data: { token } }, {
      onSuccess: () => {
        toast.success("Account connected successfully");
        setToken("");
      },
      onError: (err) => {
        toast.error(err.error || "Failed to connect account");
      }
    });
  };

  if (account) {
    return (
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-8 max-w-2xl mx-auto space-y-6">
        <Card className="bg-card border-primary/20">
          <CardHeader>
            <CardTitle className="text-2xl text-primary flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-primary" /> Connected
            </CardTitle>
            <CardDescription>Your Deriv account is active and ready for trading.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4 bg-secondary/30 p-4 rounded-lg">
              <div>
                <Label className="text-muted-foreground text-xs uppercase">Login ID</Label>
                <div className="font-mono text-lg mt-1">{account.loginId}</div>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs uppercase">Balance</Label>
                <div className="font-mono text-lg mt-1">{account.currency} {account.balance.toFixed(2)}</div>
              </div>
            </div>
            <div className="flex gap-4 pt-4">
              <Link href="/">
                <Button className="w-full">Go to Dashboard</Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-8 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Connect Exchange</h1>
        <p className="text-muted-foreground mt-1">Provide your Deriv API token to enable trading capabilities.</p>
      </div>

      <Card className="bg-card">
        <CardHeader>
          <CardTitle>API Configuration</CardTitle>
          <CardDescription>
            NeuroTrade uses your API token to analyze markets and execute trades. 
            We require a token with "Read" and "Trade" permissions.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleConnect} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="token">Deriv API Token</Label>
              <Input 
                id="token" 
                type="password" 
                placeholder="Enter your token (e.g. abc123def456)" 
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className="font-mono bg-secondary/50 border-border"
              />
            </div>
            <Button type="submit" className="w-full" disabled={connect.isPending || !token}>
              {connect.isPending ? "Connecting..." : "Connect Account"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </motion.div>
  );
}
