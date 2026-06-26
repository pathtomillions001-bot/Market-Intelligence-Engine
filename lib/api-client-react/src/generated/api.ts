import {
  useQuery,
  useMutation,
  type UseQueryOptions,
  type UseMutationOptions,
} from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import type {
  DerivAccount,
  Market,
  Trade,
  TradeStats,
  DailySummary,
  AiEngineStatus,
  AiInsight,
  MarketRecommendation,
  Settings,
  PerformanceAnalytics,
  DrawdownAnalysis,
  MarketBreakdown,
  HealthStatus,
  SuccessResponse,
  TopMarket,
} from "./api.schemas";

const BASE = "/api";

// ── Health ────────────────────────────────────────────────────────────────────
export const useHealthCheck = (options?: { query?: Partial<UseQueryOptions<HealthStatus>> }) =>
  useQuery<HealthStatus>({
    queryKey: ["healthz"],
    queryFn: () => customFetch<HealthStatus>(`${BASE}/healthz`),
    ...options?.query,
  });

// ── Auth ──────────────────────────────────────────────────────────────────────
export const useGetAccount = (options?: { query?: Partial<UseQueryOptions<DerivAccount>> }) =>
  useQuery<DerivAccount>({
    queryKey: ["account"],
    queryFn: () => customFetch<DerivAccount>(`${BASE}/auth/account`),
    retry: false,
    ...options?.query,
  });

export const useConnectDerivAccount = (
  options?: { mutation?: UseMutationOptions<DerivAccount, unknown, { data: { token: string } }> }
) =>
  useMutation<DerivAccount, unknown, { data: { token: string } }>({
    mutationFn: ({ data }) =>
      customFetch<DerivAccount>(`${BASE}/auth/connect`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    ...options?.mutation,
  });

export const useDisconnectAccount = (
  options?: { mutation?: UseMutationOptions<SuccessResponse, unknown, void> }
) =>
  useMutation<SuccessResponse, unknown, void>({
    mutationFn: () =>
      customFetch<SuccessResponse>(`${BASE}/auth/disconnect`, { method: "POST" }),
    ...options?.mutation,
  });

// ── Markets ───────────────────────────────────────────────────────────────────
export const useGetMarkets = (
  params?: { category?: string; limit?: number },
  options?: { query?: Partial<UseQueryOptions<Market[]>> }
) =>
  useQuery<Market[]>({
    queryKey: ["markets", params],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (params?.category) qs.set("category", params.category);
      if (params?.limit != null) qs.set("limit", String(params.limit));
      const q = qs.toString();
      return customFetch<Market[]>(`${BASE}/markets${q ? `?${q}` : ""}`);
    },
    ...options?.query,
  });

export const useGetTopMarket = (options?: { query?: Partial<UseQueryOptions<TopMarket>> }) =>
  useQuery<TopMarket>({
    queryKey: ["top-market"],
    queryFn: () => customFetch<TopMarket>(`${BASE}/markets/top`),
    ...options?.query,
  });

export const useGetMarketDetail = (
  symbol: string,
  options?: { query?: Partial<UseQueryOptions<Market>> }
) =>
  useQuery<Market>({
    queryKey: ["market-detail", symbol],
    queryFn: () => customFetch<Market>(`${BASE}/markets/${symbol}`),
    enabled: !!symbol,
    ...options?.query,
  });

// ── Trades ────────────────────────────────────────────────────────────────────
export const useGetTrades = (
  params?: { status?: string; market?: string; limit?: number; offset?: number },
  options?: { query?: Partial<UseQueryOptions<Trade[]>> }
) =>
  useQuery<Trade[]>({
    queryKey: ["trades", params],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (params?.status) qs.set("status", params.status);
      if (params?.market) qs.set("market", params.market);
      if (params?.limit != null) qs.set("limit", String(params.limit));
      if (params?.offset != null) qs.set("offset", String(params.offset));
      const q = qs.toString();
      return customFetch<Trade[]>(`${BASE}/trades${q ? `?${q}` : ""}`);
    },
    ...options?.query,
  });

export const useGetTradeStats = (options?: { query?: Partial<UseQueryOptions<TradeStats>> }) =>
  useQuery<TradeStats>({
    queryKey: ["trade-stats"],
    queryFn: () => customFetch<TradeStats>(`${BASE}/trades/stats`),
    ...options?.query,
  });

export const useGetDailySummary = (options?: { query?: Partial<UseQueryOptions<DailySummary>> }) =>
  useQuery<DailySummary>({
    queryKey: ["daily-summary"],
    queryFn: () => customFetch<DailySummary>(`${BASE}/trades/daily-summary`),
    ...options?.query,
  });

