export interface DerivAccount {
  loginId: string;
  currency: string;
  balance: number;
  accountType: string;
  token?: string | null;
  fullname?: string | null;
  email?: string | null;
  country?: string | null;
  isVirtual?: boolean;
}

export interface Market {
  symbol: string;
  displayName: string;
  category: string;
  qualityScore: number;
  isActive: boolean;
  digitEnabled?: boolean;
  priceHistory: { timestamp: string; price: number }[];
  agentScores?: Record<string, { score: number; weight: number; signal: string; reasoning: string }>;
  recommendation?: any;
}

export interface Trade {
  id: number;
  symbol: string;
  displayName: string;
  contractType: string;
  barrier?: number | null;
  stake: number;
  direction: string;
  status: string;
  payout?: number | null;
  profit?: number | null;
  entryPrice?: number | null;
  exitPrice?: number | null;
  aiConfidence?: number | null;
  aiRiskScore?: number | null;
  isAutonomous: boolean;
  agentReasoning?: string | null;
  duration?: number | null;
  durationUnit?: string | null;
  createdAt: string;
  closedAt?: string | null;
}

export interface TradeStats {
  totalTrades: number;
  wonTrades: number;
  lostTrades: number;
  winRate: number;
  totalProfit: number;
  avgProfit: number;
  bestTrade: number;
  worstTrade: number;
  currentStreak: number;
  longestWinStreak: number;
  longestLoseStreak: number;
}

export interface DailySummary {
  date: string;
  tradesCount: number;
  wonCount: number;
  lostCount: number;
  totalProfit: number;
  dailyTarget: number;
  dailyLossLimit: number;
  targetProgress: number;
  isTargetMet: boolean;
  isLossLimitHit: boolean;
  balanceStart: number;
  balanceNow: number;
}

export interface AiEngineStatus {
  isRunning: boolean;
  mode: string;
  agentStatuses: { name: string; isActive: boolean; lastRun: string | null; confidence: number }[];
  tradesExecutedToday: number;
  currentMarket: string | null;
  nextScanIn: number | null;
  stopReasons: string[];
  loopIntervalSec: number;
  lastTradeTime: string | null;
  exploitSymbol: string | null;
  exploitCount: number;
  recoveryStep: number;
  wsConnected: boolean;
  liveTickCount: number;
  tickHealth: Record<string, any>;
  paperTradeMode: boolean;
  requirePositiveEv: boolean;
}

export interface AiInsight {
  id: number;
  type: string;
  title: string;
  description: string;
  priority: string;
  actionable: boolean;
  relatedMarket: string | null;
}

export interface MarketRecommendation {
  symbol: string;
  displayName: string;
  contractType: string;
  direction: string;
  confidence: number;
  stake: number;
  riskScore: number;
  shouldTrade: boolean;
  reasoning: string;
  warnings: string[];
  [key: string]: any;
}

export interface Settings {
  id: number;
  riskProfile: string;
  maxRiskPerTrade: string;
  dailyTarget: string;
  dailyLossLimit: string;
  maxTradeStake: string;
  minConfidenceThreshold: string;
  tradeDurationSec: number;
  paperTradeMode: boolean;
  requirePositiveEv: boolean;
  drawdownProtection: boolean;
  drawdownThreshold: string;
  consecutiveLossLimit: number;
  marketRotationAfter: number;
  loopIntervalSec: number;
  preferredContractTypes: string;
  allowedMarkets: string;
  recoveryMode: boolean;
  recoveryMultiplier: string;
  maxRecoverySteps: number;
  autonomousEnabled: boolean;
  updatedAt: string;
}

export interface PerformanceAnalytics {
  equityCurve: { date: string; equity: number; profit: number; trades: number }[];
  drawdownCurve: { date: string; drawdown: number; peak: number }[];
  maxDrawdown: number;
  sharpeRatio: number;
  profitFactor: number;
  period: string;
}

export interface DrawdownAnalysis {
  currentDrawdown: number;
  maxDrawdown: number;
  drawdownPeriods: { start: string; end: string; depth: number }[];
  recoveryTime: number | null;
}

export interface MarketBreakdown {
  markets: { symbol: string; displayName: string; trades: number; winRate: number; profit: number }[];
}

export interface HealthStatus {
  status: string;
  uptime: number;
  timestamp: string;
}

export interface SuccessResponse {
  success: boolean;
  message?: string;
}

export interface ApiError {
  error: string;
  message?: string;
}

export interface TopMarket {
  symbol: string;
  displayName: string;
  category: string;
  qualityScore: number;
  recommendation?: any;
}
