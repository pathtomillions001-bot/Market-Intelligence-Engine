import { Router } from "express";
import { db } from "@workspace/db";
import { tradesTable, accountsTable, settingsTable } from "@workspace/db";
import { eq, desc, and, sql } from "drizzle-orm";
import { ExecuteTradeBody, GetTradesQueryParams, GetTradeParams } from "@workspace/api-zod";
import { tickManager, DERIV_MARKETS, getCachedToken, executeLiveTrade, waitForContractResult, getLiveBalance } from "../lib/deriv";
import { runCoordinator, buildLegacyAnalysis, recordTradeOutcome, updateDigitRecovery } from "../lib/agent-coordinator";
import { logger } from "../lib/logger";
import type { TradingSettings, DailyStats, ScanContext } from "../lib/agents/types";

const router = Router();

const DEMO_BALANCE = 10000;

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildTradingSettingsForManual(s: any, preferredContractTypes: string[]): TradingSettings {
  return {
    maxRiskPerTrade:        s ? Number(s.maxRiskPerTrade) : 2,
    minConfidenceThreshold: s ? Math.min(Number(s.minConfidenceThreshold), 55) : 38,
    riskProfile:            (s?.riskProfile ?? "moderate") as "conservative" | "moderate" | "aggressive",
    preferredContractTypes,
    tradeDurationSec:       s?.tradeDurationSec ?? 5,
    maxTradeStake:          s ? Number(s.maxTradeStake) : 500,
    dailyLossLimit:         s ? Number(s.dailyLossLimit) : 30,
    dailyTarget:            s ? Number(s.dailyTarget) : 50,
    consecutiveLossLimit:   s?.consecutiveLossLimit ?? 3,
    maxDrawdown:            s ? Number(s.maxDrawdown ?? 20) : 20,
    requirePositiveEv:      s?.requirePositiveEv ?? true,
    paperTradeMode:         s?.paperTradeMode ?? false,
  };
}

function buildDailyStatsForManual(closedToday: any[]): DailyStats {
  const wins = closedToday.filter((t) => t.status === "won").length;
  const losses = closedToday.filter((t) => t.status === "lost").length;
  const profit = closedToday.reduce((s: number, t: any) => s + Number(t.profit ?? 0), 0);
  const sorted = [...closedToday].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  let consecutiveLosses = 0;
  for (const t of sorted) { if (t.status === "lost") consecutiveLosses++; else break; }
  let consecutiveWins = 0;
  for (const t of sorted) { if (t.status === "won") consecutiveWins++; else break; }
  return { tradesCount: closedToday.length, wins, losses, profit, consecutiveLosses, consecutiveWins };
}

// ── Stats ──────────────────────────────────────────────────────────────────────

router.get("/stats", async (_req, res): Promise<void> => {
  const trades = await db.select().from(tradesTable).where(
    sql`${tradesTable.status} IN ('won', 'lost')`
  );

  const won = trades.filter((t) => t.status === "won");
  const lost = trades.filter((t) => t.status === "lost");
  const profits = trades.map((t) => Number(t.profit ?? 0));
  const winProfits = won.map((t) => Number(t.profit ?? 0));
  const lossProfits = lost.map((t) => Number(t.profit ?? 0));

  const sorted = [...trades].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  let longestWin = 0, longestLose = 0;
  let curWin = 0, curLose = 0;
  for (const t of sorted) {
    if (t.status === "won") { curWin++; curLose = 0; }
    else { curLose++; curWin = 0; }
    longestWin = Math.max(longestWin, curWin);
    longestLose = Math.max(longestLose, curLose);
  }
  let currentStreak = 0;
  if (sorted.length > 0) {
    const last = sorted[0];
    let streak = 0;
    for (const t of sorted) {
      if (t.status === last.status) streak++;
      else break;
    }
    currentStreak = last.status === "won" ? streak : -streak;
  }

  res.json({
    totalTrades: trades.length,
    wonTrades: won.length,
    lostTrades: lost.length,
    winRate: trades.length > 0 ? won.length / trades.length : 0,
    totalProfit: profits.reduce((a, b) => a + b, 0),
    avgProfit: profits.length > 0 ? profits.reduce((a, b) => a + b, 0) / profits.length : 0,
    bestTrade: winProfits.length > 0 ? Math.max(...winProfits) : 0,
    worstTrade: lossProfits.length > 0 ? Math.min(...lossProfits) : 0,
    currentStreak,
    longestWinStreak: longestWin,
    longestLoseStreak: longestLose,
  });
});

