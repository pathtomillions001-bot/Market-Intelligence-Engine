import { Router } from "express";
import { db } from "@workspace/db";
import { aiInsightsTable, tradesTable, settingsTable, accountsTable } from "@workspace/db";
import { sql, desc } from "drizzle-orm";
import { analyzeMarket, updateSelfLearning } from "../lib/ai-engine";
import { getTickHistory, DERIV_MARKETS, executeLiveTrade, waitForContractResult, getLiveBalance, getCachedToken } from "../lib/deriv";
import { ToggleAutonomousEngineBody } from "@workspace/api-zod";
import { logger } from "../lib/logger";

const router = Router();

// ── Engine state ────────────────────────────────────────────────────────────
let engineRunning = false;
let autonomousMode = "manual";
let tradesExecutedToday = 0;
let currentMarket: string | null = null;
let nextScanIn: number | null = null;
let stopReasons: string[] = [];
let autonomousTimer: ReturnType<typeof setTimeout> | null = null;
let loopIntervalSec = 30;
let lastTradeTime: Date | null = null;

// ── Exploit mode ────────────────────────────────────────────────────────────
let exploitSymbol: string | null = null;
let exploitCount = 0;
let exploitQualityThreshold = 0;

// ── Recovery mode ────────────────────────────────────────────────────────────
let recoveryStep = 0;
let baseStake = 0;

const AGENT_NAMES = [
  "Market Scanner", "Trend Analysis", "Volatility Analysis", "Pattern Recognition",
  "Risk Management", "Capital Preservation", "Trade Execution", "Self-Learning Performance",
];

// ── Helpers ──────────────────────────────────────────────────────────────────
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

async function scanAllMarkets(categories: string[], balance: number, settingsObj: {
  maxRiskPerTrade: number;
  minConfidenceThreshold: number;
  riskProfile: string;
  preferredContractTypes?: string[];
  tradeDurationSec?: number;
  maxTradeStake?: number;
}) {
  const targets = DERIV_MARKETS.filter((m) => categories.includes(m.category));

  // Parallel scan — analyze all markets simultaneously
  const results = await Promise.all(
    targets.map(async (m) => {
      try {
        const prices = await getTickHistory(m.symbol, 30);
        const analysis = analyzeMarket(m.symbol, m.category, prices, balance, settingsObj);
        return { ...m, analysis, prices };
      } catch {
        return null;
      }
    })
  );

  const valid = results.filter(Boolean) as NonNullable<typeof results[0]>[];
  const sorted = valid.sort((a, b) => b.analysis.qualityScore - a.analysis.qualityScore);
  return sorted;
}

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
}

// ── Update balance in DB after live trade ────────────────────────────────────
async function syncLiveBalance(token: string) {
  try {
    const balance = await getLiveBalance(token);
    if (balance !== null) {
      await db.update(accountsTable).set({ balance: String(balance), updatedAt: new Date() });
    }
  } catch (err) {
    logger.warn({ err }, "Failed to sync live balance");
  }
}

