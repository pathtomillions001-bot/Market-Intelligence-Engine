import WebSocket from "ws";
import { logger } from "./logger";

export interface DerivTickData {
  symbol: string;
  tick: {
    ask: number;
    bid: number;
    epoch: number;
    id: string;
    pip_size: number;
    quote: number;
    symbol: string;
  };
}

export interface DerivAccountInfo {
  loginid: string;
  currency: string;
  balance: number;
  is_virtual: number;
  email?: string;
  fullname?: string;
  country?: string;
}

const DERIV_WS_URL = "wss://ws.binaryws.com/websockets/v3?app_id=1089";

export const DERIV_MARKETS = [
  // Synthetic Indices
  { symbol: "R_10", displayName: "Volatility 10 Index", category: "synthetic" },
  { symbol: "R_25", displayName: "Volatility 25 Index", category: "synthetic" },
  { symbol: "R_50", displayName: "Volatility 50 Index", category: "synthetic" },
  { symbol: "R_75", displayName: "Volatility 75 Index", category: "synthetic" },
  { symbol: "R_100", displayName: "Volatility 100 Index", category: "synthetic" },
  { symbol: "1HZ10V", displayName: "Volatility 10 (1s) Index", category: "synthetic" },
  { symbol: "1HZ25V", displayName: "Volatility 25 (1s) Index", category: "synthetic" },
  { symbol: "1HZ50V", displayName: "Volatility 50 (1s) Index", category: "synthetic" },
  { symbol: "1HZ75V", displayName: "Volatility 75 (1s) Index", category: "synthetic" },
  { symbol: "1HZ100V", displayName: "Volatility 100 (1s) Index", category: "synthetic" },
  { symbol: "RDBULL", displayName: "Bull Market Index", category: "synthetic" },
  { symbol: "RDBEAR", displayName: "Bear Market Index", category: "synthetic" },
  { symbol: "JD10", displayName: "Jump 10 Index", category: "synthetic" },
  { symbol: "JD25", displayName: "Jump 25 Index", category: "synthetic" },
  { symbol: "JD50", displayName: "Jump 50 Index", category: "synthetic" },
  { symbol: "JD75", displayName: "Jump 75 Index", category: "synthetic" },
  { symbol: "JD100", displayName: "Jump 100 Index", category: "synthetic" },
  // Forex
  { symbol: "frxEURUSD", displayName: "EUR/USD", category: "forex" },
  { symbol: "frxGBPUSD", displayName: "GBP/USD", category: "forex" },
  { symbol: "frxUSDJPY", displayName: "USD/JPY", category: "forex" },
  { symbol: "frxAUDUSD", displayName: "AUD/USD", category: "forex" },
  { symbol: "frxUSDCAD", displayName: "USD/CAD", category: "forex" },
  { symbol: "frxUSDCHF", displayName: "USD/CHF", category: "forex" },
  { symbol: "frxGBPJPY", displayName: "GBP/JPY", category: "forex" },
  { symbol: "frxEURGBP", displayName: "EUR/GBP", category: "forex" },
  // Commodities
  { symbol: "frxXAUUSD", displayName: "Gold/USD", category: "commodities" },
  { symbol: "frxXAGUSD", displayName: "Silver/USD", category: "commodities" },
  { symbol: "frxUSOIL", displayName: "US Crude Oil", category: "commodities" },
  { symbol: "frxUKOIL", displayName: "UK Crude Oil", category: "commodities" },
  // Derived (Crash/Boom)
  { symbol: "BOOM1000", displayName: "Boom 1000 Index", category: "derived" },
  { symbol: "BOOM500", displayName: "Boom 500 Index", category: "derived" },
  { symbol: "CRASH1000", displayName: "Crash 1000 Index", category: "derived" },
  { symbol: "CRASH500", displayName: "Crash 500 Index", category: "derived" },
];

let cachedToken: string | null = null;
let cachedAccountInfo: DerivAccountInfo | null = null;

export function setDerivToken(token: string) {
  cachedToken = token;
}

export function clearDerivToken() {
  cachedToken = null;
  cachedAccountInfo = null;
}

export function getCachedAccountInfo() {
  return cachedAccountInfo;
}

export function getCachedToken() {
  return cachedToken;
}

export async function authorizeWithDeriv(token: string): Promise<DerivAccountInfo> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(DERIV_WS_URL);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Connection timeout"));
    }, 15000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ authorize: token }));
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.error) {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(msg.error.message || "Authorization failed"));
          return;
        }
        if (msg.msg_type === "authorize" && msg.authorize) {
          clearTimeout(timeout);
          const info: DerivAccountInfo = {
            loginid: msg.authorize.loginid,
            currency: msg.authorize.currency,
            balance: msg.authorize.balance,
            is_virtual: msg.authorize.is_virtual,
            email: msg.authorize.email,
            fullname: msg.authorize.fullname,
            country: msg.authorize.country,
          };
          cachedAccountInfo = info;
          ws.close();
          resolve(info);
        }
      } catch (e) {
        logger.error({ e }, "Failed to parse Deriv message");
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

export async function getTickHistory(symbol: string, count: number = 50): Promise<number[]> {
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(DERIV_WS_URL);
      const timeout = setTimeout(() => {
        ws.close();
        resolve(generateSimulatedPrices(symbol, count));
      }, 8000);

      ws.on("open", () => {
        ws.send(JSON.stringify({
          ticks_history: symbol,
          count,
          end: "latest",
          style: "ticks",
        }));
      });

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.msg_type === "history" && msg.history) {
            clearTimeout(timeout);
            ws.close();
            resolve(msg.history.prices.map(Number));
          }
        } catch {
          // ignore
        }
      });

      ws.on("error", () => {
        clearTimeout(timeout);
        ws.close();
        resolve(generateSimulatedPrices(symbol, count));
      });
    } catch {
      resolve(generateSimulatedPrices(symbol, count));
    }
  });
}

function generateSimulatedPrices(symbol: string, count: number): number[] {
  const baseMap: Record<string, number> = {
    R_10: 6500, R_25: 3200, R_50: 1850, R_75: 950, R_100: 1200,
    "1HZ10V": 6480, "1HZ25V": 3190, "1HZ50V": 1840, "1HZ75V": 945, "1HZ100V": 1195,
    frxEURUSD: 1.0850, frxGBPUSD: 1.2650, frxUSDJPY: 149.50,
    frxAUDUSD: 0.6580, frxUSDCAD: 1.3600, frxUSDCHF: 0.8920,
    frxXAUUSD: 2050, frxXAGUSD: 24.5, frxUSOIL: 78.5,
    BOOM1000: 5800, BOOM500: 5900, CRASH1000: 6100, CRASH500: 6200,
    RDBULL: 3500, RDBEAR: 3500, JD10: 4200, JD25: 4300, JD50: 4400, JD75: 4500, JD100: 4600,
    frxGBPJPY: 189.5, frxEURGBP: 0.8580, frxUKOIL: 82.3,
  };
  const base = baseMap[symbol] || 1000;
  const volatilityPct = symbol.includes("R_100") || symbol.includes("1HZ100") ? 0.008
    : symbol.includes("R_75") || symbol.includes("1HZ75") ? 0.005
    : symbol.includes("BOOM") || symbol.includes("CRASH") ? 0.003
    : 0.002;

  const prices: number[] = [base];
  for (let i = 1; i < count; i++) {
    const change = prices[i - 1] * volatilityPct * (Math.random() - 0.5) * 2;
    prices.push(Math.max(prices[i - 1] + change, 0.0001));
  }
  return prices;
}
