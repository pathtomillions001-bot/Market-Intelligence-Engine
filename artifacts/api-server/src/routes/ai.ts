import { Router } from "express";
import { db } from "@workspace/db";
import { aiInsightsTable, tradesTable, settingsTable, accountsTable } from "@workspace/db";
import { sql, desc, eq } from "drizzle-orm";
import { tickManager, DERIV_MARKETS, executeLiveTrade, waitForContractResult, getLiveBalance, getCachedToken, getMarketInfo, analyzeDigits, analyzeTrend, analyzeEvenOdd, journalManager } from "../lib/deriv";
import { ToggleAutonomousEngineBody } from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { runCoordinator, buildLegacyAnalysis, recordTradeOutcome, updateDigitRecovery, setGlobalDigitRecovery } from "../lib/agent-coordinator";
import type { TradingSettings, DailyStats, ScanContext } from "../lib/agents/types";
import { broadcastSSE, addSSEClient, removeSSEClient } from "../lib/sse";

const router = Router();

// ── Engine state ─────────────────────────────────────────────────────────────
let engineRunning = false;
let autonomousMode = "manual";
let tradesExecutedToday = 0;
let currentMarket: string | null = null;
let nextScanIn: number | null = null;
let stopReasons: string[] = [];
let autonomousTimer: ReturnType<typeof setTimeout> | null = null;
let loopIntervalSec = 5;
let lastTradeTime: Date | null = null;
// Concurrency guard — prevents two loop iterations from running simultaneously
let isLoopRunning = false;
// Cooldown state — set when engine stops due to consecutive losses
let cooldownUntil: Date | null = null;
let cooldownResumeTimer: ReturnType<typeof setTimeout> | null = null;
// Consecutive loss counter — increments on each loss; resets to 0 on any win; full reset on cooldown expiry
let sessionLossCount = 0;

let exploitSymbol: string | null = null;
let exploitCount = 0;
let exploitQualityThreshold = 0;

// Real-time agent scores (updated each scan)
let lastAgentScores: Record<string, number> = {};

// ── Global cross-market recovery state ───────────────────────────────────────
// When any trade is lost, ALL enabled market families enter recovery mode.
// Over/Under: switches from OVER 2/UNDER 8 → OVER 4/UNDER 5
// Direction/EvenOdd: stake is increased to recover the loss in one trade
// Recovery ends when the cumulative profit from recovery trades ≥ unrecovered amount
interface GlobalRecoveryState {
  isActive: boolean;
  unrecoveredAmount: number;    // total USD still to recover
  activeFamilies: string[];     // which families are being tracked
  recoveredFamilies: string[];  // which families have recovered
  recoveryLossCount: number;    // consecutive losses DURING recovery (for progressive stake)
}
let globalRecovery: GlobalRecoveryState = {
  isActive: false,
  unrecoveredAmount: 0,
  activeFamilies: [],
  recoveredFamilies: [],
  recoveryLossCount: 0,
};

// ── Family rotation hint ───────────────────────────────────────────────────────
// Tracks which contract family should be preferred in the NEXT scan so that
// Rise/Fall and Even/Odd get executed in rotation alongside Over/Under, rather
// than Over/Under always winning the quality tournament.
let scheduledFamilyHint: string | null = null;

// ── Per-symbol trade cooldown ──────────────────────────────────────────────────
// Prevents more than MAX_TRADES_SAME_SYMBOL executions on the same synthetic pair
// within SAME_SYMBOL_COOLDOWN_MS. After the limit is reached the engine skips that
// symbol and picks the next-best opportunity.
const recentTradesBySymbol = new Map<string, Date[]>();
const MAX_TRADES_SAME_SYMBOL = 2;
const SAME_SYMBOL_COOLDOWN_MS = 8 * 60 * 1000; // 8 minutes

// ── Last completed trade timestamp ───────────────────────────────────────────
// Prevents the engine from immediately firing a second scan while a trade is
// still being journalled in Deriv. Set immediately after the trade settles.
let lastTradeCompletedAt: Date | null = null;

// Groups: 0=Volatility 1s (1HZ*), 1=Volatility (R_*), 2=Jump (JD*), 3=Bull/Bear
const GROUP_NAMES = ["Volatility 1s", "Volatility", "Jump Indices", "Bull/Bear"];

// ── Per-group scan cursor ─────────────────────────────────────────────────────
// Each group advances its own cursor by 1 every loop iteration so markets are
// visited in strict canonical order (V10→V25→V50→V75→V100) with NO repeats
// until the entire group has been scanned once (then the cursor wraps to V10).
// All 4 groups advance simultaneously (parallel), but each group never skips
// or revisits a market within its own cycle.
// Index: 0=Volatility 1s, 1=Volatility, 2=Jump Indices, 3=Bull/Bear
const groupCursors = [0, 0, 0, 0];

// 13-agent system names and score keys
const AGENT_NAMES = [
  "Market Scanner", "Tick Intelligence", "Digit Probability",
  "Rise/Fall Model", "Market Regime", "Execution Timing",
  "Confidence Fusion", "Recovery Intelligence", "Risk Intelligence",
  "Portfolio Manager", "Learning Agent", "Pattern Discovery",
  "Trade Explainability",
];

const AGENT_SCORE_KEYS = [
  "marketScanner", "tickIntelligence", "digitProbability",
  "riseFallAgent", "marketRegime", "executionTiming",
  "confidenceFusion", "recoveryIntelligence", "riskIntelligence",
  "portfolioManager", "learningAgent", "patternDiscovery",
  "tradeExplainability",
];

// ── Settings builders ─────────────────────────────────────────────────────────

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

