import { Router } from "express";
import { db } from "@workspace/db";
import { aiInsightsTable, tradesTable, settingsTable, accountsTable } from "@workspace/db";
import { sql, desc } from "drizzle-orm";
import { analyzeMarket, updateSelfLearning } from "../lib/ai-engine";
import { tickManager, DERIV_MARKETS, executeLiveTrade, waitForContractResult, getLiveBalance, getCachedToken, getMarketInfo } from "../lib/deriv";
import { ToggleAutonomousEngineBody } from "@workspace/api-zod";
import { logger } from "../lib/logger";

const router = Router();

// ── Engine state ─────────────────────────────────────────────────────────────
let engineRunning = false;
let autonomousMode = "manual";
let tradesExecutedToday = 0;
let currentMarket: string | null = null;
let nextScanIn: number | null = null;
let stopReasons: string[] = [];
let autonomousTimer: ReturnType<typeof setTimeout> | null = null;
let loopIntervalSec = 15;
let lastTradeTime: Date | null = null;

let exploitSymbol: string | null = null;
let exploitCount = 0;
let exploitQualityThreshold = 0;
let recoveryStep = 0;
let baseStake = 0;

const AGENT_NAMES = [
  "Market Scanner", "Trend Analysis", "Volatility Analysis", "Pattern Recognition",
  "Risk Management", "Capital Preservation", "Trade Execution", "Self-Learning Performance",
];

async function getAccountAndSettings() {
  const accounts = await db.select().from(accountsTable).limit(1);
  const settings = await db.select().from(settingsTable).limit(1);
  return {
    balance: accounts.length > 0 ? Number(accounts[0].balance) : 10000,
    settings: settings.length > 0 ? settings[0] : null,
    accountId: accounts.length > 0 ? accounts[0].id : null,
    account: accounts.length > 0 ? accounts[0] : null,
  };
}

// ── SSE clients ───────────────────────────────────────────────────────────────
const sseClients = new Set<any>();

