import { Router } from "express";
import { db } from "@workspace/db";
import { accountsTable, settingsTable } from "@workspace/db";
import { analyzeMarket } from "../lib/ai-engine";
import { getTickHistory, DERIV_MARKETS } from "../lib/deriv";
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
let lastScanTime: Date | null = null;
let isScanning = false;

async function getAccountAndSettings() {
  const accounts = await db.select().from(accountsTable).limit(1);
  const settings = await db.select().from(settingsTable).limit(1);
  const balance = accounts.length > 0 ? Number(accounts[0].balance) : 10000;
  const settingsData = settings.length > 0 ? settings[0] : null;
  return {
    balance,
    settings: {
      maxRiskPerTrade: settingsData ? Number(settingsData.maxRiskPerTrade) : 2,
      minConfidenceThreshold: settingsData ? Number(settingsData.minConfidenceThreshold) : 65,
      riskProfile: settingsData?.riskProfile ?? "moderate",
    },
  };
}

async function analyzeAllMarkets() {
  if (isScanning) return;
  isScanning = true;
  try {
    const { balance, settings } = await getAccountAndSettings();
    const now = new Date();
    // Only re-analyze markets that are stale (> 30 seconds old)
    const staleMarkets = DERIV_MARKETS.filter((m) => {
      const cached = analysisCache.get(m.symbol);
      return !cached || (now.getTime() - cached.lastUpdated.getTime()) > 30000;
    });

    // Analyze in batches of 5 to avoid overwhelming the WS
    for (let i = 0; i < Math.min(staleMarkets.length, 15); i++) {
      const market = staleMarkets[i];
      try {
        const prices = await getTickHistory(market.symbol, 50);
        const analysis = analyzeMarket(market.symbol, market.category, prices, balance, settings);
        analysisCache.set(market.symbol, {
          symbol: market.symbol,
          displayName: market.displayName,
          category: market.category,
          analysis,
          prices,
          lastUpdated: new Date(),
        });
      } catch {
        // skip failed markets
      }
    }
    lastScanTime = new Date();
  } finally {
    isScanning = false;
  }
}

// Warm up cache on startup
analyzeAllMarkets().catch(() => {});

router.get("/", async (req, res): Promise<void> => {
  const parseResult = GetMarketsQueryParams.safeParse(req.query);
  const params = parseResult.success ? parseResult.data : {} as { category?: string; limit?: number };
  const category = params.category === "all" ? undefined : params.category;
  const limit = params.limit ?? 50;

  // Trigger background refresh if cache is stale
  analyzeAllMarkets().catch(() => {});

  let markets = DERIV_MARKETS;
  if (category) markets = markets.filter((m) => m.category === category);

  const { balance, settings } = await getAccountAndSettings();

  const ranked = await Promise.all(
    markets.slice(0, limit).map(async (m) => {
      let cached = analysisCache.get(m.symbol);
      if (!cached) {
        const prices = await getTickHistory(m.symbol, 30);
        const analysis = analyzeMarket(m.symbol, m.category, prices, balance, settings);
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
        lastPrice: prices[prices.length - 1] ?? null,
        priceChange24h: prices.length > 1 ? ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100 : null,
        rank: 0,
      };
    })
  );

  // Sort by quality score
  ranked.sort((a, b) => b.qualityScore - a.qualityScore);
  ranked.forEach((m, i) => { m.rank = i + 1; });

  res.json(ranked);
});

router.get("/top", async (_req, res): Promise<void> => {
  analyzeAllMarkets().catch(() => {});
  const { balance, settings } = await getAccountAndSettings();

  let best: CachedAnalysis | null = null;
  for (const [, cached] of analysisCache) {
    if (!best || cached.analysis.qualityScore > best.analysis.qualityScore) {
      best = cached;
    }
  }

  if (!best) {
    // Analyze a default market
    const market = DERIV_MARKETS[0];
    const prices = await getTickHistory(market.symbol, 50);
    const analysis = analyzeMarket(market.symbol, market.category, prices, balance, settings);
    best = { symbol: market.symbol, displayName: market.displayName, category: market.category, analysis, prices, lastUpdated: new Date() };
    analysisCache.set(market.symbol, best);
  }

  const { analysis, prices } = best;
  res.json(buildMarketDetail(best.symbol, best.displayName, best.category, analysis, prices));
});

router.get("/scan", async (_req, res): Promise<void> => {
  res.json({
    status: isScanning ? "running" : "queued",
    marketsScanned: analysisCache.size,
    startedAt: lastScanTime?.toISOString() ?? new Date().toISOString(),
  });
});

router.post("/scan", async (_req, res): Promise<void> => {
  analyzeAllMarkets().catch(() => {});
  res.json({
    status: "running",
    marketsScanned: analysisCache.size,
    startedAt: new Date().toISOString(),
  });
});

router.get("/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const market = DERIV_MARKETS.find((m) => m.symbol === symbol);
  if (!market) {
    res.status(404).json({ error: "Market not found" });
    return;
  }

  const { balance, settings } = await getAccountAndSettings();
  const prices = await getTickHistory(symbol, 50);
  const analysis = analyzeMarket(symbol, market.category, prices, balance, settings);
  analysisCache.set(symbol, { symbol, displayName: market.displayName, category: market.category, analysis, prices, lastUpdated: new Date() });

  res.json(buildMarketDetail(symbol, market.displayName, market.category, analysis, prices));
});

function buildMarketDetail(symbol: string, displayName: string, category: string, analysis: ReturnType<typeof analyzeMarket>, prices: number[]) {
  const now = new Date();
  const priceHistory = prices.slice(-30).map((p, i) => ({
    timestamp: new Date(now.getTime() - (29 - i) * 5000).toISOString(),
    price: p,
  }));

  return {
    symbol,
    displayName,
    category,
    qualityScore: analysis.qualityScore,
    agentScores: analysis.agentScores,
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
      generatedAt: new Date().toISOString(),
    },
    priceHistory,
    lastUpdated: new Date().toISOString(),
  };
}

export { analysisCache, getAccountAndSettings };
export default router;