export const useExecuteTrade = (
  options?: {
    mutation?: UseMutationOptions<
      Trade,
      unknown,
      {
        data: {
          symbol: string;
          contractType: string;
          stake: number;
          direction: "up" | "down";
          barrier?: number | null;
          isAutonomous?: boolean;
          duration?: number;
          durationUnit?: string;
        };
      }
    >;
  }
) =>
  useMutation<Trade, unknown, { data: { symbol: string; contractType: string; stake: number; direction: "up" | "down"; barrier?: number | null; isAutonomous?: boolean; duration?: number; durationUnit?: string } }>({
    mutationFn: ({ data }) =>
      customFetch<Trade>(`${BASE}/trades`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    ...options?.mutation,
  });

// ── Analytics ─────────────────────────────────────────────────────────────────
export const useGetPerformanceAnalytics = (
  params?: { period?: string; days?: number },
  options?: { query?: Partial<UseQueryOptions<PerformanceAnalytics>> }
) =>
  useQuery<PerformanceAnalytics>({
    queryKey: ["performance-analytics", params],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (params?.period) qs.set("period", params.period);
      if (params?.days != null) qs.set("days", String(params.days));
      const q = qs.toString();
      return customFetch<PerformanceAnalytics>(`${BASE}/analytics/performance${q ? `?${q}` : ""}`);
    },
    ...options?.query,
  });

export const useGetDrawdownAnalysis = (options?: { query?: Partial<UseQueryOptions<DrawdownAnalysis>> }) =>
  useQuery<DrawdownAnalysis>({
    queryKey: ["drawdown-analysis"],
    queryFn: () => customFetch<DrawdownAnalysis>(`${BASE}/analytics/drawdown`),
    ...options?.query,
  });

export const useGetMarketBreakdown = (options?: { query?: Partial<UseQueryOptions<MarketBreakdown>> }) =>
  useQuery<MarketBreakdown>({
    queryKey: ["market-breakdown"],
    queryFn: () => customFetch<MarketBreakdown>(`${BASE}/analytics/market-breakdown`),
    ...options?.query,
  });

// ── AI ────────────────────────────────────────────────────────────────────────
export const useGetAiInsights = (options?: { query?: Partial<UseQueryOptions<AiInsight[]>> }) =>
  useQuery<AiInsight[]>({
    queryKey: ["ai-insights"],
    queryFn: () => customFetch<AiInsight[]>(`${BASE}/ai/insights`),
    ...options?.query,
  });

export const useGetAiEngineStatus = (options?: { query?: Partial<UseQueryOptions<AiEngineStatus>> }) =>
  useQuery<AiEngineStatus>({
    queryKey: ["ai-engine-status"],
    queryFn: () => customFetch<AiEngineStatus>(`${BASE}/ai/engine/status`),
    ...options?.query,
  });

export const useToggleAutonomousEngine = (
  options?: {
    mutation?: UseMutationOptions<
      AiEngineStatus,
      unknown,
      { data: { running: boolean; preferredContractTypes?: string } }
    >;
  }
) =>
  useMutation<AiEngineStatus, unknown, { data: { running: boolean; preferredContractTypes?: string } }>({
    mutationFn: ({ data }) =>
      customFetch<AiEngineStatus>(`${BASE}/ai/engine/toggle`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    ...options?.mutation,
  });

export const useGetAiRecommendationForMarket = (
  symbol: string,
  options?: { query?: Partial<UseQueryOptions<MarketRecommendation>> }
) =>
  useQuery<MarketRecommendation>({
    queryKey: ["ai-recommendation", symbol],
    queryFn: () => customFetch<MarketRecommendation>(`${BASE}/ai/recommendation/${symbol}`),
    enabled: !!symbol,
    ...options?.query,
  });

export const useGetBestRecommendation = (options?: { query?: Partial<UseQueryOptions<MarketRecommendation>> }) =>
  useQuery<MarketRecommendation>({
    queryKey: ["best-recommendation"],
    queryFn: () => customFetch<MarketRecommendation>(`${BASE}/ai/recommendation`),
    ...options?.query,
  });

// ── Settings ──────────────────────────────────────────────────────────────────
export const useGetSettings = (options?: { query?: Partial<UseQueryOptions<Settings>> }) =>
  useQuery<Settings>({
    queryKey: ["settings"],
    queryFn: () => customFetch<Settings>(`${BASE}/settings`),
    ...options?.query,
  });

export const useUpdateSettings = (
  options?: { mutation?: UseMutationOptions<Settings, unknown, { data: Partial<Settings> }> }
) =>
  useMutation<Settings, unknown, { data: Partial<Settings> }>({
    mutationFn: ({ data }) =>
      customFetch<Settings>(`${BASE}/settings`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    ...options?.mutation,
  });
