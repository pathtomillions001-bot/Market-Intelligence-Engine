import { Router } from "express";
import { db } from "@workspace/db";
import { tradesTable, accountsTable, settingsTable } from "@workspace/db";
import { eq, desc, and, sql } from "drizzle-orm";
import { ExecuteTradeBody, GetTradesQueryParams, GetTradeParams } from "@workspace/api-zod";
import { tickManager, DERIV_MARKETS, getCachedToken, executeLiveTrade, waitForContractResult, getLiveBalance, fetchDerivProfitTable, journalManager } from "../lib/deriv";
import { runCoordinator, buildLegacyAnalysis, recordTradeOutcome, updateDigitRecovery } from "../lib/agent-coordinator";
import { logger } from "../lib/logger";
import { broadcastSSE } from "../lib/sse";
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

// ── Helper: get Deriv journal transactions (cache-first, one-shot fallback) ────
async function getDerivTransactions(token: string): Promise<any[]> {
  // Return cached data if fresh (within 20s — short window so force-refreshed data lands quickly)
  if (journalManager.isCacheFresh(20_000)) {
    return journalManager.getCached();
  }
  // Cache stale or empty — do a one-shot fetch and let the persistent manager update async
  try {
    return await fetchDerivProfitTable(token, 200);
  } catch {
    // Use whatever is in cache even if stale
    return journalManager.getCached();
  }
}

const EMPTY_STATS = {
  totalTrades: 0, wonTrades: 0, lostTrades: 0, winRate: 0,
  totalProfit: 0, avgProfit: 0, bestTrade: 0, worstTrade: 0,
  currentStreak: 0, longestWinStreak: 0, longestLoseStreak: 0,
};

// ── Stats ──────────────────────────────────────────────────────────────────────

router.get("/stats", async (_req, res): Promise<void> => {
  const accounts = await db.select().from(accountsTable).limit(1);
  const token = getCachedToken() ?? (accounts.length > 0 ? accounts[0].token ?? null : null);

  if (!token) {
    res.json(EMPTY_STATS);
    return;
  }

  const transactions = await getDerivTransactions(token);
  const mapped = transactions.map((t: any) => {
    const buyPrice = Number(t.buy_price ?? 0);
    const sellPrice = Number(t.sell_price ?? 0);
    const profit = Math.round((sellPrice - buyPrice) * 100) / 100;
    return { won: profit > 0, profit, createdAt: t.purchase_time ? new Date(t.purchase_time * 1000).toISOString() : new Date().toISOString() };
  });

  const stats = computeJournalStats(mapped);
  res.json({
    totalTrades: stats.totalTrades,
    wonTrades: stats.wonTrades,
    lostTrades: stats.lostTrades,
    winRate: stats.winRate,
    totalProfit: stats.totalProfit,
    avgProfit: stats.avgProfit,
    bestTrade: stats.bestTrade,
    worstTrade: stats.worstTrade,
    currentStreak: stats.currentStreak,
    longestWinStreak: stats.longestWinStreak,
    longestLoseStreak: stats.longestLoseStreak,
  });
});

