import { Router } from "express";
import { db } from "@workspace/db";
import { aiInsightsTable, tradesTable, settingsTable, accountsTable } from "@workspace/db";
import { sql, desc } from "drizzle-orm";
import { analyzeMarket, updateSelfLearning, getMarketWinRate } from "../lib/ai-engine";
import { tickManager, DERIV_MARKETS, executeLiveTrade, waitForContractResult, getLiveBalance, getCachedToken, getMarketInfo } from "../lib/deriv";
import { finalizeAnalysis, logTradeFeatures, shouldExecuteTrade } from "../lib/trade-helpers";
import { loadCalibrationCache } from "../lib/calibration";
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

// Recovery cross-learning state
let lastLossContractType: string | null = null;
let lastLossBarrier: number | null = null;
let lastLossSymbol: string | null = null;
let lastLossAmount = 0;

// Real-time agent confidence scores (updated each scan)
let lastAgentScores: Record<string, number> = {};

const AGENT_NAMES = [
  "Market Scanner", "Trend Analysis", "Volatility Analysis", "Pattern Recognition",
  "Risk Management", "Capital Preservation", "Trade Execution", "Self-Learning Performance",
];

const AGENT_SCORE_KEYS = [
  "marketScanner", "trendAnalysis", "volatilityAnalysis", "patternRecognition",
  "riskManagement", "capitalPreservation", "tradeExecution", "selfLearning",
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
  lastLossContractType = null;
  lastLossBarrier = null;
  lastLossSymbol = null;
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

// ── Recovery stake calculation ────────────────────────────────────────────────
function calcRecoveryStake(lossAmount: number, payoutMultiplier: number, baseAmount: number, maxStake: number): number {
  if (lossAmount <= 0) return baseAmount;
  // Stake needed to recover the loss + small profit margin
  const needed = lossAmount / (payoutMultiplier - 1) * 1.1;
  return Math.min(Math.max(needed, baseAmount), maxStake);
}

// ── Alternative contract type for cross-recovery ──────────────────────────────
function getAlternativeContractType(
  lostContractType: string,
  lostBarrier: number | null,
  preferredTypes: string[],
): { contractType: string; barrier?: number } {
  const isDigit = lostContractType.includes("DIGIT");

  if (isDigit) {
    // Lost on DIGITOVER/UNDER → try RISE/FALL or opposite digit with different barrier
    if (preferredTypes.some(p => ["RISE", "FALL", "CALL", "PUT"].includes(p))) {
      return { contractType: "RISE" };
    }
    // Flip to opposite digit direction with adjusted barrier
    if (lostContractType === "DIGITOVER") {
      const altBarrier = lostBarrier !== null ? Math.min(9, lostBarrier + 2) : 5;
      return { contractType: "DIGITUNDER", barrier: altBarrier };
    }
    const altBarrier = lostBarrier !== null ? Math.max(0, lostBarrier - 2) : 3;
    return { contractType: "DIGITOVER", barrier: altBarrier };
  }

  // Lost on RISE/FALL/CALL/PUT → try digits if allowed, else opposite direction
  if (preferredTypes.some(p => p.startsWith("DIGIT"))) {
    return { contractType: "DIGITOVER", barrier: 2 };
  }
  if (lostContractType === "RISE") return { contractType: "FALL" };
  if (lostContractType === "FALL") return { contractType: "RISE" };
  if (lostContractType === "CALL") return { contractType: "PUT" };
  return { contractType: "CALL" };
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
    const paperTradeMode = (settings as any)?.paperTradeMode ?? false;
    const requirePositiveEv = (settings as any)?.requirePositiveEv ?? true;

    // Market filter: allowed markets from settings
    const allowedMarketSymbols: string[] | null =
      (settings as any)?.allowedMarkets
        ? ((settings as any).allowedMarkets as string).split(",").filter(Boolean)
        : null;
    const availableMarkets = allowedMarketSymbols && allowedMarketSymbols.length > 0
      ? DERIV_MARKETS.filter(m => allowedMarketSymbols.includes(m.symbol))
      : DERIV_MARKETS;

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

    // Track recovery state
    const lastWasLoss = sorted[0]?.status === "lost";
    if (lastWasLoss && recoveryModeEnabled) {
      recoveryStep = Math.min(recoveryStep + 1, maxRecoverySteps);
      if (sorted[0]) {
        lastLossContractType = sorted[0].contractType;
        lastLossBarrier = (sorted[0] as any).barrier ?? null;
        lastLossSymbol = sorted[0].symbol;
        lastLossAmount = Math.abs(Number(sorted[0].profit ?? 0));
      }
    } else if (!lastWasLoss) {
      recoveryStep = 0;
      lastLossContractType = null;
      lastLossBarrier = null;
      lastLossSymbol = null;
      lastLossAmount = 0;
    }

    const settingsObj = {
      maxRiskPerTrade: settings ? Number(settings.maxRiskPerTrade) : 2,
      minConfidenceThreshold: minConfidence,
      riskProfile: settings?.riskProfile ?? "moderate",
      preferredContractTypes,
      tradeDurationSec,
      maxTradeStake,
    };

    // ── Market selection ─────────────────────────────────────────────────────
    let bestMarket: {
      symbol: string; category: string; displayName: string; digitEnabled?: boolean;
      analysis: ReturnType<typeof analyzeMarket>; prices: number[];
    } | null = null;

    // Exploit mode: keep trading hot market unless quality drops
    if (exploitSymbol && exploitCount < marketRotationAfter && availableMarkets.some(m => m.symbol === exploitSymbol)) {
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
      // Parallel scan all allowed markets — near-zero latency (in-memory tick buffers)
      const scanResults = await Promise.all(
        availableMarkets.map(async (m) => {
          const prices = tickManager.getTicks(m.symbol, 100);
          const digits = m.digitEnabled ? tickManager.getDigits(m.symbol, 300) : undefined;
          const analysis = analyzeMarket(m.symbol, m.category, prices, balance, settingsObj, digits);
          return { ...m, analysis, prices };
        })
      );

      // In recovery mode, also score by win rate for alternative contract types
      if (recoveryModeEnabled && recoveryStep > 0 && lastLossContractType) {
        const alt = getAlternativeContractType(lastLossContractType, lastLossBarrier, preferredContractTypes);
        // Boost markets that have a good win rate for the alternative contract type
        scanResults.sort((a, b) => {
          const aWr = getMarketWinRate(a.symbol, alt.contractType);
          const bWr = getMarketWinRate(b.symbol, alt.contractType);
          const aScore = b.analysis.qualityScore * 0.7 + aWr * 30;
          const bScore = b.analysis.qualityScore * 0.7 + bWr * 30;
          return bScore - aScore;
        });
      } else {
        scanResults.sort((a, b) => b.analysis.qualityScore - a.analysis.qualityScore);
      }

      const top = scanResults[0];
      if (top && top.analysis.confidenceScore >= minConfidence) {
        bestMarket = top;
        exploitSymbol = top.symbol;
        exploitQualityThreshold = top.analysis.qualityScore;
        exploitCount = 1;
      } else if (top) {
        bestMarket = top;
      }
    }

    if (!bestMarket) { scheduleNext(); return; }

    currentMarket = bestMarket.symbol;

    // Update agent scores from this scan
    const scores = bestMarket.analysis.agentScores;
    lastAgentScores = {
      marketScanner: scores.marketScanner.score,
      trendAnalysis: scores.trendAnalysis.score,
      volatilityAnalysis: scores.volatilityAnalysis.score,
      patternRecognition: scores.patternRecognition.score,
      riskManagement: scores.riskManagement.score,
      capitalPreservation: scores.capitalPreservation.score,
      tradeExecution: scores.tradeExecution.score,
      selfLearning: scores.selfLearning.score,
    };

    broadcastSSE("scan_complete", {
      symbol: bestMarket.symbol,
      quality: bestMarket.analysis.qualityScore,
      confidence: bestMarket.analysis.confidenceScore,
      agentScores: lastAgentScores,
      marketsScanned: availableMarkets.length,
    });

    const { analysis: rawAnalysis } = bestMarket;
    const duration = rawAnalysis.recommendedDuration ?? tradeDurationSec;

    // In recovery mode, try alternative contract type
    let effectiveContractType = rawAnalysis.recommendedContractType;
    let effectiveBarrier = rawAnalysis.digitBarrier;

    if (recoveryModeEnabled && recoveryStep > 0 && lastLossContractType) {
      const alt = getAlternativeContractType(lastLossContractType, lastLossBarrier, preferredContractTypes);
      effectiveContractType = alt.contractType;
      if (alt.barrier !== undefined) effectiveBarrier = alt.barrier;
      logger.info({ recovery: true, from: lastLossContractType, to: effectiveContractType, barrier: effectiveBarrier }, "Recovery: switching contract type");
    }

    const analysis = await finalizeAnalysis(rawAnalysis, {
      symbol: bestMarket.symbol,
      currency: account?.currency ?? "USD",
      token,
      defaultDuration: duration,
      barrier: effectiveBarrier,
      skipProposal: paperTradeMode || !token,
    });

    logger.info({
      symbol: bestMarket.symbol,
      confidence: analysis.confidenceScore,
      calibrated: analysis.calibratedConfidence,
      ev: analysis.expectedValue,
      quality: analysis.qualityScore,
      contract: effectiveContractType,
      shouldTrade: analysis.shouldTrade,
      recovery: recoveryStep > 0,
    }, "Autonomous scan");

    const tradeGate = shouldExecuteTrade(analysis, {
      minConfidence: minConfidence,
      requirePositiveEv,
    });

    if (!tradeGate.execute) {
      logger.info({ reason: tradeGate.reason }, "Trade skipped");
      scheduleNext();
      return;
    }

    // ── Trade execution ──────────────────────────────────────────────────────
    {
      let stake = analysis.recommendedStake;
      if (baseStake === 0) baseStake = stake;

      // Recovery stake calculation: enough to cover lost amount + margin
      if (recoveryModeEnabled && recoveryStep > 0 && lastLossAmount > 0) {
        stake = calcRecoveryStake(lastLossAmount, analysis.payoutMultiplier, baseStake, maxTradeStake);
        logger.info({ recoveryStake: stake, lossAmount: lastLossAmount, step: recoveryStep }, "Recovery stake calculated");
      } else {
        stake = Math.min(stake, maxTradeStake);
      }

      let won: boolean, profit: number, entryPrice: number, exitPrice: number;
      const payout = stake * analysis.payoutMultiplier;

      if (paperTradeMode || !token) {
        const winProb = analysis.winProbability / 100;
        won = Math.random() < winProb;
        profit = won ? payout - stake : -stake;
        entryPrice = bestMarket.prices[bestMarket.prices.length - 1] ?? 100;
        exitPrice = entryPrice;
        logger.info({ symbol: bestMarket.symbol, paper: true, won, ev: analysis.expectedValue }, "Paper trade logged");
      } else {
        try {
          const liveResult = await executeLiveTrade(token, {
            symbol: bestMarket.symbol,
            contractType: effectiveContractType,
            stake,
            duration,
            durationUnit: "t",
            currency: account?.currency ?? "USD",
            barrier: effectiveContractType.includes("DIGIT") ? effectiveBarrier : undefined,
          });
          entryPrice = liveResult.buyPrice;
          const contractResult = await waitForContractResult(token, liveResult.contractId, (duration + 5) * 1000);
          won = contractResult.won;
          profit = contractResult.profit;
          exitPrice = contractResult.exitSpot;
          await syncLiveBalance(token);
        } catch (liveErr) {
          logger.warn({ liveErr }, "Live trade failed — skipping");
          scheduleNext();
          return;
        }
      }

      await updateSelfLearning(bestMarket.symbol, effectiveContractType, effectiveBarrier, won);

      const barrierToStore = effectiveContractType.includes("DIGIT") ? (effectiveBarrier ?? null) : null;

      const [trade] = await db.insert(tradesTable).values({
        symbol: bestMarket.symbol,
        displayName: bestMarket.displayName,
        contractType: effectiveContractType,
        barrier: barrierToStore,
        stake: String(stake),
        direction: analysis.direction,
        status: won ? "won" : "lost",
        payout: String(payout),
        profit: String(profit),
        entryPrice: String(entryPrice),
        exitPrice: String(exitPrice),
        aiConfidence: String(analysis.calibratedConfidence),
        aiRiskScore: String(analysis.riskScore),
        isAutonomous: true,
        agentReasoning: `${paperTradeMode ? "[PAPER] " : ""}${recoveryStep > 0 ? `[RECOVERY×${recoveryStep}] ` : ""}${analysis.reasoning} EV=$${analysis.expectedValue.toFixed(2)}`,
        duration,
        durationUnit: "t",
        closedAt: new Date(),
      }).returning();

      await logTradeFeatures(trade.id, analysis, {
        symbol: bestMarket.symbol,
        barrier: barrierToStore,
        tickWindow: analysis.tickWindow,
        duration,
        featuresJson: { mlModels: analysis.mlModels, winProbability: analysis.winProbability, recoveryStep },
        isPaperTrade: paperTradeMode,
      });

      tradesExecutedToday++;
      lastTradeTime = new Date();

      broadcastSSE("trade_completed", {
        symbol: bestMarket.symbol, won, profit: profit.toFixed(2),
        contract: effectiveContractType,
        barrier: barrierToStore,
        stake,
        live: !!token && !paperTradeMode, paper: paperTradeMode, ev: analysis.expectedValue,
        recoveryStep,
      });
      logger.info({ symbol: bestMarket.symbol, won, profit: profit.toFixed(2), stake, ev: analysis.expectedValue, recovery: recoveryStep > 0 }, "Trade executed");
    }
  } catch (err) {
    logger.error({ err }, "Autonomous loop error");
  }

  scheduleNext();
}