router.get("/daily-summary", async (_req, res): Promise<void> => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const todayTrades = await db.select().from(tradesTable).where(
    sql`${tradesTable.createdAt} >= ${today}`
  );

  const settings = await db.select().from(settingsTable).limit(1);
  const accounts = await db.select().from(accountsTable).limit(1);

  const dailyTarget = settings.length > 0 ? Number(settings[0].dailyTarget) : 50;
  const dailyLossLimit = settings.length > 0 ? Number(settings[0].dailyLossLimit) : 30;
  const balance = accounts.length > 0 ? Number(accounts[0].balance) : DEMO_BALANCE;

  const closed = todayTrades.filter((t) => t.status === "won" || t.status === "lost");
  const totalProfit = closed.reduce((s, t) => s + Number(t.profit ?? 0), 0);
  const won = closed.filter((t) => t.status === "won").length;

  res.json({
    date: today.toISOString().split("T")[0],
    tradesCount: closed.length,
    wonCount: won,
    lostCount: closed.length - won,
    totalProfit,
    dailyTarget,
    dailyLossLimit,
    targetProgress: dailyTarget > 0 ? Math.min(totalProfit / dailyTarget, 1) : 0,
    isTargetMet: totalProfit >= dailyTarget,
    isLossLimitHit: totalProfit <= -dailyLossLimit,
    balanceStart: balance - totalProfit,
    balanceNow: balance,
  });
});

router.get("/", async (req, res): Promise<void> => {
  const parseResult = GetTradesQueryParams.safeParse(req.query);
  const params = parseResult.success ? parseResult.data : {};

  let query = db.select().from(tradesTable).$dynamic();
  const conditions = [];

  const p = params as { status?: string; market?: string; limit?: number; offset?: number };
  if (p.status && p.status !== "all") {
    conditions.push(eq(tradesTable.status, p.status));
  }
  if (p.market) {
    conditions.push(eq(tradesTable.symbol, p.market));
  }

  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  const trades = await query
    .orderBy(desc(tradesTable.createdAt))
    .limit(p.limit ?? 50)
    .offset(p.offset ?? 0);

  res.json(trades.map(formatTrade));
});

// ── Manual trade execution ─────────────────────────────────────────────────────