router.get("/daily-summary", async (_req, res): Promise<void> => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const settings = await db.select().from(settingsTable).limit(1);
  const accounts = await db.select().from(accountsTable).limit(1);
  const token = getCachedToken() ?? (accounts.length > 0 ? accounts[0].token ?? null : null);

  const dailyTarget = settings.length > 0 ? Number(settings[0].dailyTarget) : 50;
  const dailyLossLimit = settings.length > 0 ? Number(settings[0].dailyLossLimit) : 30;
  const balance = accounts.length > 0 ? Number(accounts[0].balance) : 0;

  if (!token) {
    // No Deriv connection — use local DB for engine-tracked trades only
    const todayTrades = await db.select().from(tradesTable).where(sql`${tradesTable.createdAt} >= ${today}`);
    const closed = todayTrades.filter((t) => t.status === "won" || t.status === "lost");
    const totalProfit = closed.reduce((s, t) => s + Number(t.profit ?? 0), 0);
    const won = closed.filter((t) => t.status === "won").length;
    res.json({
      date: today.toISOString().split("T")[0],
      tradesCount: closed.length, wonCount: won, lostCount: closed.length - won,
      totalProfit, dailyTarget, dailyLossLimit,
      targetProgress: dailyTarget > 0 ? Math.min(totalProfit / dailyTarget, 1) : 0,
      isTargetMet: totalProfit >= dailyTarget, isLossLimitHit: totalProfit <= -dailyLossLimit,
      balanceStart: balance - totalProfit, balanceNow: balance, currentStreak: 0,
    });
    return;
  }

  // Use Deriv journal as source of truth
  const transactions = await getDerivTransactions(token);
  const allMapped = transactions.map((t: any) => {
    const buyPrice = Number(t.buy_price ?? 0);
    const sellPrice = Number(t.sell_price ?? 0);
    const profit = Math.round((sellPrice - buyPrice) * 100) / 100;
    return { won: profit > 0, profit, createdAt: t.purchase_time ? new Date(t.purchase_time * 1000).toISOString() : new Date().toISOString() };
  });

  const todayMapped = allMapped.filter((t) => new Date(t.createdAt) >= today);
  const totalProfit = Math.round(todayMapped.reduce((s, t) => s + t.profit, 0) * 100) / 100;
  const won = todayMapped.filter((t) => t.won).length;

  // Streak from ALL recent trades (newest first from Deriv API — most accurate)
  const allStats = computeJournalStats(allMapped);

  res.json({
    date: today.toISOString().split("T")[0],
    tradesCount: todayMapped.length,
    wonCount: won,
    lostCount: todayMapped.length - won,
    totalProfit,
    dailyTarget,
    dailyLossLimit,
    targetProgress: dailyTarget > 0 ? Math.min(totalProfit / dailyTarget, 1) : 0,
    isTargetMet: totalProfit >= dailyTarget,
    isLossLimitHit: totalProfit <= -dailyLossLimit,
    balanceStart: balance - totalProfit,
    balanceNow: balance,
    currentStreak: allStats.currentStreak,
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
      // Deriv requires stake with max 2 decimal places
      const liveStake = Math.round(stake * 100) / 100;
      logger.info({ symbol, contractType, stake: liveStake, barrier }, "Executing live manual trade on Deriv");
      const liveResult = await executeLiveTrade(token!, {
        symbol,
        contractType,
        stake: liveStake,
        duration: tradeDuration,
        durationUnit: durationUnit ?? "t",
        currency,
        barrier,
      });

      // Wait for Deriv to settle the contract — ticks * 1s + 30s safety buffer
      const contractResult = await waitForContractResult(token!, liveResult.contractId, (tradeDuration + 30) * 1000);
      won = contractResult.won;
      // Use Deriv's exact profit — ground truth for the journal
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

    // actualPayout = total returned to account when won (stake + net profit), 0 when lost
    const actualPayout = won ? stake + profit : 0;
    const [closedTrade] = await db.update(tradesTable).set({
      status: won ? "won" : "lost",
      payout: String(actualPayout),
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

    broadcastSSE("trade_completed", {
      trade: {
        id: closedTrade.id, symbol, displayName, contractType: normalizeDerivContractType(contractType),
        barrier: barrier ?? null, stake, payout: actualPayout,
        profit: Math.round(profit * 100) / 100, won,
        status: won ? "won" : "lost", duration: tradeDuration,
        durationUnit: durationUnit ?? "t",
        createdAt: new Date().toISOString(), closedAt: new Date().toISOString(),
        aiConfidence: winProbability, isAutonomous: isAutonomous ?? false, source: "live",
      }
    });
    // Immediately refresh the Deriv profit_table so journal + streak reflect this trade
    // Broadcast journal_refreshed once Deriv confirms the updated profit_table
    journalManager.once("refreshed", () => {
      broadcastSSE("journal_refreshed", { ts: Date.now() });
    });
    journalManager.forceRefresh();
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

  broadcastSSE("trade_completed", {
    trade: {
      id: trade.id, symbol, displayName, contractType: normalizeDerivContractType(contractType),
      barrier: barrier ?? null, stake, payout: Number(payout.toFixed(2)),
      profit: Math.round(profit * 100) / 100, won,
      status: won ? "won" : "lost", duration: tradeDuration,
      durationUnit: durationUnit ?? "t",
      createdAt: new Date().toISOString(), closedAt: new Date().toISOString(),
      aiConfidence: winProbability, isAutonomous: isAutonomous ?? false, source: "paper",
    }
  });
  res.status(201).json(formatTrade(trade));
});

// ── Shared: compute stats from a trade list ────────────────────────────────────
// NOTE: trades must be sorted newest-first (Deriv profit_table default: sort:"DESC")
function computeJournalStats(trades: any[]) {
  const won = trades.filter((t) => t.won);
  const lost = trades.filter((t) => !t.won);
  const totalProfit = trades.reduce((s, t) => s + (t.profit ?? 0), 0);

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const today = trades.filter((t) => new Date(t.createdAt) >= todayStart);

  // Streak: iterate newest-first (trades[0] is most recent) — correct consecutive count
  let currentStreak = 0;
  for (const t of trades) {
    if (currentStreak === 0) currentStreak = t.won ? 1 : -1;
    else if (t.won && currentStreak > 0) currentStreak++;
    else if (!t.won && currentStreak < 0) currentStreak--;
    else break;
  }

  let longestWin = 0, longestLoss = 0, runLen = 0, runWon: boolean | null = null;
  for (const t of trades) {
    if (runWon === null || runWon !== t.won) {
      if (runWon === true) longestWin = Math.max(longestWin, runLen);
      if (runWon === false) longestLoss = Math.max(longestLoss, runLen);
      runLen = 1; runWon = t.won;
    } else { runLen++; }
  }
  if (runWon === true) longestWin = Math.max(longestWin, runLen);
  if (runWon === false) longestLoss = Math.max(longestLoss, runLen);

  return {
    totalTrades: trades.length,
    wonTrades: won.length,
    lostTrades: lost.length,
    winRate: trades.length > 0 ? won.length / trades.length : 0,
    totalProfit: Math.round(totalProfit * 100) / 100,
    avgProfit: trades.length > 0 ? Math.round((totalProfit / trades.length) * 100) / 100 : 0,
    bestTrade: won.length > 0 ? Math.max(...won.map((t) => t.profit ?? 0)) : 0,
    worstTrade: lost.length > 0 ? Math.min(...lost.map((t) => t.profit ?? 0)) : 0,
    todayProfit: Math.round(today.reduce((s, t) => s + (t.profit ?? 0), 0) * 100) / 100,
    todayTrades: today.length,
    todayWon: today.filter((t) => t.won).length,
    todayLost: today.filter((t) => !t.won).length,
    currentStreak,
    longestWinStreak: longestWin,
    longestLoseStreak: longestLoss,
  };
}

function normalizeDerivContractType(ct: string): string {
  // Canonical: CALL (Rise) and PUT (Fall). Normalize legacy RISE/FALL → CALL/PUT.
  if (ct === "RISE") return "CALL";
  if (ct === "FALL") return "PUT";
  return ct;
}

// ── Deriv profit_table journal (sole source of truth — no local fallback) ───────
router.get("/deriv-journal", async (_req, res): Promise<void> => {
  const accounts = await db.select().from(accountsTable).limit(1);
  const token = getCachedToken() ?? (accounts.length > 0 ? accounts[0].token ?? null : null);

  const emptyResponse = { source: "none" as const, trades: [], stats: computeJournalStats([]) };

  if (!token) {
    res.json(emptyResponse);
    return;
  }

  const transactions = await getDerivTransactions(token);

  if (transactions.length === 0) {
    res.json({ source: "deriv" as const, trades: [], stats: computeJournalStats([]) });
    return;
  }

  const mapped = transactions.map((t: any) => {
    const buyPrice = Number(t.buy_price ?? 0);
    const sellPrice = Number(t.sell_price ?? 0);
    const profit = Math.round((sellPrice - buyPrice) * 100) / 100;
    const market = DERIV_MARKETS.find((m) => m.symbol === t.underlying_symbol);
    return {
      id: t.transaction_id,
      symbol: t.underlying_symbol ?? "—",
      displayName: market?.displayName ?? t.underlying_symbol ?? "—",
      contractType: normalizeDerivContractType(t.contract_type ?? "UNKNOWN"),
      barrier: null,
      stake: buyPrice,
      payout: sellPrice,
      profit,
      won: profit > 0,
      status: profit > 0 ? "won" : "lost",
      duration: t.duration,
      durationUnit: t.duration_unit,
      createdAt: t.purchase_time ? new Date(t.purchase_time * 1000).toISOString() : new Date().toISOString(),
      closedAt: t.sell_time ? new Date(t.sell_time * 1000).toISOString() : null,
      longcode: t.longcode ?? null,
      isAutonomous: false,
      aiConfidence: null,
      source: "deriv",
    };
  });

  res.json({ source: "deriv" as const, trades: mapped, stats: computeJournalStats(mapped) });
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