function formatRecommendation(symbol: string, analysis: Awaited<ReturnType<typeof finalizeAnalysis>>) {
  return {
    symbol,
    contractType: analysis.recommendedContractType,
    direction: analysis.direction,
    stake: analysis.recommendedStake,
    confidence: analysis.confidenceScore,
    calibratedConfidence: analysis.calibratedConfidence,
    winProbability: analysis.winProbability,
    expectedValue: analysis.expectedValue,
    breakevenWinRate: analysis.breakevenWinRate,
    payoutMultiplier: analysis.payoutMultiplier,
    recommendedDuration: analysis.recommendedDuration,
    tickWindow: analysis.tickWindow ?? null,
    riskScore: analysis.riskScore,
    profitability: analysis.profitability,
    agentScores: analysis.agentScores,
    shouldTrade: analysis.shouldTrade,
    reasoning: analysis.reasoning,
    warnings: analysis.warnings,
    suggestedContractTypes: analysis.suggestedContractTypes,
    digitStats: analysis.digitStats ?? null,
    digitBarrier: analysis.digitBarrier ?? null,
    generatedAt: new Date().toISOString(),
  };
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
  const { balance, settings, account } = await getAccountAndSettings();
  const token = getCachedToken() ?? account?.token ?? null;
  const settingsObj = {
    maxRiskPerTrade: settings ? Number(settings.maxRiskPerTrade) : 2,
    minConfidenceThreshold: settings ? Number(settings.minConfidenceThreshold) : 55,
    riskProfile: settings?.riskProfile ?? "moderate",
    preferredContractTypes: settings?.preferredContractTypes?.split(",").filter(Boolean),
    tradeDurationSec: settings?.tradeDurationSec ?? 5,
    maxTradeStake: settings ? Number(settings.maxTradeStake) : 500,
  };

  const allowedSymbols = (settings as any)?.allowedMarkets
    ? ((settings as any).allowedMarkets as string).split(",").filter(Boolean)
    : null;
  const marketsToScan = allowedSymbols && allowedSymbols.length > 0
    ? DERIV_MARKETS.filter(m => allowedSymbols.includes(m.symbol))
    : DERIV_MARKETS;

  const results = await Promise.all(
    marketsToScan.map(async (m) => {
      const prices = tickManager.getTicks(m.symbol, 100);
      const digits = m.digitEnabled ? tickManager.getDigits(m.symbol, 300) : undefined;
      const raw = analyzeMarket(m.symbol, m.category, prices, balance, settingsObj, digits);
      const analysis = await finalizeAnalysis(raw, {
        symbol: m.symbol,
        currency: account?.currency ?? "USD",
        token,
        defaultDuration: raw.recommendedDuration ?? settingsObj.tradeDurationSec ?? 5,
        barrier: raw.digitBarrier,
        skipProposal: !token,
      });
      return { ...m, analysis, prices };
    })
  );

  results.sort((a, b) => b.analysis.expectedValue - a.analysis.expectedValue);
  const best = results[0];
  if (!best) { res.status(404).json({ error: "No markets available" }); return; }

  res.json(formatRecommendation(best.symbol, best.analysis));
});