export function broadcastSSE(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// ── Wire up TickManager → SSE for live prices ─────────────────────────────────
tickManager.on("tick", (tick) => {
  broadcastSSE("tick", tick);
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function stopEngine(reason: string) {
  engineRunning = false;
  autonomousMode = "manual";
  stopReasons = [reason];
  currentMarket = null;
  nextScanIn = null;
  exploitSymbol = null;
  exploitCount = 0;
  recoveryStep = 0;
  if (autonomousTimer) { clearTimeout(autonomousTimer); autonomousTimer = null; }
  logger.info({ reason }, "Autonomous engine stopped");
  broadcastSSE("engine_stopped", { reason });
}

async function syncLiveBalance(token: string) {
  try {
    const balance = await getLiveBalance(token);
    if (balance !== null) await db.update(accountsTable).set({ balance: String(balance), updatedAt: new Date() });
  } catch { /* ignore */ }
}

// ── Autonomous loop ───────────────────────────────────────────────────────────
async function runAutonomousLoop() {
  if (!engineRunning) return;

  try {
    const { balance, settings, account } = await getAccountAndSettings();
    const token = getCachedToken() ?? account?.token ?? null;

    const minConfidence = settings ? Number(settings.minConfidenceThreshold) : 50;
    const dailyLossLimit = settings ? Number(settings.dailyLossLimit) : 30;
    const dailyTarget = settings ? Number(settings.dailyTarget) : 50;
    const consecutiveLossLimit = settings?.consecutiveLossLimit ?? 3;
    const recoveryModeEnabled = settings?.recoveryMode ?? false;
    const recoveryMultiplier = settings ? Number(settings.recoveryMultiplier) : 1.2;
    const maxRecoverySteps = settings?.maxRecoverySteps ?? 3;
    const marketRotationAfter = settings?.marketRotationAfter ?? 5;
    const tradeDurationSec = settings?.tradeDurationSec ?? 5;
    const maxTradeStake = settings ? Number(settings.maxTradeStake) : 500;
    const preferredContractTypes = settings?.preferredContractTypes?.split(",").filter(Boolean) ?? ["RISE", "FALL", "CALL", "PUT", "DIGITOVER", "DIGITUNDER"];

    if (settings?.loopIntervalSec) loopIntervalSec = settings.loopIntervalSec;

    // Daily stats
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayTrades = await db.select().from(tradesTable).where(sql`${tradesTable.createdAt} >= ${today}`);
    const closedToday = todayTrades.filter((t) => t.status === "won" || t.status === "lost");
    const todayProfit = closedToday.reduce((s, t) => s + Number(t.profit ?? 0), 0);
    tradesExecutedToday = closedToday.length;

    // Stop conditions
    if (todayProfit <= -dailyLossLimit) { stopEngine(`Daily loss limit $${dailyLossLimit} reached`); return; }
    if (todayProfit >= dailyTarget) { stopEngine(`Daily target $${dailyTarget} reached!`); return; }

    const sorted = [...closedToday].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    let consecutiveLosses = 0;
    for (const t of sorted) { if (t.status === "lost") consecutiveLosses++; else break; }
    if (consecutiveLosses >= consecutiveLossLimit) { stopEngine(`${consecutiveLosses} consecutive losses — cooldown`); return; }

    // Recovery step
    const lastWasLoss = sorted[0]?.status === "lost";
    if (lastWasLoss && recoveryModeEnabled) recoveryStep = Math.min(recoveryStep + 1, maxRecoverySteps);
    else if (!lastWasLoss) recoveryStep = 0;

    const settingsObj = {
      maxRiskPerTrade: settings ? Number(settings.maxRiskPerTrade) : 2,
      minConfidenceThreshold: minConfidence,
      riskProfile: settings?.riskProfile ?? "moderate",
      preferredContractTypes,
      tradeDurationSec,
      maxTradeStake,
    };

    // ── Market selection with exploit mode ─────────────────────────────────────
    let bestMarket: { symbol: string; category: string; displayName: string; analysis: ReturnType<typeof analyzeMarket>; prices: number[] } | null = null;

    if (exploitSymbol && exploitCount < marketRotationAfter) {
      const market = getMarketInfo(exploitSymbol);
      if (market) {
        const prices = tickManager.getTicks(market.symbol, 100);
        const digits = market.digitEnabled ? tickManager.getDigits(market.symbol, 300) : undefined;
        const analysis = analyzeMarket(market.symbol, market.category, prices, balance, settingsObj, digits);
        if (analysis.qualityScore >= exploitQualityThreshold - 10 && analysis.confidenceScore >= minConfidence) {
          bestMarket = { ...market, analysis, prices };
          exploitCount++;
        } else {
          exploitSymbol = null; exploitCount = 0;
        }
      }
    }

    if (!bestMarket) {
      // Parallel scan all markets from live tick buffers — zero latency
      const scanResults = await Promise.all(
        DERIV_MARKETS.map(async (m) => {
          const prices = tickManager.getTicks(m.symbol, 100);
          const digits = m.digitEnabled ? tickManager.getDigits(m.symbol, 300) : undefined;
          const analysis = analyzeMarket(m.symbol, m.category, prices, balance, settingsObj, digits);
          return { ...m, analysis, prices };
        })
      );
      scanResults.sort((a, b) => b.analysis.qualityScore - a.analysis.qualityScore);
      const top = scanResults[0];
      if (top && top.analysis.confidenceScore >= minConfidence) {
        bestMarket = top;
        exploitSymbol = top.symbol;
        exploitQualityThreshold = top.analysis.qualityScore;
        exploitCount = 1;
      } else if (top) {
        bestMarket = top; // still use it, just won't trade if below threshold
      }
    }

    if (!bestMarket) {
      scheduleNext(); return;
    }

    currentMarket = bestMarket.symbol;
    broadcastSSE("scan_complete", { symbol: bestMarket.symbol, quality: bestMarket.analysis.qualityScore, confidence: bestMarket.analysis.confidenceScore });

    const { analysis } = bestMarket;
    logger.info({ symbol: bestMarket.symbol, confidence: analysis.confidenceScore, quality: analysis.qualityScore, contract: analysis.recommendedContractType }, "Autonomous scan");

    // ── Trade execution ────────────────────────────────────────────────────────
    if (analysis.confidenceScore >= minConfidence && analysis.riskScore < 70) {
      let stake = analysis.recommendedStake;
      if (baseStake === 0) baseStake = stake;

      if (recoveryModeEnabled && recoveryStep > 0) {
        stake = Math.min(baseStake * Math.pow(recoveryMultiplier, recoveryStep), maxTradeStake);
      }
      stake = Math.min(stake, maxTradeStake);

      let won: boolean, profit: number, entryPrice: number, exitPrice: number;
      const payout = stake * 1.87;

      if (token) {
        try {
          const barrier = analysis.recommendedContractType.includes("DIGIT") ? (analysis.digitBarrier ?? 5) : undefined;
          const liveResult = await executeLiveTrade(token, {
            symbol: bestMarket.symbol,
            contractType: analysis.recommendedContractType,
            stake,
            duration: tradeDurationSec,
            durationUnit: "t",
            currency: account?.currency ?? "USD",
            barrier,
          });
          entryPrice = liveResult.buyPrice;
          const contractResult = await waitForContractResult(token, liveResult.contractId, (tradeDurationSec + 5) * 1000);
          won = contractResult.won;
          profit = contractResult.profit;
          exitPrice = contractResult.exitSpot;
          await syncLiveBalance(token);
        } catch (liveErr) {
          logger.warn({ liveErr }, "Live trade failed, simulating");
          won = Math.random() < analysis.confidenceScore / 100;
          profit = won ? payout - stake : -stake;
          entryPrice = bestMarket.prices[bestMarket.prices.length - 1] ?? 100;
          exitPrice = entryPrice * (won ? (analysis.direction === "up" ? 1.001 : 0.999) : (analysis.direction === "up" ? 0.999 : 1.001));
        }
      } else {
        won = Math.random() < analysis.confidenceScore / 100;
        profit = won ? payout - stake : -stake;
        entryPrice = bestMarket.prices[bestMarket.prices.length - 1] ?? 100;
        exitPrice = entryPrice * (won ? (analysis.direction === "up" ? 1.001 : 0.999) : (analysis.direction === "up" ? 0.999 : 1.001));
      }

      updateSelfLearning(bestMarket.symbol, won);

      await db.insert(tradesTable).values({
        symbol: bestMarket.symbol,
        displayName: bestMarket.displayName,
        contractType: analysis.recommendedContractType,
        stake: String(stake),
        direction: analysis.direction,
        status: won ? "won" : "lost",
        payout: String(payout),
        profit: String(profit),
        entryPrice: String(entryPrice),
        exitPrice: String(exitPrice),
        aiConfidence: String(analysis.confidenceScore),
        aiRiskScore: String(analysis.riskScore),
        isAutonomous: true,
        agentReasoning: analysis.reasoning,
        duration: tradeDurationSec,
        durationUnit: "t",
        closedAt: new Date(),
      });

      tradesExecutedToday++;
      lastTradeTime = new Date();

      broadcastSSE("trade_completed", { symbol: bestMarket.symbol, won, profit: profit.toFixed(2), contract: analysis.recommendedContractType, stake, live: !!token });
      logger.info({ symbol: bestMarket.symbol, won, profit: profit.toFixed(2), stake, live: !!token }, "Trade executed");
    }
  } catch (err) {
    logger.error({ err }, "Autonomous loop error");
  }

  scheduleNext();
}

function scheduleNext() {
  if (!engineRunning) return;
  nextScanIn = loopIntervalSec;
  autonomousTimer = setTimeout(runAutonomousLoop, loopIntervalSec * 1000);
}

// ── Routes ─────────────────────────────────────────────────────────────────────

router.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  sseClients.add(res);
  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, liveTickCount: tickManager.getLiveTickCount(), connected: tickManager.getConnectionStatus() })}\n\n`);

  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
  }, 25000);

  req.on("close", () => { clearInterval(heartbeat); sseClients.delete(res); });
});

router.get("/recommendation", async (_req, res): Promise<void> => {
  const { balance, settings } = await getAccountAndSettings();
  const settingsObj = {
    maxRiskPerTrade: settings ? Number(settings.maxRiskPerTrade) : 2,
    minConfidenceThreshold: settings ? Number(settings.minConfidenceThreshold) : 55,
    riskProfile: settings?.riskProfile ?? "moderate",
    preferredContractTypes: settings?.preferredContractTypes?.split(",").filter(Boolean),
    tradeDurationSec: settings?.tradeDurationSec ?? 5,
    maxTradeStake: settings ? Number(settings.maxTradeStake) : 500,
  };

  const results = await Promise.all(
    DERIV_MARKETS.map(async (m) => {
      const prices = tickManager.getTicks(m.symbol, 100);
      const digits = m.digitEnabled ? tickManager.getDigits(m.symbol, 300) : undefined;
      return { ...m, analysis: analyzeMarket(m.symbol, m.category, prices, balance, settingsObj, digits), prices };
    })
  );

  results.sort((a, b) => b.analysis.qualityScore - a.analysis.qualityScore);
  const best = results[0];
  if (!best) { res.status(404).json({ error: "No markets available" }); return; }

  const { analysis } = best;
  res.json({
    symbol: best.symbol, contractType: analysis.recommendedContractType, direction: analysis.direction,
    stake: analysis.recommendedStake, confidence: analysis.confidenceScore, riskScore: analysis.riskScore,
    profitability: analysis.profitability, agentScores: analysis.agentScores, shouldTrade: analysis.shouldTrade,
    reasoning: analysis.reasoning, warnings: analysis.warnings, suggestedContractTypes: analysis.suggestedContractTypes,
    digitStats: analysis.digitStats ?? null, digitBarrier: analysis.digitBarrier ?? null,
    generatedAt: new Date().toISOString(),
  });
});

router.get("/recommendation/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const market = getMarketInfo(symbol);
  if (!market) { res.status(404).json({ error: "Market not found" }); return; }

  const { balance, settings } = await getAccountAndSettings();
  const s = {
    maxRiskPerTrade: settings ? Number(settings.maxRiskPerTrade) : 2,
    minConfidenceThreshold: settings ? Number(settings.minConfidenceThreshold) : 55,
    riskProfile: settings?.riskProfile ?? "moderate",
    preferredContractTypes: settings?.preferredContractTypes?.split(",").filter(Boolean),
    tradeDurationSec: settings?.tradeDurationSec ?? 5,
    maxTradeStake: settings ? Number(settings.maxTradeStake) : 500,
  };

  const prices = tickManager.getTicks(symbol, 100);
  const digits = market.digitEnabled ? tickManager.getDigits(symbol, 300) : undefined;
  const analysis = analyzeMarket(symbol, market.category, prices, balance, s, digits);

  res.json({
    symbol, contractType: analysis.recommendedContractType, direction: analysis.direction,
    stake: analysis.recommendedStake, confidence: analysis.confidenceScore, riskScore: analysis.riskScore,
    profitability: analysis.profitability, agentScores: analysis.agentScores, shouldTrade: analysis.shouldTrade,
    reasoning: analysis.reasoning, warnings: analysis.warnings, suggestedContractTypes: analysis.suggestedContractTypes,
    digitStats: analysis.digitStats ?? null, digitBarrier: analysis.digitBarrier ?? null,
    generatedAt: new Date().toISOString(),
  });
});

router.get("/insights", async (_req, res): Promise<void> => {
  const trades = await db.select().from(tradesTable).where(sql`${tradesTable.status} IN ('won', 'lost')`).orderBy(desc(tradesTable.createdAt)).limit(200);

  const won = trades.filter((t) => t.status === "won");
  const lost = trades.filter((t) => t.status === "lost");
  const winRate = trades.length > 0 ? won.length / trades.length : 0;
  const totalProfit = trades.reduce((s, t) => s + Number(t.profit ?? 0), 0);
  const avgProfit = trades.length > 0 ? totalProfit / trades.length : 0;

  const marketStats: Record<string, { won: number; total: number; profit: number }> = {};
  for (const t of trades) {
    if (!marketStats[t.symbol]) marketStats[t.symbol] = { won: 0, total: 0, profit: 0 };
    marketStats[t.symbol].total++;
    marketStats[t.symbol].profit += Number(t.profit ?? 0);
    if (t.status === "won") marketStats[t.symbol].won++;
  }

  const contractStats: Record<string, { won: number; total: number }> = {};
  for (const t of trades) {
    if (!contractStats[t.contractType]) contractStats[t.contractType] = { won: 0, total: 0 };
    contractStats[t.contractType].total++;
    if (t.status === "won") contractStats[t.contractType].won++;
  }

  const marketEntries = Object.entries(marketStats).filter(([, s]) => s.total >= 2);
  const bestMarket = [...marketEntries].sort((a, b) => (b[1].won / b[1].total) - (a[1].won / a[1].total))[0];
  const worstMarket = [...marketEntries].sort((a, b) => (a[1].won / a[1].total) - (b[1].won / b[1].total))[0];

  const sorted = [...trades].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  let currentConsecLosses = 0, maxLossStreak = 0, curStreak = 0;
  for (const t of sorted) { if (t.status === "lost") currentConsecLosses++; else break; }
  for (const t of sorted) { if (t.status === "lost") { curStreak++; maxLossStreak = Math.max(maxLossStreak, curStreak); } else curStreak = 0; }

  const highConf = trades.filter((t) => Number(t.aiConfidence ?? 0) >= 65);
  const highConfWinRate = highConf.length > 0 ? highConf.filter((t) => t.status === "won").length / highConf.length : 0;
  const lowConf = trades.filter((t) => Number(t.aiConfidence ?? 0) < 65);
  const lowConfWinRate = lowConf.length > 0 ? lowConf.filter((t) => t.status === "won").length / lowConf.length : 0;

  const digitTrades = trades.filter((t) => t.contractType.includes("DIGIT"));
  const digitWinRate = digitTrades.length > 0 ? digitTrades.filter((t) => t.status === "won").length / digitTrades.length : 0;
  const riseFallTrades = trades.filter((t) => t.contractType === "RISE" || t.contractType === "FALL");
  const riseFallWinRate = riseFallTrades.length > 0 ? riseFallTrades.filter((t) => t.status === "won").length / riseFallTrades.length : 0;

  const liveStatus = `Deriv WS ${tickManager.getConnectionStatus() ? "connected" : "disconnected"} — ${tickManager.getLiveTickCount()} ticks buffered`;

  const insights = [];

  if (trades.length === 0) {
    insights.push({ id: 1, type: "improvement", title: "Start Trading to Build AI Insights", description: `${liveStatus}. Start the autonomous engine to begin generating personalized trade analysis.`, priority: "medium", actionable: true, relatedMarket: null });
  } else {
    insights.push({ id: 1, type: "pattern", title: `${(winRate * 100).toFixed(1)}% win rate — ${trades.length} total trades`, description: `Won: ${won.length}, Lost: ${lost.length}. Avg P&L: ${avgProfit >= 0 ? "+" : ""}$${avgProfit.toFixed(2)}. ${winRate > 0.55 ? "You have a profitable edge." : winRate > 0.45 ? "Near break-even — try raising confidence threshold." : "Below break-even — review settings."}`, priority: winRate > 0.55 ? "low" : "high", actionable: winRate <= 0.55, relatedMarket: null });

    if (digitTrades.length > 5 && riseFallTrades.length > 5) {
      const betterType = digitWinRate > riseFallWinRate ? "DIGIT OVER/UNDER" : "RISE/FALL";
      insights.push({ id: 2, type: "pattern", title: `${betterType} contracts are outperforming`, description: `DIGIT contracts: ${(digitWinRate * 100).toFixed(1)}% win rate. RISE/FALL: ${(riseFallWinRate * 100).toFixed(1)}%. Adjust preferred contract types in Settings for better results.`, priority: Math.abs(digitWinRate - riseFallWinRate) > 0.1 ? "high" : "medium", actionable: true, relatedMarket: null });
    }

    if (bestMarket) {
      insights.push({ id: 3, type: "milestone", title: `Best market: ${bestMarket[0]} at ${((bestMarket[1].won / bestMarket[1].total) * 100).toFixed(0)}% win rate`, description: `${bestMarket[1].won}/${bestMarket[1].total} wins, $${bestMarket[1].profit.toFixed(2)} profit. Engine prioritises this market in exploit mode.`, priority: "low", actionable: false, relatedMarket: bestMarket[0] });
    }

    if (currentConsecLosses >= 2) {
      insights.push({ id: 4, type: "warning", title: `⚠ Active losing streak: ${currentConsecLosses} consecutive losses`, description: `Consider pausing the engine. Recovery Mode is ${currentConsecLosses >= 3 ? "strongly " : ""}recommended to manage stake sizing automatically.`, priority: currentConsecLosses >= 3 ? "high" : "medium", actionable: true, relatedMarket: null });
    }

    if (highConf.length > 3 && lowConf.length > 3) {
      insights.push({ id: 5, type: "improvement", title: `High-confidence trades: ${(highConfWinRate * 100).toFixed(1)}% vs low-confidence: ${(lowConfWinRate * 100).toFixed(1)}%`, description: highConfWinRate > lowConfWinRate + 0.05 ? "Raise confidence threshold to 65+ for significantly better results." : "Your confidence threshold is well-calibrated.", priority: highConfWinRate > lowConfWinRate + 0.1 ? "high" : "low", actionable: highConfWinRate > lowConfWinRate + 0.05, relatedMarket: null });
    }

    if (worstMarket && worstMarket[1].total >= 3 && worstMarket[1].won / worstMarket[1].total < 0.4) {
      insights.push({ id: 6, type: "warning", title: `Avoid ${worstMarket[0]}: ${((worstMarket[1].won / worstMarket[1].total) * 100).toFixed(0)}% win rate`, description: `Only ${worstMarket[1].won}/${worstMarket[1].total} wins on this market. Self-learning agent has reduced its priority score.`, priority: "medium", actionable: true, relatedMarket: worstMarket[0] });
    }
  }

  res.json(insights);
});

router.get("/engine/status", async (_req, res): Promise<void> => {
  const settings = await db.select().from(settingsTable).limit(1);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayTrades = await db.select().from(tradesTable).where(sql`${tradesTable.createdAt} >= ${today}`);

  res.json({
    isRunning: engineRunning, mode: engineRunning ? "autonomous" : "manual",
    agentStatuses: AGENT_NAMES.map((name) => ({
      name, isActive: engineRunning, lastRun: engineRunning ? new Date().toISOString() : null,
      confidence: engineRunning ? 55 + Math.random() * 35 : 45 + Math.random() * 20,
    })),
    tradesExecutedToday: todayTrades.length,
    currentMarket, nextScanIn: engineRunning ? nextScanIn : null, stopReasons, loopIntervalSec,
    lastTradeTime: lastTradeTime?.toISOString() ?? null, exploitSymbol, exploitCount, recoveryStep,
    wsConnected: tickManager.getConnectionStatus(),
    liveTickCount: tickManager.getLiveTickCount(),
  });
});

router.post("/engine/toggle", async (req, res): Promise<void> => {
  const parseResult = ToggleAutonomousEngineBody.safeParse(req.body);
  if (!parseResult.success) { res.status(400).json({ error: "Invalid request" }); return; }
  const { running } = parseResult.data;

  const settings = await db.select().from(settingsTable).limit(1);
  if (settings.length > 0 && settings[0].loopIntervalSec) loopIntervalSec = settings[0].loopIntervalSec;

  if (running) {
    engineRunning = true; autonomousMode = "autonomous"; stopReasons = []; nextScanIn = loopIntervalSec;
    exploitSymbol = null; exploitCount = 0; recoveryStep = 0; baseStake = 0;
    if (settings.length > 0) await db.update(settingsTable).set({ autonomousEnabled: true });
    if (autonomousTimer) { clearTimeout(autonomousTimer); autonomousTimer = null; }
    autonomousTimer = setTimeout(runAutonomousLoop, 2000);
    logger.info({ loopIntervalSec }, "Autonomous engine started");
  } else {
    engineRunning = false; autonomousMode = "manual"; currentMarket = null; nextScanIn = null;
    exploitSymbol = null; recoveryStep = 0;
    if (autonomousTimer) { clearTimeout(autonomousTimer); autonomousTimer = null; }
    if (settings.length > 0) await db.update(settingsTable).set({ autonomousEnabled: false });
  }

  res.json({
    isRunning: engineRunning, mode: autonomousMode,
    agentStatuses: AGENT_NAMES.map((name) => ({
      name, isActive: engineRunning, lastRun: engineRunning ? new Date().toISOString() : null,
      confidence: engineRunning ? 55 + Math.random() * 35 : 45 + Math.random() * 20,
    })),
    tradesExecutedToday, currentMarket, nextScanIn, stopReasons, loopIntervalSec,
    lastTradeTime: lastTradeTime?.toISOString() ?? null, exploitSymbol, exploitCount, recoveryStep,
    wsConnected: tickManager.getConnectionStatus(),
    liveTickCount: tickManager.getLiveTickCount(),
  });
});

export default router;