function buildTradingSettings(s: any, preferredContractTypes: string[]): TradingSettings {
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

function buildDailyStats(
  closedToday: any[],
  consecutiveLosses: number,
): DailyStats {
  const wins = closedToday.filter((t) => t.status === "won").length;
  const losses = closedToday.filter((t) => t.status === "lost").length;
  const profit = closedToday.reduce((s: number, t: any) => s + Number(t.profit ?? 0), 0);
  // Consecutive wins (for completeness)
  let consecutiveWins = 0;
  const sorted = [...closedToday].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  for (const t of sorted) { if (t.status === "won") consecutiveWins++; else break; }

  return {
    tradesCount: closedToday.length,
    wins,
    losses,
    profit,
    consecutiveLosses,
    consecutiveWins,
  };
}

function buildScanContext(
  market: { symbol: string; displayName: string; category: string; digitEnabled?: boolean },
  balance: number,
  settings: TradingSettings,
  daily: DailyStats,
  token: string | null,
  currency: string,
): ScanContext {
  const prices = tickManager.getTicks(market.symbol, 100);
  const digits = market.digitEnabled ? tickManager.getDigits(market.symbol, 300) : [];
  return {
    symbol:      market.symbol,
    displayName: market.displayName,
    category:    market.category,
    prices,
    digits,
    balance,
    settings,
    daily,
    token,
    currency,
  };
}

// ── Wire up JournalManager → SSE so dashboard updates instantly on refresh ────
journalManager.on("refreshed", () => {
  broadcastSSE("journal_refreshed", { ts: Date.now() });
});

// ── Wire up TickManager → SSE for live prices + live analysis ─────────────────

// Track the last time each market received a real Deriv tick
const lastTickTime = new Map<string, number>();

tickManager.on("tick", (tick) => {
  broadcastSSE("tick", tick);
  lastTickTime.set(tick.symbol, Date.now());
  const market = getMarketInfo(tick.symbol);
  if (market) {
    const prices = tickManager.getTicks(tick.symbol, 100);
    const trendStats = analyzeTrend(prices);
    // Get 100 digits for richer even/odd and digit analysis
    const digits100 = market.digitEnabled ? tickManager.getDigits(tick.symbol, 100) : null;
    const digitStats = (digits100 && digits100.length > 10) ? analyzeDigits(digits100) : null;
    broadcastSSE("market_analysis", {
      symbol: tick.symbol, trendStats, digitStats,
      lastDigit: tick.lastDigit,
      price: tick.price, epoch: tick.epoch,
    });
  }
});

// ── Heartbeat: broadcast market_analysis for markets that haven't received
//    a real Deriv tick in the last 3s (e.g. 1HZ25V when Deriv throttles).
//    Rotates through all markets, one per 200ms, full cycle every ~7s.
let heartbeatIdx = 0;
setInterval(() => {
  const now = Date.now();
  const markets = DERIV_MARKETS;
  if (markets.length === 0) return;
  heartbeatIdx = (heartbeatIdx + 1) % markets.length;
  const market = markets[heartbeatIdx];
  const lastTick = lastTickTime.get(market.symbol) ?? 0;
  // Only broadcast if this market hasn't had a real tick in the last 3 seconds
  if (now - lastTick < 3000) return;
  const prices = tickManager.getTicks(market.symbol, 100);
  const trendStats = analyzeTrend(prices);
  const digits100h = market.digitEnabled ? tickManager.getDigits(market.symbol, 100) : null;
  const digitStats = (digits100h && digits100h.length > 10) ? analyzeDigits(digits100h) : null;
  const latestPrice = tickManager.getLatestPrice(market.symbol) ?? prices[prices.length - 1] ?? 0;
  broadcastSSE("market_analysis", {
    symbol: market.symbol,
    trendStats,
    digitStats,
    lastDigit: digits100h ? digits100h[digits100h.length - 1] ?? null : null,
    price: latestPrice,
    epoch: Math.floor(now / 1000),
  });
}, 200);

// ── Helpers ───────────────────────────────────────────────────────────────────
function stopEngine(reason: string, cooldownMinutes?: number) {
  engineRunning = false;
  autonomousMode = "manual";
  stopReasons = [reason];
  currentMarket = null;
  nextScanIn = null;
  exploitSymbol = null;
  exploitCount = 0;
  isLoopRunning = false;
  if (autonomousTimer) { clearTimeout(autonomousTimer); autonomousTimer = null; }

  // Clear any existing cooldown timer
  if (cooldownResumeTimer) { clearTimeout(cooldownResumeTimer); cooldownResumeTimer = null; }

  if (cooldownMinutes && cooldownMinutes > 0) {
    cooldownUntil = new Date(Date.now() + cooldownMinutes * 60 * 1000);
    cooldownResumeTimer = setTimeout(() => {
      cooldownUntil = null;
      cooldownResumeTimer = null;
      // Reset session loss counter on cooldown expiry — the ONLY reset point
      sessionLossCount = 0;
      // Auto-resume engine
      engineRunning = true;
      autonomousMode = "autonomous";
      stopReasons = [];
      nextScanIn = loopIntervalSec;
      exploitSymbol = null;
      exploitCount = 0;
      logger.info("Cooldown expired — autonomous engine auto-resuming, session loss count reset");
      broadcastSSE("engine_started", { reason: "cooldown_expired" });
      broadcastSSE("loss_streak_reset", { sessionLossCount: 0 });
      autonomousTimer = setTimeout(runAutonomousLoop, 1000);
    }, cooldownMinutes * 60 * 1000);
    logger.info({ reason, cooldownMinutes, cooldownUntil }, "Engine stopped with cooldown");
  } else {
    cooldownUntil = null;
    logger.info({ reason }, "Autonomous engine stopped");
  }
  broadcastSSE("engine_stopped", { reason, cooldownUntil: cooldownUntil?.toISOString() ?? null });
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
  // Prevent concurrent iterations — if a previous loop is still running, skip
  if (isLoopRunning) {
    logger.warn("Autonomous loop: previous iteration still running — skipping this tick");
    scheduleNext(false);
    return;
  }
  isLoopRunning = true;

  try {
    const { balance, settings, account } = await getAccountAndSettings();
    const token = getCachedToken() ?? account?.token ?? null;

    const rawPreferred = settings?.preferredContractTypes?.split(",").filter(Boolean) ?? ["CALL", "PUT", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD"];
    // Normalize: accept both CALL/PUT and RISE/FALL, unify to CALL/PUT
    const preferredContractTypes = rawPreferred.map(t => t === "RISE" ? "CALL" : t === "FALL" ? "PUT" : t).filter((v, i, a) => a.indexOf(v) === i);
    const tradingSettings = buildTradingSettings(settings, preferredContractTypes);
    const marketRotationAfter = settings?.marketRotationAfter ?? 5;
    const paperTradeMode = tradingSettings.paperTradeMode;

    const allowedMarketSymbols: string[] | null =
      (settings as any)?.allowedMarkets
        ? ((settings as any).allowedMarkets as string).split(",").filter(Boolean)
        : null;
    const availableMarkets = allowedMarketSymbols && allowedMarketSymbols.length > 0
      ? DERIV_MARKETS.filter((m) => allowedMarketSymbols.includes(m.symbol))
      : DERIV_MARKETS;

    if (settings?.loopIntervalSec) loopIntervalSec = settings.loopIntervalSec;

    // Daily stats
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayTrades = await db.select().from(tradesTable).where(sql`${tradesTable.createdAt} >= ${today}`);
    const closedToday = todayTrades.filter((t) => t.status === "won" || t.status === "lost");
    tradesExecutedToday = closedToday.length;

    // ── Ground-truth consecutive-loss and daily P&L ──────────────────────────
    // When a Deriv token is connected, the Deriv profit_table (journalManager) is
    // ALWAYS the authoritative source of consecutive losses and daily P&L.
    // The local DB can have stale "lost" records from timed-out contract checks
    // that Deriv actually settled as wins — those cause false cooldown triggers.
    // We only fall back to local DB when no Deriv data is available (paper mode).
    const derivTxns = token ? journalManager.getCached() : [];
    const todayMidnightSec = today.getTime() / 1000; // Deriv uses Unix seconds
    const derivTodayTxns = derivTxns.filter(
      (t: any) => Number(t.sell_time ?? t.purchase_time ?? 0) >= todayMidnightSec,
    );

    let journalConsecutiveLosses: number;
    let resolvedDailyProfit: number;

    if (derivTodayTxns.length > 0) {
      // Deriv profit_table is returned DESC (most recent first) — iterate to count
      // consecutive losses at the head of the list.  A winning trade breaks the streak.
      let consecLosses = 0;
      for (const t of derivTodayTxns) {
        if (Number(t.profit ?? 0) < 0) consecLosses++;
        else break;
      }
      journalConsecutiveLosses = consecLosses;
      resolvedDailyProfit = derivTodayTxns.reduce(
        (s: number, t: any) => s + Number(t.profit ?? 0), 0,
      );
    } else {
      // No Deriv journal data yet (paper mode or token not connected) — use local DB
      const sortedByTime = [...closedToday].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      journalConsecutiveLosses = 0;
      for (const t of sortedByTime) { if (t.status === "lost") journalConsecutiveLosses++; else break; }
      resolvedDailyProfit = closedToday.reduce((s, t) => s + Number(t.profit ?? 0), 0);
    }

    // Mirror in-memory counter so the status endpoint always matches ground truth
    sessionLossCount = journalConsecutiveLosses;

    const daily = buildDailyStats(closedToday, journalConsecutiveLosses);
    // Override daily.profit with the resolved value (Deriv journal when available)
    daily.profit = resolvedDailyProfit;
    const todayProfit = resolvedDailyProfit;

    // Hard stops — only triggered by Deriv-verified P&L and loss streak.
    if (todayProfit <= -tradingSettings.dailyLossLimit) { stopEngine(`Daily loss limit $${tradingSettings.dailyLossLimit} reached`); return; }
    if (todayProfit >= tradingSettings.dailyTarget) { stopEngine(`Daily target $${tradingSettings.dailyTarget} reached!`); return; }
    if (daily.consecutiveLosses >= tradingSettings.consecutiveLossLimit) {
      const cooldownMins = settings?.cooldownMinutes ?? 30;
      stopEngine(`Journal shows ${daily.consecutiveLosses} consecutive losses — limit ${tradingSettings.consecutiveLossLimit} reached, cooling down ${cooldownMins}m`, cooldownMins);
      return;
    }

    // ── Market selection: parallel tournament scanning ───────────────────────
    // All 4 groups are scanned simultaneously. Each group scans all its markets
    // in parallel and returns the single best candidate (highest qualityScore).
    // The best candidate across all 4 groups is then evaluated for execution.
    // Bull/Bear only participates when CALL/PUT contract types are enabled.
    // If no candidate passes all gates → rescan immediately (no delay).
    const hasDigitTypes = preferredContractTypes.some(t => t.startsWith("DIGIT"));
    const hasDirectionTypes = preferredContractTypes.some(t => ["CALL", "PUT"].includes(t));

    // Build set of symbols currently on per-symbol cooldown so they are excluded
    // from the tournament scan entirely — the engine will find the next-best pair
    // instead of looping on a blocked symbol.
    const symCutoffPre = Date.now() - SAME_SYMBOL_COOLDOWN_MS;
    const cooledDownSymbols = new Set<string>();
    for (const [sym, dates] of recentTradesBySymbol) {
      const recentCount = dates.filter(d => d.getTime() > symCutoffPre).length;
      if (recentCount >= MAX_TRADES_SAME_SYMBOL) cooledDownSymbols.add(sym);
    }
    if (cooledDownSymbols.size > 0) {
      logger.info({ cooledDown: [...cooledDownSymbols] }, "Autonomous: excluding symbols on per-pair cooldown from scan");
    }

    const contractCompatibleMarkets = availableMarkets.filter(m => {
      // Skip symbols that have hit the 2-trades-per-8-min cooldown
      if (cooledDownSymbols.has(m.symbol)) return false;
      // Skip non-digit markets when only digit contract types are enabled
      if (hasDigitTypes && !hasDirectionTypes && !m.digitEnabled) return false;
      // Bull/Bear markets only support Rise/Fall — skip when no direction types
      if ((m.symbol === "RDBULL" || m.symbol === "RDBEAR") && !hasDirectionTypes) return false;
      return true;
    });

    const getGroupIndex = (sym: string): number => {
      if (sym.startsWith("1HZ")) return 0; // Volatility 1s (5 markets)
      if (sym.startsWith("R_"))  return 1; // Volatility     (5 markets)
      if (sym.startsWith("JD"))  return 2; // Jump Indices   (5 markets)
      return 3;                             // Bull/Bear      (2 markets)
    };
    // Bucket markets into their 4 groups
    const marketGroups: (typeof contractCompatibleMarkets)[] = [[], [], [], []];
    for (const m of contractCompatibleMarkets) marketGroups[getGroupIndex(m.symbol)].push(m);

    let totalMarketsScanned = 0;
    const SCAN_TIMEOUT_MS = 4000;
    const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
      Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

    type ScanResult = { market: typeof availableMarkets[0]; output: Awaited<ReturnType<typeof runCoordinator>>; ctx: ScanContext; family: string };

    // ── Contract family definitions ───────────────────────────────────────────
    // Each market is evaluated by up to 3 families simultaneously.
    // Only families with enabled contract types are run per market.
    const dirTypes  = preferredContractTypes.filter(t => ["CALL", "PUT"].includes(t));
    const ouTypes   = preferredContractTypes.filter(t => ["DIGITOVER", "DIGITUNDER"].includes(t));
    const eoTypes   = preferredContractTypes.filter(t => ["DIGITEVEN", "DIGITODD"].includes(t));

    // ── Phase 1: All 4 groups scan in PARALLEL, but each group scans
    //    ONLY ONE market per iteration — the one at its cursor position.
    //
    //    Canonical scan order per group (determined by DERIV_MARKETS array):
    //      Volatility 1s : 1HZ10V → 1HZ25V → 1HZ50V → 1HZ75V → 1HZ100V → wrap
    //      Volatility    : R_10   → R_25   → R_50   → R_75   → R_100   → wrap
    //      Jump Indices  : JD10   → JD25   → JD50   → JD75   → JD100   → wrap
    //      Bull/Bear     : RDBULL → RDBEAR → wrap
    //
    //    No market is revisited until every market in its group has been
    //    scanned once. Cursor advances BEFORE awaiting so groups never
    //    block each other. Only enabled contract families are run per market.
    broadcastSSE("scan_started", { groups: GROUP_NAMES.filter((_, i) => marketGroups[i].length > 0), ts: Date.now() });

    const groupWinners = (await Promise.allSettled(
      marketGroups.map(async (group, gi): Promise<(ScanResult & { groupName: string }) | null> => {
        if (group.length === 0) return null;

        // Scan ALL markets in this group in parallel — pick the best opportunity
        // across the whole group rather than using a single cursor position.
        type MarketResult = ScanResult & { allFamilyResults: ScanResult[] };
        const allMarketResults = (await Promise.allSettled(
          group.map(async (m): Promise<MarketResult | null> => {
            try {
              const isBullBear = m.symbol === "RDBULL" || m.symbol === "RDBEAR";

              // Only run families whose contract types are enabled in settings.
              const families: Array<{ name: string; types: string[] }> = [];
              if (dirTypes.length > 0)                                  families.push({ name: "direction", types: dirTypes });
              if (!isBullBear && m.digitEnabled && ouTypes.length > 0)  families.push({ name: "overunder", types: ouTypes });
              if (!isBullBear && m.digitEnabled && eoTypes.length > 0)  families.push({ name: "evenodd",   types: eoTypes });

              if (families.length === 0) return null;

              const baseCtx = buildScanContext(m, balance, tradingSettings, daily, null, account?.currency ?? "USD");

              const familyResults = (await Promise.allSettled(
                families.map(async (fam) => {
                  const famCtx: ScanContext = {
                    ...baseCtx,
                    settings: {
                      ...baseCtx.settings,
                      preferredContractTypes: fam.types,
                      // Even/odd contracts are inherently near-50/50 so the Markov-edge signal
                      // never reaches the same confidence scores as direction or digit-barrier
                      // agents. Always lower the threshold for this family regardless of what
                      // other families are also active so Even/Odd gets a fair shot in the
                      // tournament when multiple markets are enabled simultaneously.
                      confidenceThreshold: fam.name === "evenodd"
                        ? Math.min(baseCtx.settings.minConfidenceThreshold ?? 38, 48)
                        : baseCtx.settings.confidenceThreshold,
                    },
                    inRecovery: globalRecovery.isActive,
                  };
                  const output = await withTimeout(runCoordinator(famCtx), SCAN_TIMEOUT_MS, null as any);
                  if (!output) return null;
                  return { market: m, output, ctx: famCtx, family: fam.name } as ScanResult;
                })
              )).flatMap(r => r.status === "fulfilled" && r.value ? [r.value] : []);

              if (familyResults.length === 0) return null;

              totalMarketsScanned++;

              const tradeableFamilies = familyResults.filter(r => r.output.shouldTrade);
              const marketBest = tradeableFamilies.length > 0
                ? tradeableFamilies.sort((a, b) => b.output.qualityScore - a.output.qualityScore)[0]
                : familyResults.sort((a, b) => b.output.qualityScore - a.output.qualityScore)[0];

              return { ...marketBest, allFamilyResults: familyResults };
            } catch { return null; }
          })
        )).flatMap(r => r.status === "fulfilled" && r.value ? [r.value] : []);

        if (allMarketResults.length === 0) return null;

        // Among all markets in this group, prefer tradeable then highest qualityScore.
        const tradeableMarkets = allMarketResults.filter(r => r.output.shouldTrade);
        const groupBest = tradeableMarkets.length > 0
          ? tradeableMarkets.sort((a, b) => b.output.qualityScore - a.output.qualityScore)[0]
          : allMarketResults.sort((a, b) => b.output.qualityScore - a.output.qualityScore)[0];

        logger.info({
          group: GROUP_NAMES[gi],
          marketsScanned: allMarketResults.length,
          tradeableCount: tradeableMarkets.length,
          bestSymbol: groupBest.market.symbol,
          family: groupBest.family,
          quality: groupBest.output.qualityScore,
          shouldTrade: groupBest.output.shouldTrade,
        }, "Group full scan complete");

        const allFamilySummaries = groupBest.allFamilyResults.map(r => ({
          name: r.family,
          contract: r.output.recommendation?.product ?? null,
          shouldTrade: r.output.shouldTrade,
          confidence: Math.round(r.output.confidenceScore),
          quality: Math.round(r.output.qualityScore),
          rejectReason: r.output.rejectReason ?? null,
        }));

        broadcastSSE("group_scanned", {
          group: GROUP_NAMES[gi],
          totalInGroup: group.length,
          scanned: allMarketResults.length,
          bestSymbol: groupBest.market.symbol,
          bestDisplayName: groupBest.market.displayName,
          quality: groupBest.output.qualityScore,
          shouldTrade: groupBest.output.shouldTrade,
          contract: groupBest.output.recommendation?.product ?? null,
          confidence: groupBest.output.confidenceScore,
          family: groupBest.family,
          families: allFamilySummaries,
          rejectReason: groupBest.output.rejectReason ?? null,
        });

        return { ...groupBest, groupName: GROUP_NAMES[gi] };
      })
    )).flatMap(r => r.status === "fulfilled" && r.value ? [r.value] : []);

    // ── Phase 2: Tournament — pick the overall winner ────────────────────────
    // Among tradeable group winners, apply family rotation so Rise/Fall and
    // Even/Odd get executed in turn alongside Over/Under rather than always
    // losing the quality tournament to higher-scoring digit barriers.
    const tradeableWinners = groupWinners.filter(w => w.output.shouldTrade);

    // Determine which families actually have tradeable results this scan
    const enabledFamiliesThisScan = new Set(tradeableWinners.map(w => w.family));
    const multipleFamily = enabledFamiliesThisScan.size > 1;

    // When multiple families are active, narrow the pool to the scheduled family
    // so each family gets executed roughly in turn.
    let tournamentPool = tradeableWinners;
    if (multipleFamily && scheduledFamilyHint && enabledFamiliesThisScan.has(scheduledFamilyHint)) {
      const hinted = tradeableWinners.filter(w => w.family === scheduledFamilyHint);
      if (hinted.length > 0) tournamentPool = hinted;
    }

    const bestResult: (ScanResult & { groupName: string }) | null = tournamentPool.length > 0
      ? tournamentPool.sort((a, b) => b.output.qualityScore - a.output.qualityScore)[0]
      : null;

    if (bestResult) {
      logger.info({
        symbol: bestResult.market.symbol,
        group: bestResult.groupName,
        quality: bestResult.output.qualityScore,
        groupsScanned: groupWinners.length,
        marketsScanned: totalMarketsScanned,
      }, "Tournament winner — executing");
    } else {
      logger.info({ groupsScanned: groupWinners.length, marketsScanned: totalMarketsScanned }, "No qualifying opportunity across all groups — rescanning");
      scheduleNext(false, 500); // Near-instant rescan
      return;
    }

    const { market: bestMarket, output } = bestResult;
    // Rebuild ctx with real token for live trade execution (scan used null for speed)
    const ctx = buildScanContext(bestMarket, balance, tradingSettings, daily, token, account?.currency ?? "USD");
    currentMarket = bestMarket.symbol;

    // ── Guard: block if there is already an open/in-progress trade ───────────
    const openTrades = await db.select().from(tradesTable).where(eq(tradesTable.status, "open"));
    if (openTrades.length > 0) {
      logger.info({ openCount: openTrades.length }, "Autonomous: open trade in progress — waiting before next scan");
      scheduleNext(false);
      return;
    }

    // ── Guard: require minimum time since last trade settled ─────────────────
    // Ensures the Deriv journal has time to record the closed trade before we start
    // the next scan. This prevents the engine from opening a second trade while the
    // first is still being journalled on Deriv's side.
    if (lastTradeCompletedAt && (Date.now() - lastTradeCompletedAt.getTime()) < 12_000) {
      logger.info({ msAgo: Date.now() - lastTradeCompletedAt.getTime() }, "Autonomous: journal settle delay — waiting 3s");
      scheduleNext(false, 3000);
      return;
    }

    // ── Guard: per-symbol cooldown (max 2 trades per pair per 8 min) ─────────
    // Note: symbols already on cooldown are filtered out of the scan above so
    // the tournament winner should never be on cooldown. This guard is a safety
    // net for the rare edge case where the cooldown was reached mid-scan.
    const symHistory = recentTradesBySymbol.get(bestMarket.symbol) ?? [];
    const symCutoff = Date.now() - SAME_SYMBOL_COOLDOWN_MS;
    const symRecentCount = symHistory.filter(d => d.getTime() > symCutoff).length;
    if (symRecentCount >= MAX_TRADES_SAME_SYMBOL) {
      logger.info({ symbol: bestMarket.symbol, recentCount: symRecentCount },
        "Autonomous: symbol cooldown guard triggered mid-scan — rescanning for next-best pair");
      scheduleNext(false, 500);
      return;
    }

    // Build legacy analysis for backward-compat fields
    const analysis = buildLegacyAnalysis(output);

    // Update agent scores
    const agentOutputs = output.agents;
    lastAgentScores = Object.fromEntries(
      AGENT_SCORE_KEYS.map((k) => [k, agentOutputs[k]?.score ?? 65])
    );

    broadcastSSE("scan_complete", {
      symbol: bestMarket.symbol,
      quality: output.qualityScore,
      confidence: output.confidenceScore,
      agentScores: lastAgentScores,
      marketsScanned: totalMarketsScanned,
      regime: output.regime,
      shouldTrade: output.shouldTrade,
      rejectReason: output.rejectReason,
      sessionLossCount,
      consecutiveLossLimit: tradingSettings.consecutiveLossLimit,
    });

    if (!output.shouldTrade) {
      logger.info({
        symbol: bestMarket.symbol,
        quality: output.qualityScore,
        reason: output.rejectReason,
      }, "Conditions not favourable — scanning next");
      scheduleNext(false);
      return;
    }

    // ── Advance family rotation hint for the NEXT scan ───────────────────────
    {
      const allEnabledFamilies = [
        ...(dirTypes.length > 0 ? ["direction"] : []),
        ...(ouTypes.length > 0 ? ["overunder"] : []),
        ...(eoTypes.length > 0 ? ["evenodd"] : []),
      ];
      if (allEnabledFamilies.length > 1) {
        const currentIdx = allEnabledFamilies.indexOf(bestResult.family);
        scheduledFamilyHint = allEnabledFamilies[(currentIdx + 1) % allEnabledFamilies.length];
      } else {
        scheduledFamilyHint = null;
      }
    }

    // ── Trade execution ──────────────────────────────────────────────────────
    const rec = output.recommendation;
    const effectiveContractType = rec.product;
    const effectiveBarrier = rec.barrier;
    // Enforce minimum 5 ticks for DIGITEVEN/DIGITODD — Deriv rejects < 5t for these types
    const rawDuration = rec.duration ?? 5;
    const duration = (effectiveContractType === "DIGITEVEN" || effectiveContractType === "DIGITODD")
      ? Math.max(5, rawDuration)
      : rawDuration;

    // ── Recovery stake override ───────────────────────────────────────────────
    // During recovery the stake is a flat 1.15× the normal stake — no compounding.
    // The higher payout from OVER 4 / UNDER 5 (≈1.63×) combined with the slight
    // stake bump means each recovery WIN chips away at the unrecovered amount until
    // it reaches zero, at which point the engine returns to OVER 2 / UNDER 7.
    // Recovery LOSSES simply add to the unrecovered total; stake stays at 1.15× normal.
    let stake = rec.stake;
    if (globalRecovery.isActive) {
      const recoveryStake = Math.round(rec.stake * 1.15 * 100) / 100;
      stake = Math.min(Math.max(stake, recoveryStake), tradingSettings.maxTradeStake);
      stake = Math.round(stake * 100) / 100;
      logger.info({
        symbol: bestMarket.symbol,
        family: bestResult.family,
        unrecoveredAmount: globalRecovery.unrecoveredAmount,
        normalStake: rec.stake,
        recoveryStake: stake,
        contractType: effectiveContractType,
        barrier: effectiveBarrier,
      }, "Recovery mode: 1.15× stake, OVER 4 / UNDER 5 barriers active");
    }

    // Estimated payout for paper trades (live payout comes from Deriv result)
    const estimatedPayout = stake * rec.payoutMultiplier;
    const barrierToStore = effectiveContractType.includes("DIGIT") ? (effectiveBarrier ?? null) : null;

    let won: boolean, profit: number, entryPrice: number, exitPrice: number;
    // Actual payout settled (set after trade outcome known)
    let actualPayout: number;

    if (paperTradeMode || !token) {
      const winProb = rec.winProbability / 100;
      won = Math.random() < winProb;
      profit = won ? estimatedPayout - stake : -stake;
      actualPayout = won ? estimatedPayout : 0;
      entryPrice = ctx.prices[ctx.prices.length - 1] ?? 100;
      exitPrice = entryPrice;
      logger.info({ symbol: bestMarket.symbol, paper: true, won, ev: analysis.expectedValue }, "Paper trade");

      // Paper trades: insert completed record immediately
      recordTradeOutcome(bestMarket.symbol, effectiveContractType, effectiveBarrier ?? null, won, profit, stake);
      updateDigitRecovery(bestMarket.symbol, effectiveContractType, won, profit, stake);

      await db.insert(tradesTable).values({
        symbol: bestMarket.symbol,
        displayName: bestMarket.displayName,
        contractType: effectiveContractType,
        barrier: barrierToStore,
        stake: String(stake),
        direction: output.direction,
        status: won ? "won" : "lost",
        payout: String(actualPayout),
        profit: String(profit),
        entryPrice: String(entryPrice),
        exitPrice: String(exitPrice),
        aiConfidence: String(rec.winProbability),
        aiRiskScore: String(output.riskScore),
        isAutonomous: true,
        agentReasoning: `[PAPER] ${output.reasoning}`,
        duration,
        durationUnit: "t",
        closedAt: new Date(),
      });
    } else {
      // ── Live trade: insert "open" FIRST so journal shows it immediately ──
      const [openTrade] = await db.insert(tradesTable).values({
        symbol: bestMarket.symbol,
        displayName: bestMarket.displayName,
        contractType: effectiveContractType,
        barrier: barrierToStore,
        stake: String(stake),
        direction: output.direction,
        status: "open",
        aiConfidence: String(rec.winProbability),
        aiRiskScore: String(output.riskScore),
        isAutonomous: true,
        agentReasoning: output.reasoning,
        duration,
        durationUnit: "t",
      }).returning();

      // Broadcast so journal updates immediately
      broadcastSSE("trade_started", {
        id: openTrade.id,
        symbol: bestMarket.symbol,
        contract: effectiveContractType,
        barrier: barrierToStore,
        stake,
        duration,
        regime: output.regime,
        confidence: rec.winProbability,
        ev: analysis.expectedValue,
      });

      try {
        // Deriv requires stake with max 2 decimal places
        const liveStake = Math.round(stake * 100) / 100;
        const liveResult = await executeLiveTrade(token, {
          symbol: bestMarket.symbol,
          contractType: effectiveContractType,
          stake: liveStake,
          duration,
          durationUnit: "t",
          currency: account?.currency ?? "USD",
          barrier: effectiveContractType.includes("DIGIT") ? effectiveBarrier : undefined,
        });
        entryPrice = liveResult.buyPrice;
        // Wait for Deriv to settle the contract — timeout = ticks * 1s + 30s buffer
        const contractResult = await waitForContractResult(token, liveResult.contractId, (duration + 30) * 1000);
        won = contractResult.won;
        // Use Deriv's exact profit — this is the ground truth for the journal
        profit = contractResult.profit;
        // Actual payout = stake returned + net profit (only when won; 0 when lost)
        actualPayout = won ? stake + profit : 0;
        exitPrice = contractResult.exitSpot;
        entryPrice = contractResult.entrySpot || liveResult.buyPrice;
        await syncLiveBalance(token);
      } catch (liveErr) {
        const errMsg = liveErr instanceof Error ? liveErr.message : String(liveErr);
        logger.warn({ liveErrMsg: errMsg, symbol: bestMarket.symbol, contractType: effectiveContractType }, "Live autonomous trade failed — outcome unknown, marking as error");
        // Mark as "error" (NOT "lost") — Deriv may still settle this contract as a WIN.
        // Marking as "lost" would create a false loss that corrupts consecutive-loss count
        // and daily P&L, causing the engine to falsely trigger loss-streak / loss-limit stops
        // even when the actual Deriv journal shows wins.
        await db.update(tradesTable)
          .set({ status: "error", profit: "0", payout: "0", closedAt: new Date(),
                 agentReasoning: `${output.reasoning} [EXECUTION FAILED: ${errMsg}]` })
          .where(eq(tradesTable.id, openTrade.id));
        broadcastSSE("trade_completed", { id: openTrade.id, symbol: bestMarket.symbol, won: false,
          profit: "0", contract: effectiveContractType, error: errMsg });
        journalManager.forceRefresh();

        // Do NOT touch sessionLossCount or globalRecovery here — the contract outcome
        // is unknown (Deriv may have settled it as won). Adding a false loss count here
        // is what caused consecutive-loss / daily-limit false-positives.
        // Only record the cooldown timestamp so the engine waits before re-scanning
        // (gives Deriv time to settle the contract before another trade is attempted).
        lastTradeCompletedAt = new Date();
        const symNowErr = new Date();
        const symLogErr = recentTradesBySymbol.get(bestMarket.symbol) ?? [];
        symLogErr.push(symNowErr);
        recentTradesBySymbol.set(bestMarket.symbol, symLogErr.filter(d => d.getTime() > Date.now() - SAME_SYMBOL_COOLDOWN_MS));

        scheduleNext(true);
        return;
      }

      // Update the open record to Deriv-confirmed final status
      recordTradeOutcome(bestMarket.symbol, effectiveContractType, effectiveBarrier ?? null, won, profit, stake);
      updateDigitRecovery(bestMarket.symbol, effectiveContractType, won, profit, stake);

      await db.update(tradesTable).set({
        status: won ? "won" : "lost",
        // actualPayout: total returned to account (stake + net profit) when won, 0 when lost
        payout: String(actualPayout),
        // profit: exact net P&L from Deriv (positive on win, negative on loss)
        profit: String(profit),
        entryPrice: String(entryPrice),
        exitPrice: String(exitPrice),
        closedAt: new Date(),
      }).where(eq(tradesTable.id, openTrade.id));
    }

    // ── Record trade in per-symbol cooldown map ──────────────────────────────
    const symNow = new Date();
    const symLog = recentTradesBySymbol.get(bestMarket.symbol) ?? [];
    symLog.push(symNow);
    // Prune old entries outside the cooldown window
    recentTradesBySymbol.set(bestMarket.symbol, symLog.filter(d => d.getTime() > Date.now() - SAME_SYMBOL_COOLDOWN_MS));

    // ── Mark last-trade timestamp so journal-settle guard works correctly ─────
    lastTradeCompletedAt = symNow;

    // Track consecutive losses — a win resets it to 0; cooldown expiry also resets it
    if (!won) sessionLossCount++;
    else sessionLossCount = 0;

    // ── Global cross-market recovery state update ────────────────────────────
    if (won) {
      if (globalRecovery.isActive) {
        // Recovery WIN: subtract this trade's profit from the unrecovered total.
        // Recovery only ends when the cumulative profit from recovery trades fully
        // covers the total losses accumulated since recovery began.
        // e.g. lost $10 → recovery trade (OVER 4, 1.15× stake, payout 1.63×):
        //   profit ≈ $7.26 → still $2.74 unrecovered → keep recovery mode
        //   next recovery win ≈ $7.26 → $2.74 - $7.26 < 0 → recovery complete
        globalRecovery.unrecoveredAmount = Math.max(0, globalRecovery.unrecoveredAmount - Math.abs(profit));

        if (globalRecovery.unrecoveredAmount <= 0) {
          // All losses recovered — return to OVER 2 / UNDER 7, normal stake
          globalRecovery.isActive = false;
          globalRecovery.unrecoveredAmount = 0;
          globalRecovery.activeFamilies = [];
          globalRecovery.recoveredFamilies = [];
          globalRecovery.recoveryLossCount = 0;
          setGlobalDigitRecovery(false, 0);
          logger.info({ symbol: bestMarket.symbol, family: bestResult.family, profit },
            "Recovery complete — losses fully recovered, returning to OVER 2 / UNDER 7");
          broadcastSSE("recovery_complete", { symbol: bestMarket.symbol, ts: Date.now(), profit });
        } else {
          // Partial recovery — still owe, stay in OVER 4 / UNDER 5
          setGlobalDigitRecovery(true, globalRecovery.unrecoveredAmount);
          logger.info({
            symbol: bestMarket.symbol,
            profit,
            remainingUnrecovered: globalRecovery.unrecoveredAmount,
          }, "Recovery partial — continuing OVER 4 / UNDER 5 until losses covered");
          broadcastSSE("recovery_progress", {
            symbol: bestMarket.symbol,
            profit,
            remainingAmount: globalRecovery.unrecoveredAmount,
          });
        }
      }
    } else {
      // Trade lost — activate recovery or add to existing unrecovered total
      const lostAmount = Math.abs(profit);
      if (globalRecovery.isActive) {
        globalRecovery.recoveryLossCount++;
      } else {
        globalRecovery.recoveryLossCount = 0;
      }
      globalRecovery.isActive = true;
      globalRecovery.unrecoveredAmount += lostAmount;
      const lostFamily = bestResult.family;
      if (!globalRecovery.activeFamilies.includes(lostFamily)) {
        globalRecovery.activeFamilies.push(lostFamily);
      }
      if (dirTypes.length > 0 && !globalRecovery.activeFamilies.includes("direction")) {
        globalRecovery.activeFamilies.push("direction");
      }
      if (ouTypes.length > 0 && !globalRecovery.activeFamilies.includes("overunder")) {
        globalRecovery.activeFamilies.push("overunder");
      }
      if (eoTypes.length > 0 && !globalRecovery.activeFamilies.includes("evenodd")) {
        globalRecovery.activeFamilies.push("evenodd");
      }
      // Sync digit-agent global flag → switches digit-probability to OVER 4 / UNDER 5
      setGlobalDigitRecovery(true, globalRecovery.unrecoveredAmount);
      logger.info({
        symbol: bestMarket.symbol,
        family: lostFamily,
        lostAmount,
        totalUnrecovered: globalRecovery.unrecoveredAmount,
      }, "Recovery mode ACTIVE — OVER 4 / UNDER 5, 1.15× stake until losses recovered");
      broadcastSSE("recovery_active", {
        symbol: bestMarket.symbol,
        lostAmount,
        totalUnrecoveredAmount: globalRecovery.unrecoveredAmount,
        activeFamilies: globalRecovery.activeFamilies,
        mode: { overunder: "OVER 4 / UNDER 5", direction: "1.15× stake", evenodd: "1.15× stake" },
      });
    }

    tradesExecutedToday++;
    lastTradeTime = new Date();

    broadcastSSE("trade_completed", {
      symbol: bestMarket.symbol, won, profit: profit.toFixed(2),
      contract: effectiveContractType,
      barrier: barrierToStore,
      stake,
      live: !!token && !paperTradeMode,
      paper: paperTradeMode,
      ev: analysis.expectedValue,
      regime: output.regime,
    });
    // Force-refresh the Deriv journal immediately so dashboard stats update right away
    if (!paperTradeMode && token) journalManager.forceRefresh();
    logger.info({
      symbol: bestMarket.symbol, won, profit: profit.toFixed(2),
      stake, ev: analysis.expectedValue,
      contract: effectiveContractType,
    }, "Trade executed");

  } catch (err) {
    logger.error({ err }, "Autonomous loop error");
  } finally {
    // Always release the lock so the loop can run again
    isLoopRunning = false;
  }

  // After a live trade completes, wait before next scan so Deriv can journal the
  // closed trade. The lastTradeCompletedAt guard inside the loop also enforces this.
  scheduleNext(true);
}

function scheduleNext(tradeExecuted = false, overrideDelayMs?: number) {
  if (!engineRunning) return;
  // Clear any pending timer before scheduling a new one (prevents double-fires)
  if (autonomousTimer) { clearTimeout(autonomousTimer); autonomousTimer = null; }
  // 15s after a trade (gives Deriv journal time to record the closed trade),
  // 500ms when rescanning for opportunity, 3s between normal scans
  const delayMs = overrideDelayMs ?? (tradeExecuted ? 15_000 : 3000);
  nextScanIn = Math.ceil(delayMs / 1000);
  loopIntervalSec = nextScanIn;
  autonomousTimer = setTimeout(runAutonomousLoop, delayMs);
}

// ── Helper: build recommendation payload for /recommendation route ─────────────
async function buildRecommendationPayload(symbol: string, market: ReturnType<typeof getMarketInfo>, balance: number, settings: any, preferredContractTypes: string[], token: string | null, currency: string) {
  if (!market) return null;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayTrades = await db.select().from(tradesTable).where(sql`${tradesTable.createdAt} >= ${today}`);
  const closedToday = todayTrades.filter((t) => t.status === "won" || t.status === "lost");
  const sortedByTime = [...closedToday].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  let consecutiveLosses = 0;
  for (const t of sortedByTime) { if (t.status === "lost") consecutiveLosses++; else break; }

  const tradingSettings = buildTradingSettings(settings, preferredContractTypes);
  const daily = buildDailyStats(closedToday, consecutiveLosses);
  const ctx = buildScanContext(market, balance, tradingSettings, daily, token, currency);
  const output = await runCoordinator(ctx);
  const analysis = buildLegacyAnalysis(output);

  const prices = ctx.prices;
  const trendStats = analyzeTrend(prices);
  const digits = market.digitEnabled ? tickManager.getDigits(symbol, 100) : [];
  const liveDigitStats = digits.length > 10 ? analyzeDigits(digits) : null;

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
    tickWindow: null,
    riskScore: analysis.riskScore,
    profitability: analysis.profitability,
    agentScores: analysis.agentScores,
    shouldTrade: analysis.shouldTrade,
    reasoning: analysis.reasoning,
    warnings: analysis.warnings,
    suggestedContractTypes: analysis.suggestedContractTypes,
    digitStats: liveDigitStats ?? analysis.digitStats ?? null,
    digitBarrier: analysis.digitBarrier ?? null,
    trendStats,
    regime: output.regime,
    agentOutputs: output.agents,
    generatedAt: new Date().toISOString(),
  };
}

// ── Fast agent score computation for engine status ────────────────────────────
async function getComputedAgentScores(): Promise<Record<string, number>> {
  if (Object.keys(lastAgentScores).length > 0) return lastAgentScores;
  // Quick scan on the best-buffered market
  const candidateSymbols = ["1HZ100V", "R_100", "R_50", "R_25", "R_10"];
  const best = candidateSymbols
    .map((s) => ({ symbol: s, count: tickManager.getTicks(s, 100).length }))
    .filter((x) => x.count >= 5)
    .sort((a, b) => b.count - a.count)[0];
  if (!best) return {};
  const mInfo = getMarketInfo(best.symbol);
  if (!mInfo) return {};

  try {
    const ctx: ScanContext = {
      symbol: mInfo.symbol,
      displayName: mInfo.displayName,
      category: mInfo.category,
      prices: tickManager.getTicks(mInfo.symbol, 100),
      digits: mInfo.digitEnabled ? tickManager.getDigits(mInfo.symbol, 100) : [],
      balance: 10000,
      settings: buildTradingSettings(null, ["CALL", "PUT", "DIGITOVER", "DIGITUNDER"]),
      daily: { tradesCount: 0, wins: 0, losses: 0, profit: 0, consecutiveLosses: 0, consecutiveWins: 0 },
      token: null,
      currency: "USD",
    };
    const output = await runCoordinator(ctx);
    return Object.fromEntries(
      AGENT_SCORE_KEYS.map((k) => [k, output.agents[k]?.score ?? 65])
    );
  } catch { return {}; }
}

// ── Routes ─────────────────────────────────────────────────────────────────────

router.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  addSSEClient(res);
  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, liveTickCount: tickManager.getLiveTickCount(), connected: tickManager.getConnectionStatus() })}\n\n`);

  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
  }, 25000);

  req.on("close", () => { clearInterval(heartbeat); removeSSEClient(res); });
});

router.get("/recommendation", async (_req, res): Promise<void> => {
  const { balance, settings, account } = await getAccountAndSettings();
  const token = getCachedToken() ?? account?.token ?? null;
  const rawPreferred2 = settings?.preferredContractTypes?.split(",").filter(Boolean) ?? ["CALL", "PUT", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD"];
  const preferredContractTypes = rawPreferred2.map((t: string) => t === "RISE" ? "CALL" : t === "FALL" ? "PUT" : t).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);

  const allowedSymbols = (settings as any)?.allowedMarkets
    ? ((settings as any).allowedMarkets as string).split(",").filter(Boolean)
    : null;
  const marketsToScan = allowedSymbols && allowedSymbols.length > 0
    ? DERIV_MARKETS.filter((m) => allowedSymbols.includes(m.symbol))
    : DERIV_MARKETS;

  const results = await Promise.all(
    marketsToScan.map((m) => buildRecommendationPayload(m.symbol, m, balance, settings, preferredContractTypes, token, account?.currency ?? "USD"))
  );

  const valid = results.filter(Boolean) as NonNullable<typeof results[0]>[];
  valid.sort((a, b) => (b?.expectedValue ?? 0) - (a?.expectedValue ?? 0));
  const best = valid[0];
  if (!best) { res.status(404).json({ error: "No markets available" }); return; }
  res.json(best);
});

router.get("/recommendation/:symbol", async (req, res): Promise<void> => {
  const { symbol } = req.params;
  const market = getMarketInfo(symbol);
  if (!market) { res.status(404).json({ error: "Market not found" }); return; }

  const { balance, settings, account } = await getAccountAndSettings();
  const token = getCachedToken() ?? account?.token ?? null;
  const rawPreferred3 = settings?.preferredContractTypes?.split(",").filter(Boolean) ?? ["CALL", "PUT", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD"];
  const preferredContractTypes = rawPreferred3.map((t: string) => t === "RISE" ? "CALL" : t === "FALL" ? "PUT" : t).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);

  const payload = await buildRecommendationPayload(symbol, market, balance, settings, preferredContractTypes, token, account?.currency ?? "USD");
  if (!payload) { res.status(500).json({ error: "Analysis failed" }); return; }
  res.json(payload);
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
  let currentConsecLosses = 0;
  for (const t of sorted) { if (t.status === "lost") currentConsecLosses++; else break; }

  const highConf = trades.filter((t) => Number(t.aiConfidence ?? 0) >= 65);
  const highConfWinRate = highConf.length > 0 ? highConf.filter((t) => t.status === "won").length / highConf.length : 0;
  const lowConf = trades.filter((t) => Number(t.aiConfidence ?? 0) < 65);
  const lowConfWinRate = lowConf.length > 0 ? lowConf.filter((t) => t.status === "won").length / lowConf.length : 0;

  const digitTrades = trades.filter((t) => t.contractType.includes("DIGIT"));
  const digitWinRate = digitTrades.length > 0 ? digitTrades.filter((t) => t.status === "won").length / digitTrades.length : 0;
  const riseFallTrades = trades.filter((t) => ["RISE", "FALL", "CALL", "PUT"].includes(t.contractType));
  const riseFallWinRate = riseFallTrades.length > 0 ? riseFallTrades.filter((t) => t.status === "won").length / riseFallTrades.length : 0;

  const liveStatus = `Deriv WS ${tickManager.getConnectionStatus() ? "connected" : "disconnected"} — ${tickManager.getLiveTickCount()} ticks buffered`;
  const insights = [];

  if (trades.length === 0) {
    insights.push({ id: 1, type: "improvement", title: "Start Trading to Build AI Insights", description: `${liveStatus}. Start the autonomous engine to begin generating personalized trade analysis.`, priority: "medium", actionable: true, relatedMarket: null });
  } else {
    insights.push({ id: 1, type: "pattern", title: `${(winRate * 100).toFixed(1)}% win rate — ${trades.length} total trades`, description: `Won: ${won.length}, Lost: ${lost.length}. Avg P&L: ${avgProfit >= 0 ? "+" : ""}$${avgProfit.toFixed(2)}. ${winRate > 0.55 ? "You have a profitable edge." : winRate > 0.45 ? "Near break-even — review confidence threshold." : "Below break-even — review settings."}`, priority: winRate > 0.55 ? "low" : "high", actionable: winRate <= 0.55, relatedMarket: null });

    if (digitTrades.length > 5 && riseFallTrades.length > 5) {
      const betterType = digitWinRate > riseFallWinRate ? "DIGIT OVER/UNDER" : "Rise/Fall";
      insights.push({ id: 2, type: "pattern", title: `${betterType} contracts outperforming`, description: `DIGIT: ${(digitWinRate * 100).toFixed(1)}% WR. Rise/Fall: ${(riseFallWinRate * 100).toFixed(1)}%. Adjust preferred contract types in Settings.`, priority: Math.abs(digitWinRate - riseFallWinRate) > 0.1 ? "high" : "medium", actionable: true, relatedMarket: null });
    }

    if (bestMarket) {
      insights.push({ id: 3, type: "milestone", title: `Best market: ${bestMarket[0]} at ${((bestMarket[1].won / bestMarket[1].total) * 100).toFixed(0)}% win rate`, description: `${bestMarket[1].won}/${bestMarket[1].total} wins, $${bestMarket[1].profit.toFixed(2)} profit.`, priority: "low", actionable: false, relatedMarket: bestMarket[0] });
    }

    if (currentConsecLosses >= 2) {
      insights.push({ id: 4, type: "warning", title: `⚠ Active losing streak: ${currentConsecLosses} consecutive losses`, description: `Consider pausing the engine. The Risk Manager will automatically reduce stakes as losses accumulate.`, priority: currentConsecLosses >= 3 ? "high" : "medium", actionable: true, relatedMarket: null });
    }

    if (highConf.length > 3 && lowConf.length > 3) {
      insights.push({ id: 5, type: "improvement", title: `High-confidence trades: ${(highConfWinRate * 100).toFixed(1)}% vs low-confidence: ${(lowConfWinRate * 100).toFixed(1)}%`, description: highConfWinRate > lowConfWinRate + 0.05 ? "Raise confidence threshold to 65+ for better results." : "Your confidence threshold is well-calibrated.", priority: highConfWinRate > lowConfWinRate + 0.1 ? "high" : "low", actionable: highConfWinRate > lowConfWinRate + 0.05, relatedMarket: null });
    }

    if (worstMarket && worstMarket[1].total >= 3 && worstMarket[1].won / worstMarket[1].total < 0.4) {
      insights.push({ id: 6, type: "warning", title: `Avoid ${worstMarket[0]}: ${((worstMarket[1].won / worstMarket[1].total) * 100).toFixed(0)}% win rate`, description: `Only ${worstMarket[1].won}/${worstMarket[1].total} wins. Consider removing from allowed markets in Settings.`, priority: "medium", actionable: true, relatedMarket: worstMarket[0] });
    }
  }

  res.json(insights);
});

router.get("/engine/status", async (_req, res): Promise<void> => {
  const settings = await db.select().from(settingsTable).limit(1);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayTrades = await db.select().from(tradesTable).where(sql`${tradesTable.createdAt} >= ${today}`);
  const liveScores = await getComputedAgentScores();

  res.json({
    isRunning: engineRunning, mode: engineRunning ? "autonomous" : "manual",
    agentStatuses: AGENT_NAMES.map((name, i) => {
      const key = AGENT_SCORE_KEYS[i] ?? "featureEngineering";
      const score = liveScores[key] ?? 65;
      return {
        name,
        isActive: true,
        lastRun: new Date().toISOString(),
        confidence: score,
      };
    }),
    tradesExecutedToday: todayTrades.length,
    currentMarket, nextScanIn: engineRunning ? nextScanIn : null, stopReasons, loopIntervalSec,
    lastTradeTime: lastTradeTime?.toISOString() ?? null,
    wsConnected: tickManager.getConnectionStatus(),
    liveTickCount: tickManager.getLiveTickCount(),
    tickHealth: tickManager.getTickHealth(),
    paperTradeMode: settings.length > 0 ? (settings[0] as any).paperTradeMode ?? false : false,
    requirePositiveEv: settings.length > 0 ? (settings[0] as any).requirePositiveEv ?? true : true,
    cooldownUntil: cooldownUntil?.toISOString() ?? null,
    sessionLossCount,
    consecutiveLossLimit: settings.length > 0 ? (settings[0].consecutiveLossLimit ?? 3) : 3,
    marketsScanned: DERIV_MARKETS.length,
    recoveryMode: {
      isActive: globalRecovery.isActive,
      unrecoveredAmount: globalRecovery.unrecoveredAmount,
      activeFamilies: globalRecovery.activeFamilies,
      recoveryLossCount: globalRecovery.recoveryLossCount,
    },
  });
});

router.post("/engine/toggle", async (req, res): Promise<void> => {
  const parseResult = ToggleAutonomousEngineBody.safeParse(req.body);
  if (!parseResult.success) { res.status(400).json({ error: "Invalid request" }); return; }
  const { running } = parseResult.data;

  const settings = await db.select().from(settingsTable).limit(1);
  if (settings.length > 0 && settings[0].loopIntervalSec) loopIntervalSec = settings[0].loopIntervalSec;

  if (running) {
    // Clear any active cooldown when manually starting
    if (cooldownResumeTimer) { clearTimeout(cooldownResumeTimer); cooldownResumeTimer = null; }
    cooldownUntil = null;
    engineRunning = true; autonomousMode = "autonomous"; stopReasons = []; nextScanIn = loopIntervalSec;
    exploitSymbol = null; exploitCount = 0;
    // Reset recovery state when engine is manually (re)started
    globalRecovery = { isActive: false, unrecoveredAmount: 0, activeFamilies: [], recoveredFamilies: [], recoveryLossCount: 0 };
    setGlobalDigitRecovery(false, 0);
    // Reset group cursors → scanning restarts from V10 1s / V10 / JD10 / RDBULL
    groupCursors.fill(0);
    if (settings.length > 0) await db.update(settingsTable).set({ autonomousEnabled: true });
    if (autonomousTimer) { clearTimeout(autonomousTimer); autonomousTimer = null; }
    autonomousTimer = setTimeout(runAutonomousLoop, 2000);
    logger.info({ loopIntervalSec }, "Autonomous engine started");
  } else {
    engineRunning = false; autonomousMode = "manual"; currentMarket = null; nextScanIn = null;
    exploitSymbol = null; lastAgentScores = {};
    if (autonomousTimer) { clearTimeout(autonomousTimer); autonomousTimer = null; }
    if (cooldownResumeTimer) { clearTimeout(cooldownResumeTimer); cooldownResumeTimer = null; }
    cooldownUntil = null;
    if (settings.length > 0) await db.update(settingsTable).set({ autonomousEnabled: false });
  }

  const toggleScores = await getComputedAgentScores();
  res.json({
    isRunning: engineRunning, mode: autonomousMode,
    agentStatuses: AGENT_NAMES.map((name, i) => {
      const key = AGENT_SCORE_KEYS[i] ?? "featureEngineering";
      const score = toggleScores[key] ?? 65;
      return { name, isActive: true, lastRun: new Date().toISOString(), confidence: score };
    }),
    tradesExecutedToday, currentMarket, nextScanIn, stopReasons, loopIntervalSec,
    lastTradeTime: lastTradeTime?.toISOString() ?? null,
    wsConnected: tickManager.getConnectionStatus(),
    liveTickCount: tickManager.getLiveTickCount(),
    tickHealth: tickManager.getTickHealth(),
    paperTradeMode: settings.length > 0 ? (settings[0] as any).paperTradeMode ?? false : false,
    requirePositiveEv: settings.length > 0 ? (settings[0] as any).requirePositiveEv ?? true : true,
    cooldownUntil: null,
    sessionLossCount,
    consecutiveLossLimit: settings.length > 0 ? (settings[0].consecutiveLossLimit ?? 3) : 3,
    marketsScanned: DERIV_MARKETS.length,
    recoveryMode: {
      isActive: globalRecovery.isActive,
      unrecoveredAmount: globalRecovery.unrecoveredAmount,
      activeFamilies: globalRecovery.activeFamilies,
      recoveryLossCount: globalRecovery.recoveryLossCount,
    },
  });
});

export default router;
