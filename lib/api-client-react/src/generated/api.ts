import { useQuery, useMutation, type UseQueryOptions, type UseMutationOptions } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import type {
    DerivAccount, Market, Trade, TradeStats, DailySummary,
    AiEngineStatus, AiInsight, MarketRecommendation, Settings,
    PerformanceAnalytics, DrawdownAnalysis, MarketBreakdown,
    HealthStatus, SuccessResponse, TopMarket,
} from "./api.schemas";

export const useHealthCheck = (options?: {
    query?: Partial<UseQueryOptions<HealthStatus>>;
}) =>
    useQuery<HealthStatus, Error>({
        queryKey: ["health"],
        queryFn: () => customFetch<HealthStatus>("/api/health"),
        ...options?.query,
    });

export const useGetAccount = (options?: {
    query?: Partial<UseQueryOptions<DerivAccount>>;
}) =>
    useQuery<DerivAccount, Error>({
        queryKey: ["account"],
        queryFn: () => customFetch<DerivAccount>("/api/auth/account"),
        ...options?.query,
    });

export const useConnectDerivAccount = (options?: {
    mutation?: UseMutationOptions<DerivAccount, unknown, { data: { token: string } }>;
}) =>
    useMutation<DerivAccount, unknown, { data: { token: string } }>({
        mutationFn: ({ data }) =>
            customFetch<DerivAccount>("/api/auth/connect", {
                method: "POST",
                body: JSON.stringify(data),
            }),
        ...options?.mutation,
    });

export const useDisconnectAccount = (options?: {
    mutation?: UseMutationOptions<SuccessResponse, unknown, void>;
}) =>
    useMutation<SuccessResponse, unknown, void>({
        mutationFn: () =>
            customFetch<SuccessResponse>("/api/auth/disconnect", { method: "POST" }),
        ...options?.mutation,
    });

export const useGetMarkets = (
    params?: { category?: string; limit?: number },
    options?: { query?: Partial<UseQueryOptions<Market[]>> },
) => {
    const qs = new URLSearchParams();
    if (params?.category) qs.set("category", params.category);
    if (params?.limit != null) qs.set("limit", String(params.limit));
    const query = qs.toString();
    return useQuery<Market[], Error>({
        queryKey: ["markets", params],
        queryFn: () => customFetch<Market[]>(`/api/markets${query ? `?${query}` : ""}`),
        ...options?.query,
    });
};

export const useGetTopMarket = (options?: {
    query?: Partial<UseQueryOptions<TopMarket>>;
}) =>
    useQuery<TopMarket, Error>({
        queryKey: ["markets", "top"],
        queryFn: () => customFetch<TopMarket>("/api/markets/top"),
        ...options?.query,
    });

export const useGetMarketDetail = (
    symbol: string,
    options?: { query?: Partial<UseQueryOptions<Market>> },
) =>
    useQuery<Market, Error>({
        queryKey: ["markets", symbol],
        queryFn: () => customFetch<Market>(`/api/markets/${encodeURIComponent(symbol)}`),
        enabled: Boolean(symbol),
        ...options?.query,
    });

export const useGetTrades = (
    params?: { status?: string; market?: string; limit?: number; offset?: number },
    options?: { query?: Partial<UseQueryOptions<Trade[]>> },
) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set("status", params.status);
    if (params?.market) qs.set("market", params.market);
    if (params?.limit != null) qs.set("limit", String(params.limit));
    if (params?.offset != null) qs.set("offset", String(params.offset));
    const query = qs.toString();
    return useQuery<Trade[], Error>({
        queryKey: ["trades", params],
        queryFn: () => customFetch<Trade[]>(`/api/trades${query ? `?${query}` : ""}`),
        ...options?.query,
    });
};

export const useGetTradeStats = (options?: {
    query?: Partial<UseQueryOptions<TradeStats>>;
}) =>
    useQuery<TradeStats, Error>({
        queryKey: ["trades", "stats"],
        queryFn: () => customFetch<TradeStats>("/api/trades/stats"),
        ...options?.query,
    });

export const useGetDailySummary = (options?: {
    query?: Partial<UseQueryOptions<DailySummary>>;
}) =>
    useQuery<DailySummary, Error>({
        queryKey: ["trades", "daily"],
        queryFn: () => customFetch<DailySummary>("/api/trades/daily-summary"),
        ...options?.query,
    });