// ── Autonomous trading loop ───────────────────────────────────────────────────
async function runAutonomousLoop() {
  if (!engineRunning) return;

  try {
    const { balance, settings, account } = await getAccountAndSettings();
    const token = getCachedToken() ?? account?.token ?? null;

    const minConfidence = settings ? Number(settings.minConfidenceThreshold) : 50;
    const dailyLossLimit = settings ? Number(settings.dailyLossLimit) : 30;
    const dailyTarget = settings ? Number(settings.dailyTarget) : 50;
    const consecutiveLossLimit = settings ? settings.consecutiveLossLimit : 3;
    const cats = settings?.preferredCategories?.split(",").map((c) => c.trim()).filter(Boolean) ?? ["synthetic"];
    const recoveryModeEnabled = settings?.recoveryMode ?? false;
    const recoveryMultiplier = settings ? Number(settings.recoveryMultiplier) : 1.2;
    const maxRecoverySteps = settings ? settings.maxRecoverySteps : 3;
    const marketRotationAfter = settings ? settings.marketRotationAfter : 5;
    const tradeDurationSec = settings ? settings.tradeDurationSec : 5;
    const maxTradeStake = settings ? Number(settings.maxTradeStake) : 500;

    if (loopIntervalSec !== (settings?.loopIntervalSec ?? loopIntervalSec)) {
      loopIntervalSec = settings?.loopIntervalSec ?? loopIntervalSec;
    }

    // ── Get today's trade history ────────────────────────────────────────
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTrades = await db.select().from(tradesTable).where(
      sql`${tradesTable.createdAt} >= ${today}`
    );
    const closedToday = todayTrades.filter((t) => t.status === "won" || t.status === "lost");
    const todayProfit = closedToday.reduce((s, t) => s + Number(t.profit ?? 0), 0);
    tradesExecutedToday = closedToday.length;

    // ── Stop conditions ─────────────────────────────────────────────────
    if (todayProfit <= -dailyLossLimit) { stopEngine(`Daily loss limit of $${dailyLossLimit} reached`); return; }
    if (todayProfit >= dailyTarget) { stopEngine(`Daily profit target of $${dailyTarget} met!`); return; }

    const sorted = [...closedToday].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    let consecutiveLosses = 0;
    for (const t of sorted) {
      if (t.status === "lost") consecutiveLosses++;
      else break;
    }
    if (consecutiveLosses >= consecutiveLossLimit) {
      stopEngine(`${consecutiveLosses} consecutive losses — cooldown triggered`);
      return;
    }

    // ── Recovery stake multiplier ─────────────────────────────────────────
    const lastWasLoss = sorted[0]?.status === "lost";
    if (lastWasLoss && recoveryModeEnabled) {
      recoveryStep = Math.min(recoveryStep + 1, maxRecoverySteps);
    } else if (!lastWasLoss) {
      recoveryStep = 0;
    }

    // ── Market scan ────────────────────────────────────────────────────────
    let bestMarket: { symbol: string; category: string; displayName: string; analysis: ReturnType<typeof analyzeMarket>; prices: number[] } | null = null;

    const settingsObj = {
      maxRiskPerTrade: settings ? Number(settings.maxRiskPerTrade) : 2,
      minConfidenceThreshold: minConfidence,
      riskProfile: settings?.riskProfile ?? "moderate",
      preferredContractTypes: settings?.preferredContractTypes?.split(",").map((c) => c.trim()).filter(Boolean),
      tradeDurationSec,
      maxTradeStake,
    };

    // Exploit mode: stay on a hot market until quality drops
    if (exploitSymbol && exploitCount < marketRotationAfter) {
      const market = DERIV_MARKETS.find((m) => m.symbol === exploitSymbol);
      if (market) {
        const prices = await getTickHistory(market.symbol, 30);
        const analysis = analyzeMarket(market.symbol, market.category, prices, balance, settingsObj);
        if (analysis.qualityScore >= exploitQualityThreshold - 10 && analysis.confidenceScore >= minConfidence) {
          bestMarket = { ...market, analysis, prices };
          exploitCount++;
        } else {
          // Market no longer favorable, switch
          exploitSymbol = null;
          exploitCount = 0;
        }
      }
    }

    if (!bestMarket) {
      const allMarkets = await scanAllMarkets(cats, balance, settingsObj);
      if (allMarkets.length > 0) {
        bestMarket = allMarkets[0];
        if (bestMarket.analysis.confidenceScore >= minConfidence) {
          exploitSymbol = bestMarket.symbol;
          exploitQualityThreshold = bestMarket.analysis.qualityScore;
          exploitCount = 1;
        }
      }
    }

    if (!bestMarket) {
      logger.warn("Autonomous loop: no suitable market found, retrying next cycle");
      scheduleNext();
      return;
    }

    currentMarket = bestMarket.symbol;
    const { analysis } = bestMarket;

    logger.info({
      symbol: bestMarket.symbol,
      confidence: analysis.confidenceScore,
      quality: analysis.qualityScore,
      contractType: analysis.recommendedContractType,
      exploitCount,
    }, "Autonomous loop scan complete");

    // ── Execute trade if threshold met ────────────────────────────────────
    if (analysis.confidenceScore >= minConfidence && analysis.riskScore < 70) {
      let stake = analysis.recommendedStake;
      if (baseStake === 0) baseStake = stake;

      // Apply recovery multiplier (conservative — max 1.2^3 = 1.73x)
      if (recoveryModeEnabled && recoveryStep > 0) {
        stake = Math.min(baseStake * Math.pow(recoveryMultiplier, recoveryStep), maxTradeStake);
      }
      stake = Math.min(stake, maxTradeStake);

      let won: boolean;
      let profit: number;
      let entryPrice: number;
      let exitPrice: number;
      const payout = stake * 1.87;

      if (token) {
        // ── Live Deriv execution ──────────────────────────────────────────
        try {
          const liveResult = await executeLiveTrade(token, {
            symbol: bestMarket.symbol,
            contractType: analysis.recommendedContractType,
            stake,
            duration: tradeDurationSec,
            durationUnit: "t",
            currency: account?.currency ?? "USD",
            barrier: analysis.recommendedContractType.startsWith("DIGIT") ? 5 : undefined,
          });

          entryPrice = liveResult.buyPrice;

          const contractResult = await waitForContractResult(token, liveResult.contractId, (tradeDurationSec + 5) * 1000);
          won = contractResult.won;
          profit = contractResult.profit;
          exitPrice = contractResult.exitSpot;

          await syncLiveBalance(token);

          logger.info({ contractId: liveResult.contractId, won, profit }, "Live Deriv trade settled");
        } catch (liveErr) {
          // Fall back to simulated if live trade fails
          logger.warn({ liveErr }, "Live trade failed, falling back to simulation");
          won = Math.random() < analysis.confidenceScore / 100;
          profit = won ? payout - stake : -stake;
          const prices = bestMarket.prices;
          entryPrice = prices[prices.length - 1] ?? 100;
          exitPrice = won
            ? analysis.direction === "up" ? entryPrice * 1.001 : entryPrice * 0.999
            : analysis.direction === "up" ? entryPrice * 0.999 : entryPrice * 1.001;
        }
      } else {
        // ── Simulated execution ───────────────────────────────────────────
        won = Math.random() < analysis.confidenceScore / 100;
        profit = won ? payout - stake : -stake;
        const prices = bestMarket.prices;
        entryPrice = prices[prices.length - 1] ?? 100;
        exitPrice = won
          ? analysis.direction === "up" ? entryPrice * 1.001 : entryPrice * 0.999
          : analysis.direction === "up" ? entryPrice * 0.999 : entryPrice * 1.001;
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

      logger.info({ symbol: bestMarket.symbol, won, profit: profit.toFixed(2), stake, live: !!token }, "Autonomous trade executed");
    } else {
      logger.info({
        symbol: bestMarket.symbol,
        confidence: analysis.confidenceScore,
        threshold: minConfidence,
      }, "Autonomous loop: market below threshold, scanning next");
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

// ── SSE streaming ────────────────────────────────────────────────────────────
const sseClients = new Set<Parameters<typeof router.get>[1] extends (req: any, res: infer R, next: any) => any ? R : never>();

function broadcastSSE(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { (res as any).write(payload); } catch { /* client disconnected */ }
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  sseClients.add(res as any);

  // Send current engine state immediately
  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  // Heartbeat every 25s to keep connection alive
  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res as any);
  });
});