router.post("/", async (req, res): Promise<void> => {
  const parseResult = ExecuteTradeBody.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: "Invalid trade parameters" });
    return;
  }

  const { symbol, contractType, stake, direction, isAutonomous, duration, durationUnit } = parseResult.data;
  // barrier is in Zod schema — use it directly
  const requestBarrier = parseResult.data.barrier ?? undefined;

  const accounts = await db.select().from(accountsTable).limit(1);
  const settings = await db.select().from(settingsTable).limit(1);
  const balance = accounts.length > 0 ? Number(accounts[0].balance) : DEMO_BALANCE;
  const maxRisk = settings.length > 0 ? Number(settings[0].maxRiskPerTrade) : 2;
  const paperTradeMode = settings.length > 0 ? (settings[0] as any).paperTradeMode ?? false : false;

  if (stake > balance * (maxRisk / 100) * 5) {
    res.status(400).json({ error: `Stake ${stake.toFixed(2)} exceeds risk limit. Max: ${(balance * maxRisk / 100 * 5).toFixed(2)}` });
    return;
  }
  if (stake <= 0) {
    res.status(400).json({ error: "Stake must be greater than 0" });
    return;
  }

  const market = DERIV_MARKETS.find((m) => m.symbol === symbol);
  const displayName = market?.displayName ?? symbol;

  const token = getCachedToken() ?? (accounts.length > 0 ? accounts[0].token ?? null : null);
  const currency = accounts.length > 0 ? accounts[0].currency : "USD";
  const isLiveTrade = !paperTradeMode && !!token;

  // ── Run coordinator for rich AI context ──────────────────────────────────
  const preferredContractTypes = [contractType];
  const tradingSettings = buildTradingSettingsForManual(settings.length > 0 ? settings[0] : null, preferredContractTypes);

  // Build daily stats
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayTrades = await db.select().from(tradesTable).where(sql`${tradesTable.createdAt} >= ${today}`);
  const closedToday = todayTrades.filter((t) => t.status === "won" || t.status === "lost");
  const daily = buildDailyStatsForManual(closedToday);

  const prices = tickManager.getTicks(symbol, 100);
  const digits = market?.digitEnabled ? tickManager.getDigits(symbol, 300) : [];

  const ctx: ScanContext = {
    symbol,
    displayName,
    category: market?.category ?? "synthetic",
    prices,
    digits,
    balance,
    settings: tradingSettings,
    daily,
    token,
    currency,
  };

  let analysis;
  try {
    const coordinatorOutput = await runCoordinator(ctx);
    analysis = buildLegacyAnalysis(coordinatorOutput);
  } catch (err) {
    logger.warn({ err, symbol }, "Coordinator failed for manual trade — using defaults");
    analysis = {
      calibratedConfidence: 55,
      winProbability: 55,
      expectedValue: 0,
      payoutMultiplier: 1.91,
      breakevenWinRate: 52.4,
      riskScore: 50,
      reasoning: "Manual trade (coordinator unavailable)",
      digitBarrier: requestBarrier,
      recommendedDuration: duration ?? 5,
    };
  }

  const tradeDuration = duration ?? (analysis as any).recommendedDuration ?? 5;
  const isDigit = contractType.includes("DIGIT");

  // For digit contracts, always ensure a valid barrier
  const defaultBarrier = contractType === "DIGITOVER" ? 5 : contractType === "DIGITUNDER" ? 4 : undefined;
  const barrier = isDigit
    ? (requestBarrier ?? (analysis as any).digitBarrier ?? defaultBarrier)
    : undefined;

  const winProbability: number = (analysis as any).winProbability ?? 55;
  const payoutMultiplier: number = (analysis as any).payoutMultiplier ?? 1.91;
  const payout = stake * payoutMultiplier;

  logger.info({
    symbol, contractType, stake, barrier, duration: tradeDuration,
    isLiveTrade, paperTradeMode, token: token ? "present" : "absent",
  }, "Manual trade request");

  let won: boolean, profit: number, entryPrice: number, exitPrice: number;

  if (isLiveTrade) {
    // Insert as "open" immediately so the journal shows it in-progress
    const [openTrade] = await db.insert(tradesTable).values({
      symbol,
      displayName,
      contractType,
      barrier: barrier ?? null,
      stake: String(stake),
      direction,
      status: "open",
      aiConfidence: String(winProbability),
      aiRiskScore: String((analysis as any).riskScore ?? 50),
      isAutonomous: isAutonomous ?? false,
      agentReasoning: `[LIVE] ${(analysis as any).reasoning ?? "Manual trade"}`,
      duration: tradeDuration,
      durationUnit: durationUnit ?? "t",
    }).returning();

    try {
      logger.info({ symbol, contractType, stake, barrier }, "Executing live manual trade on Deriv");
      const liveResult = await executeLiveTrade(token!, {
        symbol,
        contractType,
        stake,
        duration: tradeDuration,
        durationUnit: durationUnit ?? "t",
        currency,
        barrier,
      });

      const contractResult = await waitForContractResult(token!, liveResult.contractId, (tradeDuration + 15) * 1000);
      won = contractResult.won;
      profit = contractResult.profit;
      exitPrice = contractResult.exitSpot;
      entryPrice = contractResult.entrySpot || liveResult.buyPrice;
    } catch (liveErr) {
      const errMsg = liveErr instanceof Error ? liveErr.message : String(liveErr);
      logger.warn({ liveErrMsg: errMsg, symbol, contractType, barrier }, "Live manual trade failed");
      await db.update(tradesTable)
        .set({ status: "lost", profit: String(-stake), payout: "0", closedAt: new Date(),
               agentReasoning: `[LIVE — FAILED: ${errMsg}] ${(analysis as any).reasoning ?? ""}` })
        .where(eq(tradesTable.id, openTrade.id));
      res.status(500).json({ error: `Trade execution failed: ${errMsg}` });
      return;
    }

    recordTradeOutcome(symbol, contractType, barrier ?? null, won, profit, stake);
    updateDigitRecovery(symbol, contractType, won, profit, stake);

    const [closedTrade] = await db.update(tradesTable).set({
      status: won ? "won" : "lost",
      payout: String(stake + Math.max(profit, 0)),
      profit: String(profit),
      entryPrice: String(entryPrice),
      exitPrice: String(exitPrice),
      closedAt: new Date(),
    }).where(eq(tradesTable.id, openTrade.id)).returning();

    // Sync live balance
    try {
      const newBalance = await getLiveBalance(token!);
      if (newBalance !== null && accounts.length > 0) {
        await db.update(accountsTable).set({ balance: String(newBalance), updatedAt: new Date() });
      }
    } catch { /* ignore */ }

    res.status(201).json(formatTrade(closedTrade));
    return;
  }

  // ── Paper / demo trade simulation ─────────────────────────────────────────
  const winProb = winProbability / 100;
  won = Math.random() < winProb;
  profit = won ? payout - stake : -stake;

  entryPrice = prices[prices.length - 1] ?? 100;
  exitPrice = won
    ? direction === "up" ? entryPrice * 1.001 : entryPrice * 0.999
    : direction === "up" ? entryPrice * 0.999 : entryPrice * 1.001;

  recordTradeOutcome(symbol, contractType, barrier ?? null, won, profit, stake);
  updateDigitRecovery(symbol, contractType, won, profit, stake);

  const [trade] = await db.insert(tradesTable).values({
    symbol,
    displayName,
    contractType,
    barrier: barrier ?? null,
    stake: String(stake),
    direction,
    status: won ? "won" : "lost",
    payout: String(payout),
    profit: String(profit),
    entryPrice: String(entryPrice),
    exitPrice: String(exitPrice),
    aiConfidence: String(winProbability),
    aiRiskScore: String((analysis as any).riskScore ?? 50),
    isAutonomous: isAutonomous ?? false,
    agentReasoning: `[${token ? "PAPER" : "DEMO"}] ${(analysis as any).reasoning ?? "Manual trade"}`,
    duration: tradeDuration,
    durationUnit: durationUnit ?? "t",
    closedAt: new Date(),
  }).returning();

  // Update simulated balance for paper/demo trades
  try {
    if (accounts.length > 0) {
      const newBalance = Math.max(0, balance + profit);
      await db.update(accountsTable).set({ balance: String(newBalance.toFixed(2)), updatedAt: new Date() });
    }
  } catch { /* ignore */ }

  res.status(201).json(formatTrade(trade));
});