export const useExecuteTrade = (options?: {
    mutation?: UseMutationOptions<Trade, unknown, {
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
    }>;
}) =>
    useMutation<Trade, unknown, {
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
    }>({
        mutationFn: ({ data }) =>
            customFetch<Trade>("/api/trades", {
                method: "POST",
                body: JSON.stringify(data),
            }),
        ...options?.mutation,
    });

export const useGetPerformanceAnalytics = (
    params?: { period?: string; days?: number },
    options?: { query?: Partial<UseQueryOptions<PerformanceAnalytics>> },
) => {
    const qs = new URLSearchParams();
    if (params?.period) qs.set("period", params.period);
    if (params?.days != null) qs.set("days", String(params.days));
    const query = qs.toString();
    return useQuery<PerformanceAnalytics, Error>({
        queryKey: ["analytics", "performance", params],
        queryFn: () => customFetch<PerformanceAnalytics>(`/api/analytics/performance${query ? `?${query}` : ""}`),
        ...options?.query,
    });
};

export const useGetDrawdownAnalysis = (options?: {
    query?: Partial<UseQueryOptions<DrawdownAnalysis>>;
}) =>
    useQuery<DrawdownAnalysis, Error>({
        queryKey: ["analytics", "drawdown"],
        queryFn: () => customFetch<DrawdownAnalysis>("/api/analytics/drawdown"),
        ...options?.query,
    });

export const useGetMarketBreakdown = (options?: {
    query?: Partial<UseQueryOptions<MarketBreakdown>>;
}) =>
    useQuery<MarketBreakdown, Error>({
        queryKey: ["analytics", "market-breakdown"],
        queryFn: () => customFetch<MarketBreakdown>("/api/analytics/market-breakdown"),
        ...options?.query,
    });

export const useGetAiInsights = (options?: {
    query?: Partial<UseQueryOptions<AiInsight[]>>;
}) =>
    useQuery<AiInsight[], Error>({
        queryKey: ["ai", "insights"],
        queryFn: () => customFetch<AiInsight[]>("/api/ai/insights"),
        ...options?.query,
    });

export const useGetAiEngineStatus = (options?: {
    query?: Partial<UseQueryOptions<AiEngineStatus>>;
}) =>
    useQuery<AiEngineStatus, Error>({
        queryKey: ["ai", "status"],
        queryFn: () => customFetch<AiEngineStatus>("/api/ai/engine/status"),
        ...options?.query,
    });

export const useToggleAutonomousEngine = (options?: {
    mutation?: UseMutationOptions<AiEngineStatus, unknown, {
        data: { running: boolean; preferredContractTypes?: string };
    }>;
}) =>
    useMutation<AiEngineStatus, unknown, {
        data: { running: boolean; preferredContractTypes?: string };
    }>({
        mutationFn: ({ data }) =>
            customFetch<AiEngineStatus>("/api/ai/engine/toggle", {
                method: "POST",
                body: JSON.stringify(data),
            }),
        ...options?.mutation,
    });

export const useGetAiRecommendationForMarket = (
    symbol: string,
    options?: { query?: Partial<UseQueryOptions<MarketRecommendation>> },
) =>
    useQuery<MarketRecommendation, Error>({
        queryKey: ["ai", "recommendation", symbol],
        queryFn: () =>
            customFetch<MarketRecommendation>(`/api/ai/recommendation/${encodeURIComponent(symbol)}`),
        enabled: Boolean(symbol),
        ...options?.query,
    });

export const useGetBestRecommendation = (options?: {
    query?: Partial<UseQueryOptions<MarketRecommendation>>;
}) =>
    useQuery<MarketRecommendation, Error>({
        queryKey: ["ai", "recommendation", "best"],
        queryFn: () => customFetch<MarketRecommendation>("/api/ai/recommendation"),
        ...options?.query,
    });

export const useGetSettings = (options?: {
    query?: Partial<UseQueryOptions<Settings>>;
}) =>
    useQuery<Settings, Error>({
        queryKey: ["settings"],
        queryFn: () => customFetch<Settings>("/api/settings"),
        ...options?.query,
    });

export const useUpdateSettings = (options?: {
    mutation?: UseMutationOptions<Settings, unknown, { data: Partial<Settings> }>;
}) =>
    useMutation<Settings, unknown, { data: Partial<Settings> }>({
        mutationFn: ({ data }) =>
            customFetch<Settings>("/api/settings", {
                method: "PUT",
                body: JSON.stringify(data),
            }),
        ...options?.mutation,
    });
