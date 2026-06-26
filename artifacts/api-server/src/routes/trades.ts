import { Router } from "express";
import { db } from "@workspace/db";
import { tradesTable, accountsTable, settingsTable } from "@workspace/db";
import { eq, desc, and, sql } from "drizzle-orm";
import { ExecuteTradeBody, GetTradesQueryParams, GetTradeParams } from "@workspace/api-zod";
import { analyzeMarket, updateSelfLearning } from "../lib/ai-engine";
import { getTickHistory, DERIV_MARKETS, getCachedToken, executeLiveTrade, waitForContractResult, getLiveBalance } from "../lib/deriv";
import { finalizeAnalysis, logTradeFeatures, shouldExecuteTrade } from "../lib/trade-helpers";
import { logger } from "../lib/logger";

const router = Router();

const DEMO_BALANCE = 10000;

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

router.post("/", async (req, res): Promise<void> => {
  const parseResult = ExecuteTradeBody.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: "Invalid trade parameters" });
    return;
  }

  const { symbol, contractType, stake, direction, isAutonomous, duration, durationUnit } = parseResult.data;
  // barrier may be sent from the frontend but not in the Zod schema — read directly from body
  const requestBarrier = typeof (req.body as any).barrier === "number" ? (req.body as any).barrier as number : undefined;

  const accounts = await db.select().from(accountsTable).limit(1);
  const settings = await db.select().from(settingsTable).limit(1);
  const balance = accounts.length > 0 ? Number(accounts[0].balance) : DEMO_BALANCE;
  const maxRisk = settings.length > 0 ? Number(settings[0].maxRiskPerTrade) : 2;
  const isDemo = accounts.length === 0;
  const paperTradeMode = settings.length > 0 ? (settings[0] as any).paperTradeMode ?? false : false;
  const requirePositiveEv = settings.length > 0 ? (settings[0] as any).requirePositiveEv ?? true : true;

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

  const prices = await getTickHistory(symbol, 30);
  const rawAnalysis = analyzeMarket(symbol, market?.category ?? "synthetic", prices, balance, {
    maxRiskPerTrade: maxRisk,
    minConfidenceThreshold: settings.length > 0 ? Number(settings[0].minConfidenceThreshold) : 65,
    riskProfile: settings.length > 0 ? settings[0].riskProfile : "moderate",
    preferredContractTypes: settings.length > 0 ? settings[0].preferredContractTypes.split(",").filter(Boolean) : undefined,
    tradeDurationSec: settings.length > 0 ? settings[0].tradeDurationSec : 5,
  });

  const token = getCachedToken() ?? (accounts.length > 0 ? accounts[0].token ?? null : null);
  const finalized = await finalizeAnalysis(rawAnalysis, {
    symbol,
    currency: accounts.length > 0 ? accounts[0].currency : "USD",
    token,
    defaultDuration: rawAnalysis.recommendedDuration ?? (settings.length > 0 ? settings[0].tradeDurationSec : 5),
    barrier: requestBarrier ?? rawAnalysis.digitBarrier,
    skipProposal: paperTradeMode || isDemo,
  });

  const tradeDuration = duration ?? finalized.recommendedDuration ?? 5;
  const isDigit = contractType.includes("DIGIT");
  // Use user-selected barrier if provided, fall back to AI-recommended barrier
  const barrier = isDigit ? (requestBarrier ?? rawAnalysis.digitBarrier ?? undefined) : undefined;
  const currency = accounts.length > 0 ? accounts[0].currency : "USD";

  const isLiveTrade = !isDemo && !paperTradeMode && !!token;

  let won: boolean, profit: number, payout: number, entryPrice: number, exitPrice: number;

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
      aiConfidence: String(finalized.calibratedConfidence),
      aiRiskScore: String(finalized.riskScore),
      isAutonomous: isAutonomous ?? false,
      agentReasoning: `${rawAnalysis.reasoning} EV=$${finalized.expectedValue.toFixed(2)} (breakeven ${finalized.breakevenWinRate}%)`,
      duration: tradeDuration,
      durationUnit: durationUnit ?? "t",
    }).returning();

    try {
      logger.info({ symbol, contractType, stake, barrier }, "Executing live trade");
      const liveResult = await executeLiveTrade(token!, {
        symbol,
        contractType,
        stake,
        duration: tradeDuration,
        durationUnit: durationUnit ?? "t",
        currency,
        barrier,
      });
      entryPrice = liveResult.buyPrice;

      const contractResult = await waitForContractResult(token!, liveResult.contractId, (tradeDuration + 10) * 1000);
      won = contractResult.won;
      profit = contractResult.profit;
      exitPrice = contractResult.exitSpot;
      payout = stake + Math.max(profit, 0);
    } catch (liveErr) {
      logger.warn({ liveErrMsg: liveErr instanceof Error ? liveErr.message : String(liveErr) }, "Live trade failed — cancelling open trade");
      await db.update(tradesTable)
        .set({ status: "lost", profit: "0", closedAt: new Date() })
        .where(eq(tradesTable.id, openTrade.id));
      res.status(500).json({ error: "Live trade execution failed. Deriv may be unavailable." });
      return;
    }

    await updateSelfLearning(symbol, contractType, rawAnalysis.digitBarrier, won);

    const [closedTrade] = await db.update(tradesTable).set({
      status: won ? "won" : "lost",
      payout: String(payout),
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

    await logTradeFeatures(closedTrade.id, finalized, {
      symbol, barrier: rawAnalysis.digitBarrier, tickWindow: rawAnalysis.tickWindow,
      duration: tradeDuration, isPaperTrade: false,
    });

    res.status(201).json(formatTrade(closedTrade));
    return;
  }

  // Paper / demo trade simulation
  const winProbability = finalized.winProbability / 100;
  won = Math.random() < winProbability;
  payout = stake * finalized.payoutMultiplier;
  profit = won ? payout - stake : -stake;

  entryPrice = prices[prices.length - 1];
  exitPrice = won
    ? direction === "up" ? entryPrice * 1.001 : entryPrice * 0.999
    : direction === "up" ? entryPrice * 0.999 : entryPrice * 1.001;

  await updateSelfLearning(symbol, contractType, rawAnalysis.digitBarrier, won);

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
    aiConfidence: String(finalized.calibratedConfidence),
    aiRiskScore: String(finalized.riskScore),
    isAutonomous: isAutonomous ?? false,
    agentReasoning: `[${isDemo ? "DEMO" : "PAPER"}] ${rawAnalysis.reasoning} EV=$${finalized.expectedValue.toFixed(2)}`,
    duration: tradeDuration,
    durationUnit: durationUnit ?? "t",
    closedAt: new Date(),
  }).returning();

  await logTradeFeatures(trade.id, finalized, {
    symbol, barrier: rawAnalysis.digitBarrier, tickWindow: rawAnalysis.tickWindow,
    duration: tradeDuration, isPaperTrade: true,
  });

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