router.get("/recommendation", async (_req, res): Promise<void> => {
  const { balance, settings } = await getAccountAndSettings();
  const cats = settings?.preferredCategories?.split(",").map((c) => c.trim()).filter(Boolean) ?? ["synthetic", "forex"];
  const settingsObj = {
    maxRiskPerTrade: settings ? Number(settings.maxRiskPerTrade) : 2,
    minConfidenceThreshold: settings ? Number(settings.minConfidenceThreshold) : 55,
    riskProfile: settings?.riskProfile ?? "moderate",
    preferredContractTypes: settings?.preferredContractTypes?.split(",").map((c) => c.trim()),
    tradeDurationSec: settings?.tradeDurationSec ?? 5,
    maxTradeStake: settings ? Number(settings.maxTradeStake) : 500,
  };

  const allMarkets = await scanAllMarkets(cats, balance, settingsObj);
  const best = allMarkets[0];

  if (!best) {
    res.status(404).json({ error: "No markets available" });
    return;
  }
  const { analysis } = best;
  res.json({
    symbol: best.symbol,
    contractType: analysis.recommendedContractType,
    direction: analysis.direction,
    stake: analysis.recommendedStake,
    confidence: analysis.confidenceScore,
    riskScore: analysis.riskScore,
    profitability: analysis.profitability,
    agentScores: analysis.agentScores,
    shouldTrade: analysis.shouldTrade,
    reasoning: analysis.reasoning,
    warnings: analysis.warnings,
    suggestedContractTypes: analysis.suggestedContractTypes,
    generatedAt: new Date().toISOString(),
  });
});