router.get("/:id", async (req, res): Promise<void> => {
  const parseResult = GetTradeParams.safeParse(req.params);
  if (!parseResult.success) {
    res.status(400).json({ error: "Invalid trade ID" });
    return;
  }
  const trades = await db.select().from(tradesTable).where(eq(tradesTable.id, parseResult.data.id));
  if (trades.length === 0) {
    res.status(404).json({ error: "Trade not found" });
    return;
  }
  res.json(formatTrade(trades[0]));
});

function formatTrade(trade: typeof tradesTable.$inferSelect) {
  return {
    id: trade.id,
    symbol: trade.symbol,
    displayName: trade.displayName,
    contractType: trade.contractType,
    barrier: trade.barrier ?? null,
    stake: Number(trade.stake),
    direction: trade.direction,
    status: trade.status,
    payout: trade.payout ? Number(trade.payout) : null,
    profit: trade.profit ? Number(trade.profit) : null,
    entryPrice: trade.entryPrice ? Number(trade.entryPrice) : null,
    exitPrice: trade.exitPrice ? Number(trade.exitPrice) : null,
    aiConfidence: trade.aiConfidence ? Number(trade.aiConfidence) : null,
    aiRiskScore: trade.aiRiskScore ? Number(trade.aiRiskScore) : null,
    isAutonomous: trade.isAutonomous,
    agentReasoning: trade.agentReasoning,
    createdAt: trade.createdAt.toISOString(),
    closedAt: trade.closedAt ? trade.closedAt.toISOString() : null,
    duration: trade.duration,
  };
}

export default router;
