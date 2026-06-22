import { Router } from "express";
import { db } from "@workspace/db";
import { accountsTable, settingsTable } from "@workspace/db";
import { analyzeMarket } from "../lib/ai-engine";
import { tickManager, DERIV_MARKETS, getMarketInfo } from "../lib/deriv";
import { GetMarketsQueryParams } from "@workspace/api-zod";

const router = Router();

interface CachedAnalysis {
  symbol: string;
  displayName: string;
  category: string;
  analysis: ReturnType<typeof analyzeMarket>;
  prices: number[];
  lastUpdated: Date;
}

const analysisCache = new Map<string, CachedAnalysis>();
let isScanning = false;

async function getAccountAndSettings() {
  const accounts = await db.select().from(accountsTable).limit(1);
  const settings = await db.select().from(settingsTable).limit(1);
  const balance = accounts.length > 0 ? Number(accounts[0].balance) : 10000;
  const s = settings.length > 0 ? settings[0] : null;
  return {
    balance,
    settings: {
      maxRiskPerTrade: s ? Number(s.maxRiskPerTrade) : 2,
      minConfidenceThreshold: s ? Number(s.minConfidenceThreshold) : 55,
      riskProfile: s?.riskProfile ?? "moderate",
      preferredContractTypes: s?.preferredContractTypes?.split(",").filter(Boolean),
      tradeDurationSec: s?.tradeDurationSec ?? 5,
      maxTradeStake: s ? Number(s.maxTradeStake) : 500,
    },
  };
}

async function analyzeAllMarkets() {
  if (isScanning) return;
  isScanning = true;
  try {
    const { balance, settings } = await getAccountAndSettings();
    const now = new Date();

    // Only re-analyze markets that are stale (> 15 seconds old)
    const staleMarkets = DERIV_MARKETS.filter((m) => {
      const cached = analysisCache.get(m.symbol);
      return !cached || (now.getTime() - cached.lastUpdated.getTime()) > 15000;
    });

    // All in parallel using live tick data from TickManager (no latency)
    await Promise.all(staleMarkets.map(async (market) => {
      try {
        const prices = tickManager.getTicks(market.symbol, 100);
        const digits = market.digitEnabled ? tickManager.getDigits(market.symbol, 200) : undefined;
        const analysis = analyzeMarket(market.symbol, market.category, prices, balance, settings, digits);
        analysisCache.set(market.symbol, {
          symbol: market.symbol,
          displayName: market.displayName,
          category: market.category,
          analysis,
          prices,
          lastUpdated: new Date(),
        });
      } catch { /* skip */ }
    }));
  } finally {
    isScanning = false;
  }
}

// Warm up cache on startup
analyzeAllMarkets().catch(() => {});

router.get("/", async (req, res): Promise<void> => {
  const parseResult = GetMarketsQueryParams.safeParse(req.query);
  const params = parseResult.success ? parseResult.data : {} as { category?: string; limit?: number };
  const limit = params.limit ?? 50;

  analyzeAllMarkets().catch(() => {});

  const { balance, settings } = await getAccountAndSettings();

  const ranked = await Promise.all(
    DERIV_MARKETS.slice(0, limit).map(async (m) => {
      let cached = analysisCache.get(m.symbol);
      if (!cached) {
        const prices = tickManager.getTicks(m.symbol, 50);
        const digits = m.digitEnabled ? tickManager.getDigits(m.symbol, 100) : undefined;
        const analysis = analyzeMarket(m.symbol, m.category, prices, balance, settings, digits);
        cached = { symbol: m.symbol, displayName: m.displayName, category: m.category, analysis, prices, lastUpdated: new Date() };
        analysisCache.set(m.symbol, cached);
      }
      const { analysis, prices } = cached;
      return {
        symbol: m.symbol,
        displayName: m.displayName,
        category: m.category,
        qualityScore: analysis.qualityScore,
        confidenceScore: analysis.confidenceScore,
        riskScore: analysis.riskScore,
        trend: analysis.trend,
        volatility: analysis.volatility,
        recommendedContractType: analysis.recommendedContractType,
        lastPrice: tickManager.getLatestPrice(m.symbol) ?? prices[prices.length - 1] ?? null,
        priceChange24h: prices.length > 1 ? ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100 : null,
        rank: 0,
      };
    })
  );

  ranked.sort((a, b) => b.qualityScore - a.qualityScore);
  ranked.forEach((m, i) => { m.rank = i + 1; });

  res.json(ranked);
});

router.get("/top", async (_req, res): Promise<void> => {
  analyzeAllMarkets().catch(() => {});
  const { balance, settings } = await getAccountAndSettings();

  let best: CachedAnalysis | null = null;
  for (const [, cached] of analysisCache) {
    if (!best || cached.analysis.qualityScore > best.analysis.qualityScore) best = cached;
  }

  if (!best) {
    const market = DERIV_MARKETS[0];
    const prices = tickManager.getTicks(market.symbol, 50);
    const digits = market.digitEnabled ? tickManager.getDigits(market.symbol, 100) : undefined;
    const analysis = analyzeMarket(market.symbol, market.category, prices, balance, settings, digits);
    best = { symbol: market.symbol, displayName: market.displayName, category: market.category, analysis, prices, lastUpdated: new Date() };
    analysisCache.set(market.symbol, best);
  }

  res.json(buildMarketDetail(best.symbol, best.displayName, best.category, best.analysis, best.prices));
});

router.get("/scan", async (_req, res): Promise<void> => {
  res.json({
    status: isScanning ? "running" : "queued",
    marketsScanned: analysisCache.size,
    liveTickCount: tickManager.getLiveTickCount(),
    connected: tickManager.getConnectionStatus(),
    startedAt: new Date().toISOString(),
  });
});

router.post("/scan", async (_req, res): Promise<void> => {
  analyzeAllMarkets().catch(() => {});
  res.json({ status: "running", marketsScanned: analysisCache.size, startedAt: new Date().toISOString() });
});

router.get("/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const market = getMarketInfo(symbol);
  if (!market) {
    res.status(404).json({ error: "Market not found" });
    return;
  }

  const { balance, settings } = await getAccountAndSettings();
  const prices = tickManager.getTicks(symbol, 100);
  const digits = market.digitEnabled ? tickManager.getDigits(symbol, 300) : undefined;
  const analysis = analyzeMarket(symbol, market.category, prices, balance, settings, digits);
  analysisCache.set(symbol, { symbol, displayName: market.displayName, category: market.category, analysis, prices, lastUpdated: new Date() });

  res.json(buildMarketDetail(symbol, market.displayName, market.category, analysis, prices));
});

function buildMarketDetail(symbol: string, displayName: string, category: string, analysis: ReturnType<typeof analyzeMarket>, prices: number[]) {
  const now = new Date();
  const priceHistory = prices.slice(-60).map((p, i) => ({
    timestamp: new Date(now.getTime() - (59 - i) * 1000).toISOString(),
    price: p,
  }));

  return {
    symbol,
    displayName,
    category,
    qualityScore: analysis.qualityScore,
    agentScores: analysis.agentScores,
    digitStats: analysis.digitStats ?? null,
    digitBarrier: analysis.digitBarrier ?? null,
    recommendation: {
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
    },
    priceHistory,
    lastUpdated: new Date().toISOString(),
  };
}

export { analysisCache, getAccountAndSettings };
export default router;