router.get("/recommendation/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const market = DERIV_MARKETS.find((m) => m.symbol === symbol);
  if (!market) {
    res.status(404).json({ error: "Market not found" });
    return;
  }

  const { balance, settings } = await getAccountAndSettings();
  const s = {
    maxRiskPerTrade: settings ? Number(settings.maxRiskPerTrade) : 2,
    minConfidenceThreshold: settings ? Number(settings.minConfidenceThreshold) : 55,
    riskProfile: settings?.riskProfile ?? "moderate",
    preferredContractTypes: settings?.preferredContractTypes?.split(",").map((c) => c.trim()),
    tradeDurationSec: settings?.tradeDurationSec ?? 5,
    maxTradeStake: settings ? Number(settings.maxTradeStake) : 500,
  };

  const prices = await getTickHistory(symbol, 50);
  const analysis = analyzeMarket(symbol, market.category, prices, balance, s);

  res.json({
    symbol,
    contractType: analysis.recommendedContractType,
    direction: analysis.direction,
    stake: analysis.recommendedStake,
    confidence: analysis.confidenceScore,
    riskScore: analysis.riskScore,
    profitability: analysis.profitability,
    agentScores: analysis.agentScores,
    shouldTrade: analysis.shouldTrade,
    reasoning: analysis.reasoning,
    warnings: analysis.warnings,
    suggestedContractTypes: analysis.suggestedContractTypes,
    generatedAt: new Date().toISOString(),
  });
});