router.get("/recommendation/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const market = getMarketInfo(symbol);
  if (!market) { res.status(404).json({ error: "Market not found" }); return; }

  const { balance, settings, account } = await getAccountAndSettings();
  const token = getCachedToken() ?? account?.token ?? null;
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
  const raw = analyzeMarket(symbol, market.category, prices, balance, s, digits);
  const analysis = await finalizeAnalysis(raw, {
    symbol,
    currency: account?.currency ?? "USD",
    token,
    defaultDuration: raw.recommendedDuration ?? s.tradeDurationSec ?? 5,
    barrier: raw.digitBarrier,
    skipProposal: !token,
  });

  res.json(formatRecommendation(symbol, analysis));
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
      insights.push({ id: 4, type: "warning", title: `⚠ Active losing streak: ${currentConsecLosses} consecutive losses`, description: `Consider pausing the engine. Recovery Mode is ${currentConsecLosses >= 3 ? "strongly " : ""}recommended to manage stake sizing automatically. Engine will switch to alternative contract types on recovery.`, priority: currentConsecLosses >= 3 ? "high" : "medium", actionable: true, relatedMarket: null });
    }

    if (highConf.length > 3 && lowConf.length > 3) {
      insights.push({ id: 5, type: "improvement", title: `High-confidence trades: ${(highConfWinRate * 100).toFixed(1)}% vs low-confidence: ${(lowConfWinRate * 100).toFixed(1)}%`, description: highConfWinRate > lowConfWinRate + 0.05 ? "Raise confidence threshold to 65+ for significantly better results." : "Your confidence threshold is well-calibrated.", priority: highConfWinRate > lowConfWinRate + 0.1 ? "high" : "low", actionable: highConfWinRate > lowConfWinRate + 0.05, relatedMarket: null });
    }

    if (worstMarket && worstMarket[1].total >= 3 && worstMarket[1].won / worstMarket[1].total < 0.4) {
      insights.push({ id: 6, type: "warning", title: `Avoid ${worstMarket[0]}: ${((worstMarket[1].won / worstMarket[1].total) * 100).toFixed(0)}% win rate`, description: `Only ${worstMarket[1].won}/${worstMarket[1].total} wins. Consider removing it from your allowed markets in Settings.`, priority: "medium", actionable: true, relatedMarket: worstMarket[0] });
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
    agentStatuses: AGENT_NAMES.map((name, i) => {
      const key = AGENT_SCORE_KEYS[i] ?? "marketScanner";
      const score = lastAgentScores[key] ?? (engineRunning ? 68 : 50);
      return {
        name, isActive: engineRunning, lastRun: engineRunning ? new Date().toISOString() : null,
        confidence: score,
      };
    }),
    tradesExecutedToday: todayTrades.length,
    currentMarket, nextScanIn: engineRunning ? nextScanIn : null, stopReasons, loopIntervalSec,
    lastTradeTime: lastTradeTime?.toISOString() ?? null, exploitSymbol, exploitCount, recoveryStep,
    wsConnected: tickManager.getConnectionStatus(),
    liveTickCount: tickManager.getLiveTickCount(),
    tickHealth: tickManager.getTickHealth(),
    paperTradeMode: settings.length > 0 ? (settings[0] as { paperTradeMode?: boolean }).paperTradeMode ?? false : false,
    requirePositiveEv: settings.length > 0 ? (settings[0] as { requirePositiveEv?: boolean }).requirePositiveEv ?? true : true,
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
    lastLossContractType = null; lastLossBarrier = null; lastLossSymbol = null; lastLossAmount = 0;
    if (settings.length > 0) await db.update(settingsTable).set({ autonomousEnabled: true });
    if (autonomousTimer) { clearTimeout(autonomousTimer); autonomousTimer = null; }
    autonomousTimer = setTimeout(runAutonomousLoop, 2000);
    logger.info({ loopIntervalSec }, "Autonomous engine started");
  } else {
    engineRunning = false; autonomousMode = "manual"; currentMarket = null; nextScanIn = null;
    exploitSymbol = null; recoveryStep = 0;
    lastAgentScores = {};
    if (autonomousTimer) { clearTimeout(autonomousTimer); autonomousTimer = null; }
    if (settings.length > 0) await db.update(settingsTable).set({ autonomousEnabled: false });
  }

  res.json({
    isRunning: engineRunning, mode: autonomousMode,
    agentStatuses: AGENT_NAMES.map((name, i) => {
      const key = AGENT_SCORE_KEYS[i] ?? "marketScanner";
      const score = lastAgentScores[key] ?? (engineRunning ? 68 : 50);
      return {
        name, isActive: engineRunning, lastRun: engineRunning ? new Date().toISOString() : null,
        confidence: score,
      };
    }),
    tradesExecutedToday, currentMarket, nextScanIn, stopReasons, loopIntervalSec,
    lastTradeTime: lastTradeTime?.toISOString() ?? null, exploitSymbol, exploitCount, recoveryStep,
    wsConnected: tickManager.getConnectionStatus(),
    liveTickCount: tickManager.getLiveTickCount(),
    tickHealth: tickManager.getTickHealth(),
    paperTradeMode: settings.length > 0 ? (settings[0] as { paperTradeMode?: boolean }).paperTradeMode ?? false : false,
    requirePositiveEv: settings.length > 0 ? (settings[0] as { requirePositiveEv?: boolean }).requirePositiveEv ?? true : true,
  });
});

export default router;