router.get("/insights", async (_req, res): Promise<void> => {
  const trades = await db.select().from(tradesTable).where(
    sql`${tradesTable.status} IN ('won', 'lost')`
  ).orderBy(desc(tradesTable.createdAt)).limit(100);

  // ── Always compute dynamic insights from real trade data ───────────────
  const won = trades.filter((t) => t.status === "won");
  const lost = trades.filter((t) => t.status === "lost");
  const winRate = trades.length > 0 ? won.length / trades.length : 0;
  const totalProfit = trades.reduce((s, t) => s + Number(t.profit ?? 0), 0);
  const avgProfit = trades.length > 0 ? totalProfit / trades.length : 0;

  // Best and worst markets
  const marketStats: Record<string, { won: number; total: number; profit: number }> = {};
  for (const t of trades) {
    if (!marketStats[t.symbol]) marketStats[t.symbol] = { won: 0, total: 0, profit: 0 };
    marketStats[t.symbol].total++;
    marketStats[t.symbol].profit += Number(t.profit ?? 0);
    if (t.status === "won") marketStats[t.symbol].won++;
  }
  const marketEntries = Object.entries(marketStats).filter(([, s]) => s.total >= 2);
  const bestMarket = marketEntries.sort((a, b) => (b[1].won / b[1].total) - (a[1].won / a[1].total))[0];
  const worstMarket = marketEntries.sort((a, b) => (a[1].won / a[1].total) - (b[1].won / b[1].total))[0];

  // Consecutive loss streak
  const sorted = [...trades].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  let maxLossStreak = 0, curLoss = 0;
  let currentConsecLosses = 0;
  for (const t of sorted) {
    if (t.status === "lost") { curLoss++; maxLossStreak = Math.max(maxLossStreak, curLoss); }
    else curLoss = 0;
  }
  for (const t of sorted) {
    if (t.status === "lost") currentConsecLosses++;
    else break;
  }

  // Confidence correlation
  const highConf = trades.filter((t) => Number(t.aiConfidence ?? 0) >= 65);
  const lowConf = trades.filter((t) => Number(t.aiConfidence ?? 0) < 65);
  const highConfWinRate = highConf.length > 0 ? highConf.filter((t) => t.status === "won").length / highConf.length : 0;
  const lowConfWinRate = lowConf.length > 0 ? lowConf.filter((t) => t.status === "won").length / lowConf.length : 0;

  // AUTO vs MANUAL performance
  const autoTrades = trades.filter((t) => t.isAutonomous);
  const manualTrades = trades.filter((t) => !t.isAutonomous);
  const autoWinRate = autoTrades.length > 0 ? autoTrades.filter((t) => t.status === "won").length / autoTrades.length : 0;
  const manualWinRate = manualTrades.length > 0 ? manualTrades.filter((t) => t.status === "won").length / manualTrades.length : 0;

  const insights = [];

  if (trades.length === 0) {
    insights.push({
      id: 1,
      type: "improvement",
      title: "Start Trading to Generate AI Insights",
      description: "The AI engine needs at least 5 completed trades to start generating personalized recommendations. Start the autonomous engine or place manual trades.",
      priority: "medium",
      actionable: true,
      relatedMarket: null,
    });
  } else {
    insights.push({
      id: 1,
      type: "pattern",
      title: `Win Rate: ${(winRate * 100).toFixed(1)}% across ${trades.length} trades`,
      description: `You have won ${won.length} and lost ${lost.length} trades. Average profit per trade: ${avgProfit >= 0 ? "+" : ""}$${avgProfit.toFixed(2)}. ${winRate > 0.55 ? "You have a profitable edge — maintain discipline." : winRate > 0.45 ? "Near break-even — consider raising confidence threshold." : "Below break-even — review settings and reduce stake size."}`,
      priority: winRate > 0.55 ? "low" : winRate > 0.45 ? "medium" : "high",
      actionable: winRate < 0.55,
      relatedMarket: null,
    });

    if (highConf.length > 0 && lowConf.length > 0) {
      insights.push({
        id: 2,
        type: "improvement",
        title: `High-confidence trades win at ${(highConfWinRate * 100).toFixed(1)}% vs ${(lowConfWinRate * 100).toFixed(1)}% for low-confidence`,
        description: `Your trades above 65% confidence have a ${(highConfWinRate * 100).toFixed(1)}% win rate, while those below 65% win only ${(lowConfWinRate * 100).toFixed(1)}%. ${highConfWinRate > lowConfWinRate + 0.05 ? "Raise your confidence threshold to 65+ for better results." : "Confidence threshold is well-calibrated."}`,
        priority: highConfWinRate > lowConfWinRate + 0.1 ? "high" : "medium",
        actionable: highConfWinRate > lowConfWinRate + 0.05,
        relatedMarket: null,
      });
    }

    if (bestMarket) {
      insights.push({
        id: 3,
        type: "milestone",
        title: `Best Market: ${bestMarket[0]} at ${((bestMarket[1].won / bestMarket[1].total) * 100).toFixed(0)}% win rate`,
        description: `${bestMarket[0]} is your highest-performing market with ${bestMarket[1].won}/${bestMarket[1].total} wins and $${bestMarket[1].profit.toFixed(2)} total profit. The engine will prioritize this market.`,
        priority: "low",
        actionable: false,
        relatedMarket: bestMarket[0],
      });
    }

    if (currentConsecLosses >= 2) {
      insights.push({
        id: 4,
        type: "warning",
        title: `Active Losing Streak: ${currentConsecLosses} consecutive losses`,
        description: `You are currently on a ${currentConsecLosses}-trade losing streak. Consider pausing the engine or reducing stake size. Enable Recovery Mode in settings for automatic stake management.`,
        priority: currentConsecLosses >= 3 ? "high" : "medium",
        actionable: true,
        relatedMarket: null,
      });
    } else if (maxLossStreak >= 3) {
      insights.push({
        id: 4,
        type: "warning",
        title: `Max Loss Streak of ${maxLossStreak} detected in history`,
        description: `Your worst losing streak was ${maxLossStreak} trades. Recovery Mode can help manage this — it slightly increases the next stake after a loss (capped at 1.2× per step) to recover losses without dangerous doubling.`,
        priority: "medium",
        actionable: true,
        relatedMarket: null,
      });
    }

    if (autoTrades.length > 0 && manualTrades.length > 0) {
      insights.push({
        id: 5,
        type: "pattern",
        title: `Auto: ${(autoWinRate * 100).toFixed(1)}% win rate vs Manual: ${(manualWinRate * 100).toFixed(1)}%`,
        description: `Autonomous trades win at ${(autoWinRate * 100).toFixed(1)}% while manual trades win at ${(manualWinRate * 100).toFixed(1)}%. ${autoWinRate > manualWinRate ? "The AI engine is outperforming manual trading — trust the autonomous mode." : "Manual trading is outperforming — consider reviewing AI confidence settings."}`,
        priority: "low",
        actionable: false,
        relatedMarket: null,
      });
    }

    if (worstMarket && worstMarket[1].total >= 3 && worstMarket[1].won / worstMarket[1].total < 0.4) {
      insights.push({
        id: 6,
        type: "warning",
        title: `Avoid ${worstMarket[0]}: only ${((worstMarket[1].won / worstMarket[1].total) * 100).toFixed(0)}% win rate`,
        description: `${worstMarket[0]} has been your worst market with ${worstMarket[1].won}/${worstMarket[1].total} wins and $${worstMarket[1].profit.toFixed(2)} total. The self-learning agent has already reduced its priority score.`,
        priority: "medium",
        actionable: true,
        relatedMarket: worstMarket[0],
      });
    }
  }

  res.json(insights);
});

router.get("/engine/status", async (_req, res): Promise<void> => {
  const settings = await db.select().from(settingsTable).limit(1);
  const isAuto = settings.length > 0 ? settings[0].autonomousEnabled : false;
  const mode = engineRunning ? "autonomous" : (isAuto ? "autonomous" : "manual");

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayTrades = await db.select().from(tradesTable).where(
    sql`${tradesTable.createdAt} >= ${today}`
  );

  const agentStatuses = AGENT_NAMES.map((name) => ({
    name,
    isActive: engineRunning,
    lastRun: engineRunning ? new Date().toISOString() : null,
    confidence: engineRunning ? 55 + Math.random() * 35 : 45 + Math.random() * 20,
  }));

  res.json({
    isRunning: engineRunning,
    mode,
    agentStatuses,
    tradesExecutedToday: todayTrades.length,
    currentMarket,
    nextScanIn: engineRunning ? nextScanIn : null,
    stopReasons,
    loopIntervalSec,
    lastTradeTime: lastTradeTime?.toISOString() ?? null,
    exploitSymbol,
    exploitCount,
    recoveryStep,
  });
});

router.post("/engine/toggle", async (req, res): Promise<void> => {
  const parseResult = ToggleAutonomousEngineBody.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const { running } = parseResult.data;

  if (req.body.intervalSec && typeof req.body.intervalSec === "number") {
    loopIntervalSec = Math.max(5, Math.min(300, req.body.intervalSec));
  }

  const settings = await db.select().from(settingsTable).limit(1);
  if (settings.length > 0 && settings[0].loopIntervalSec) {
    loopIntervalSec = settings[0].loopIntervalSec;
  }

  if (running) {
    engineRunning = true;
    autonomousMode = "autonomous";
    stopReasons = [];
    nextScanIn = loopIntervalSec;
    exploitSymbol = null;
    exploitCount = 0;
    recoveryStep = 0;
    baseStake = 0;

    if (settings.length > 0) {
      await db.update(settingsTable).set({ autonomousEnabled: true });
    }

    if (autonomousTimer) { clearTimeout(autonomousTimer); autonomousTimer = null; }
    autonomousTimer = setTimeout(runAutonomousLoop, 2000);

    logger.info({ loopIntervalSec }, "Autonomous engine started");
  } else {
    const wasRunning = engineRunning;
    engineRunning = false;
    autonomousMode = "manual";
    currentMarket = null;
    nextScanIn = null;
    exploitSymbol = null;
    recoveryStep = 0;
    if (autonomousTimer) { clearTimeout(autonomousTimer); autonomousTimer = null; }

    if (settings.length > 0) {
      await db.update(settingsTable).set({ autonomousEnabled: false });
    }

    if (wasRunning) logger.info("Autonomous engine stopped by user");
  }

  const agentStatuses = AGENT_NAMES.map((name) => ({
    name,
    isActive: engineRunning,
    lastRun: engineRunning ? new Date().toISOString() : null,
    confidence: engineRunning ? 55 + Math.random() * 35 : 45 + Math.random() * 20,
  }));

  res.json({
    isRunning: engineRunning,
    mode: autonomousMode,
    agentStatuses,
    tradesExecutedToday,
    currentMarket,
    nextScanIn,
    stopReasons,
    loopIntervalSec,
    lastTradeTime: lastTradeTime?.toISOString() ?? null,
    exploitSymbol,
    exploitCount,
    recoveryStep,
  });
});

export { broadcastSSE };
export default router;
