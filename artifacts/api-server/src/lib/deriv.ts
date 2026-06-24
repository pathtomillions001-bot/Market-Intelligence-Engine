/**
 * Deriv WebSocket Client + Persistent TickManager
 *
 * Architecture:
 *  - DerivTickManager maintains ONE persistent WS connection to Deriv
 *  - Subscribes to ALL synthetic market tick streams at startup
 *  - Buffers last 500 prices + last 300 digits per symbol in memory
 *  - Zero-latency data: no per-request WS opens; served from RAM
 *  - Auto-reconnects with exponential back-off
 *  - Separate one-shot WS connections for trade execution / auth
 */

import WebSocket from "ws";
import { EventEmitter } from "events";
import { logger } from "./logger";

// Deriv public tester app_id=1089 — required for demo API tokens
const rawAppId = process.env["DERIV_APP_ID"] ?? "1089";
export const APP_ID = /^\d+$/.test(rawAppId) ? rawAppId : "1089";
if (APP_ID !== rawAppId) {
  logger.warn({ rawAppId }, "DERIV_APP_ID must be numeric — using 1089");
}
const DERIV_WS_URL = `wss://ws.binaryws.com/websockets/v3?app_id=${APP_ID}`;

// ── Market definitions (synthetics only) ──────────────────────────────────────
export const DERIV_MARKETS = [
  { symbol: "R_10",    displayName: "Volatility 10 Index",       category: "synthetic", pipSize: 3, digitEnabled: true },
  { symbol: "R_25",    displayName: "Volatility 25 Index",       category: "synthetic", pipSize: 3, digitEnabled: true },
  { symbol: "R_50",    displayName: "Volatility 50 Index",       category: "synthetic", pipSize: 4, digitEnabled: true },
  { symbol: "R_75",    displayName: "Volatility 75 Index",       category: "synthetic", pipSize: 4, digitEnabled: true },
  { symbol: "R_100",   displayName: "Volatility 100 Index",      category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "1HZ10V",  displayName: "Volatility 10 (1s) Index",  category: "synthetic", pipSize: 3, digitEnabled: true },
  { symbol: "1HZ25V",  displayName: "Volatility 25 (1s) Index",  category: "synthetic", pipSize: 3, digitEnabled: true },
  { symbol: "1HZ50V",  displayName: "Volatility 50 (1s) Index",  category: "synthetic", pipSize: 4, digitEnabled: true },
  { symbol: "1HZ75V",  displayName: "Volatility 75 (1s) Index",  category: "synthetic", pipSize: 4, digitEnabled: true },
  { symbol: "1HZ100V", displayName: "Volatility 100 (1s) Index", category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "RDBULL",  displayName: "Bull Market Index",         category: "synthetic", pipSize: 4, digitEnabled: false },
  { symbol: "RDBEAR",  displayName: "Bear Market Index",         category: "synthetic", pipSize: 4, digitEnabled: false },
  { symbol: "JD10",    displayName: "Jump 10 Index",             category: "synthetic", pipSize: 3, digitEnabled: true },
  { symbol: "JD25",    displayName: "Jump 25 Index",             category: "synthetic", pipSize: 3, digitEnabled: true },
  { symbol: "JD50",    displayName: "Jump 50 Index",             category: "synthetic", pipSize: 4, digitEnabled: true },
  { symbol: "JD75",    displayName: "Jump 75 Index",             category: "synthetic", pipSize: 4, digitEnabled: true },
  { symbol: "JD100",   displayName: "Jump 100 Index",            category: "synthetic", pipSize: 2, digitEnabled: true },
];

export function getMarketInfo(symbol: string) {
  return DERIV_MARKETS.find((m) => m.symbol === symbol);
}

export function extractLastDigit(price: number, pipSize: number): number {
  // e.g. price=1234.567, pipSize=3 → Math.round(1234.567 * 1000) = 1234567 → 1234567 % 10 = 7
  return Math.round(price * Math.pow(10, pipSize)) % 10;
}

// ── Digit distribution analysis ───────────────────────────────────────────────
export interface DigitStats {
  distribution: { digit: number; count: number; pct: number }[];
  overPct: number;    // P(digit > 5) — recent last 50 ticks
  underPct: number;   // P(digit < 5) — recent last 50 ticks
  fivePct: number;    // P(digit == 5)
  recommendOver: boolean;
  recommendUnder: boolean;
  streakInfo: string;
  hotDigits: number[];   // digits appearing more than expected (>12%)
  coldDigits: number[];  // digits appearing less than expected (<8%)
  bias: "over" | "under" | "neutral";
}

export function analyzeDigits(digits: number[]): DigitStats {
  const window = digits.slice(-100); // use last 100 ticks
  const recent = digits.slice(-20);  // last 20 for streak detection

  const counts = Array(10).fill(0);
  for (const d of window) counts[d]++;
  const total = window.length || 1;

  const distribution = counts.map((count, digit) => ({
    digit,
    count,
    pct: Math.round((count / total) * 100),
  }));

  // Over = digits 6,7,8,9 (40% expected), Under = digits 0,1,2,3,4 (50% expected), Five = 5 (10%)
  const overCount = counts.slice(6).reduce((s, c) => s + c, 0);
  const underCount = counts.slice(0, 5).reduce((s, c) => s + c, 0);
  const fiveCount = counts[5];

  const overPct = Math.round((overCount / total) * 100);
  const underPct = Math.round((underCount / total) * 100);
  const fivePct = Math.round((fiveCount / total) * 100);

  // Recent streak detection (last 20)
  const recentOverCount = recent.filter((d) => d > 5).length;
  const recentUnderCount = recent.filter((d) => d < 5).length;
  const recentOverPct = recent.length > 0 ? (recentOverCount / recent.length) * 100 : 40;
  const recentUnderPct = recent.length > 0 ? (recentUnderCount / recent.length) * 100 : 50;

  const hotDigits = distribution.filter((d) => d.pct > 12).map((d) => d.digit);
  const coldDigits = distribution.filter((d) => d.pct < 8).map((d) => d.digit);

  // Smart signal: if a region (over/under) has been over-represented in LAST 20 ticks,
  // probability suggests it may continue (momentum) OR revert (mean-reversion).
  // Deriv 1s indices are pseudo-random, so mean-reversion is statistically valid.
  let bias: "over" | "under" | "neutral" = "neutral";
  let recommendOver = false;
  let recommendUnder = false;

  // Primary: if RECENT over% >> historical over%, bet OVER continues (momentum)
  // But if RECENT over% is too high (>70%), bet UNDER (over-extended)
  if (recentOverPct > 65) {
    bias = "under"; // momentum over-extended, expect reversion
    recommendUnder = true;
  } else if (recentUnderPct > 65) {
    bias = "over"; // under over-extended, expect reversion
    recommendOver = true;
  } else if (overPct > 45) {
    bias = "over"; // historical over is hot
    recommendOver = true;
  } else if (underPct > 55) {
    bias = "under"; // historical under is hot
    recommendUnder = true;
  } else {
    // Use cold digits logic: if over-digits (6-9) are cold, bet UNDER
    const coldOverDigits = [6, 7, 8, 9].filter((d) => coldDigits.includes(d)).length;
    const coldUnderDigits = [0, 1, 2, 3, 4].filter((d) => coldDigits.includes(d)).length;
    if (coldOverDigits >= 2) { bias = "under"; recommendUnder = true; }
    else if (coldUnderDigits >= 2) { bias = "over"; recommendOver = true; }
  }

  // Streak info for display
  const lastStreak: number[] = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    if (lastStreak.length === 0) { lastStreak.push(recent[i]); continue; }
    if ((recent[i] > 5) === (lastStreak[0] > 5) && recent[i] !== 5) lastStreak.push(recent[i]);
    else break;
  }
  const streakType = lastStreak[0] > 5 ? "OVER" : lastStreak[0] < 5 ? "UNDER" : "FIVE";
  const streakInfo = lastStreak.length >= 3
    ? `${streakType} streak: ${lastStreak.length} consecutive`
    : `No significant streak`;

  return { distribution, overPct, underPct, fivePct, recommendOver, recommendUnder, streakInfo, hotDigits, coldDigits, bias };
}

// ── Persistent Tick Manager ───────────────────────────────────────────────────
const TICK_BUFFER_SIZE = 500;
const DIGIT_BUFFER_SIZE = 300;

export interface TickEvent {
  symbol: string;
  price: number;
  lastDigit: number;
  epoch: number;
}

class DerivTickManager extends EventEmitter {
  private ws: WebSocket | null = null;
  private tickBuffers = new Map<string, number[]>();
  private digitBuffers = new Map<string, number[]>();
  private latestPrices = new Map<string, number>();
  private isConnected = false;
  private reconnectDelay = 3000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscribedSymbols: string[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongTime = Date.now();

  start(symbols: string[]) {
    this.subscribedSymbols = symbols;
    for (const sym of symbols) {
      if (!this.tickBuffers.has(sym)) this.tickBuffers.set(sym, []);
      if (!this.digitBuffers.has(sym)) this.digitBuffers.set(sym, []);
    }
    this.connect();
  }

  private connect() {
    if (this.ws) {
      try { this.ws.terminate(); } catch { /* ignore */ }
    }

    try {
      this.ws = new WebSocket(DERIV_WS_URL);
    } catch (err) {
      logger.warn({ err }, "TickManager: failed to create WebSocket, will retry");
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.isConnected = true;
      this.reconnectDelay = 3000;
      logger.info("TickManager: WebSocket connected to Deriv");
      this.subscribeAll();
      this.startPing();
    });

    this.ws.on("message", (data) => {
      try {
        this.handleMessage(JSON.parse(data.toString()));
      } catch { /* ignore parse errors */ }
    });

    this.ws.on("error", (err) => {
      logger.warn({ msg: (err as Error).message }, "TickManager: WS error");
    });

    this.ws.on("close", () => {
      this.isConnected = false;
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      logger.info("TickManager: WS closed, scheduling reconnect");
      this.scheduleReconnect();
    });
  }

  private subscribeAll() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    for (const symbol of this.subscribedSymbols) {
      this.ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
    }
    logger.info({ count: this.subscribedSymbols.length }, "TickManager: subscribed to all markets");
  }

  private handleMessage(msg: any) {
    if (msg.msg_type === "tick" && msg.tick) {
      const { symbol, quote, epoch } = msg.tick;
      const price = Number(quote);
      const market = getMarketInfo(symbol);
      if (!market) return;

      const lastDigit = market.digitEnabled ? extractLastDigit(price, market.pipSize) : -1;

      // Buffer price
      const prices = this.tickBuffers.get(symbol) ?? [];
      prices.push(price);
      if (prices.length > TICK_BUFFER_SIZE) prices.shift();
      this.tickBuffers.set(symbol, prices);
      this.latestPrices.set(symbol, price);

      // Buffer digit
      if (market.digitEnabled && lastDigit >= 0) {
        const digits = this.digitBuffers.get(symbol) ?? [];
        digits.push(lastDigit);
        if (digits.length > DIGIT_BUFFER_SIZE) digits.shift();
        this.digitBuffers.set(symbol, digits);
      }

      // Emit tick event for SSE broadcast
      this.emit("tick", { symbol, price, lastDigit, epoch } as TickEvent);
    }

    if (msg.msg_type === "ping" || msg.msg_type === "pong") {
      this.lastPongTime = Date.now();
    }

    if (msg.error) {
      logger.warn({ code: msg.error.code, message: msg.error.message }, "TickManager: Deriv error");
      // If authorization error, just warn — we use app_id for public tick data
    }
  }

  private startPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastPongTime > 60000) {
        logger.warn("TickManager: no pong for 60s, reconnecting");
        this.connect();
        return;
      }
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ ping: 1 }));
      }
    }, 30000);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000);
      logger.info({ delay: this.reconnectDelay }, "TickManager: reconnecting");
      this.connect();
    }, this.reconnectDelay);
  }

  getTicks(symbol: string, count = 100): number[] {
    const buf = this.tickBuffers.get(symbol) ?? [];
    if (buf.length >= 5) return buf.slice(-count);
    // Fall back to simulated if no live data yet
    return generateSimulatedPrices(symbol, count);
  }

  getDigits(symbol: string, count = 300): number[] {
    const buf = this.digitBuffers.get(symbol) ?? [];
    return buf.slice(-count);
  }

  getLatestPrice(symbol: string): number | null {
    return this.latestPrices.get(symbol) ?? null;
  }

  getConnectionStatus(): boolean {
    return this.isConnected;
  }

  getLiveTickCount(): number {
    let total = 0;
    for (const [, v] of this.tickBuffers) total += v.length;
    return total;
  }
}

export const tickManager = new DerivTickManager();

// ── Simulated price fallback ──────────────────────────────────────────────────
function generateSimulatedPrices(symbol: string, count: number): number[] {
  const baseMap: Record<string, number> = {
    R_10: 6500, R_25: 3200, R_50: 1850, R_75: 950, R_100: 1200,
    "1HZ10V": 6480, "1HZ25V": 3190, "1HZ50V": 1840, "1HZ75V": 945, "1HZ100V": 1195,
    RDBULL: 3500, RDBEAR: 3500,
    JD10: 4200, JD25: 4300, JD50: 4400, JD75: 4500, JD100: 4600,
  };
  const base = baseMap[symbol] ?? 1000;
  const volPct = symbol.includes("R_100") || symbol.includes("1HZ100") ? 0.008
    : symbol.includes("R_75") || symbol.includes("1HZ75") ? 0.005
    : 0.002;

  const prices: number[] = [base];
  for (let i = 1; i < count; i++) {
    const change = prices[i - 1] * volPct * (Math.random() - 0.5) * 2;
    prices.push(Math.max(prices[i - 1] + change, 0.0001));
  }
  return prices;
}

// ── Legacy getTickHistory shim (uses TickManager buffer + WS fallback) ────────
export async function getTickHistory(symbol: string, count = 50): Promise<number[]> {
  const live = tickManager.getTicks(symbol, count);
  if (live.length >= 5) return live;

  // Direct WS fetch as fallback when tick manager hasn't buffered enough
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(DERIV_WS_URL);
      const timeout = setTimeout(() => {
        ws.close();
        resolve(generateSimulatedPrices(symbol, count));
      }, 4000);

      ws.on("open", () => {
        ws.send(JSON.stringify({ ticks_history: symbol, count, end: "latest", style: "ticks" }));
      });
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.msg_type === "history" && msg.history) {
            clearTimeout(timeout);
            ws.close();
            const prices = msg.history.prices.map(Number);
            // Feed into tick manager buffer
            const market = getMarketInfo(symbol);
            if (market) {
              const buf = prices.slice(-TICK_BUFFER_SIZE) as number[];
              // @ts-ignore — directly seed the buffer
              tickManager["tickBuffers"].set(symbol, buf);
              if (market.digitEnabled) {
                const digits = buf.map((p) => extractLastDigit(p, market.pipSize));
                // @ts-ignore
                tickManager["digitBuffers"].set(symbol, digits.slice(-DIGIT_BUFFER_SIZE));
              }
            }
            resolve(prices);
          }
        } catch { /* ignore */ }
      });
      ws.on("error", () => { clearTimeout(timeout); ws.close(); resolve(generateSimulatedPrices(symbol, count)); });
    } catch {
      resolve(generateSimulatedPrices(symbol, count));
    }
  });
}

// ── Auth / trade execution types ───────────────────────────────────────────────
export interface DerivAccountInfo {
  loginid: string;
  currency: string;
  balance: number;
  is_virtual: number;
  email?: string;
  fullname?: string;
  country?: string;
}

export interface LiveTradeResult {
  contractId: number;
  buyPrice: number;
  entrySpot: number;
  longcode: string;
}

export interface ContractResult {
  contractId: number;
  won: boolean;
  profit: number;
  exitSpot: number;
  sellPrice: number;
  entrySpot: number;
}

let cachedToken: string | null = null;
let cachedAccountInfo: DerivAccountInfo | null = null;

export function setDerivToken(token: string) { cachedToken = token; }
export function clearDerivToken() { cachedToken = null; cachedAccountInfo = null; }
export function getCachedAccountInfo() { return cachedAccountInfo; }
export function getCachedToken() { return cachedToken; }

export async function authorizeWithDeriv(token: string): Promise<DerivAccountInfo> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(DERIV_WS_URL);
    const timeout = setTimeout(() => { ws.close(); reject(new Error("Connection timeout")); }, 15000);

    ws.on("open", () => { ws.send(JSON.stringify({ authorize: token })); });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.error) { clearTimeout(timeout); ws.close(); reject(new Error(msg.error.message)); return; }
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
      } catch { /* ignore */ }
    });
    ws.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

export async function getLiveBalance(token: string): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(DERIV_WS_URL);
      const timeout = setTimeout(() => { ws.close(); resolve(null); }, 8000);
      ws.on("open", () => { ws.send(JSON.stringify({ authorize: token })); });
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.msg_type === "authorize" && msg.authorize) { clearTimeout(timeout); ws.close(); resolve(Number(msg.authorize.balance)); }
          if (msg.error) { clearTimeout(timeout); ws.close(); resolve(null); }
        } catch { /* ignore */ }
      });
      ws.on("error", () => { clearTimeout(timeout); ws.close(); resolve(null); });
    } catch { resolve(null); }
  });
}

export async function executeLiveTrade(token: string, params: {
  symbol: string;
  contractType: string;
  stake: number;
  duration: number;
  durationUnit: string;
  currency: string;
  barrier?: number | string;
}): Promise<LiveTradeResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(DERIV_WS_URL);
    const timeout = setTimeout(() => { ws.close(); reject(new Error("Trade execution timeout")); }, 20000);
    let authorized = false;

    ws.on("open", () => { ws.send(JSON.stringify({ authorize: token })); });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.error) { clearTimeout(timeout); ws.close(); reject(new Error(msg.error.message)); return; }

        if (msg.msg_type === "authorize" && !authorized) {
          authorized = true;
          const buyParams: Record<string, unknown> = {
            amount: params.stake,
            basis: "stake",
            contract_type: params.contractType,
            currency: params.currency,
            duration: params.duration,
            duration_unit: params.durationUnit,
            symbol: params.symbol,
          };
          if (params.barrier !== undefined) buyParams.barrier = String(params.barrier);
          ws.send(JSON.stringify({ buy: "1", price: params.stake, parameters: buyParams }));
        }

        if (msg.msg_type === "buy" && msg.buy) {
          clearTimeout(timeout);
          ws.close();
          resolve({
            contractId: msg.buy.contract_id,
            buyPrice: Number(msg.buy.buy_price),
            entrySpot: Number(msg.buy.start_time),
            longcode: msg.buy.longcode ?? "",
          });
        }
      } catch (e) { logger.error({ e }, "Error parsing Deriv buy response"); }
    });
    ws.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

export async function waitForContractResult(token: string, contractId: number, timeoutMs = 30000): Promise<ContractResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(DERIV_WS_URL);
    const timeout = setTimeout(() => { ws.close(); reject(new Error("Contract result timeout")); }, timeoutMs + 10000);
    let authorized = false;

    ws.on("open", () => { ws.send(JSON.stringify({ authorize: token })); });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.error) { clearTimeout(timeout); ws.close(); reject(new Error(msg.error.message)); return; }

        if (msg.msg_type === "authorize" && !authorized) {
          authorized = true;
          ws.send(JSON.stringify({ proposal_open_contracts: 1, contract_id: contractId, subscribe: 1 }));
        }

        if (msg.msg_type === "proposal_open_contracts" && msg.proposal_open_contracts) {
          const contract = msg.proposal_open_contracts;
          if (contract.is_sold || contract.status === "sold") {
            clearTimeout(timeout);
            ws.close();
            const profit = Number(contract.profit ?? 0);
            resolve({
              contractId,
              won: profit > 0,
              profit,
              exitSpot: Number(contract.exit_tick ?? contract.current_spot ?? 0),
              sellPrice: Number(contract.sell_price ?? 0),
              entrySpot: Number(contract.entry_tick ?? contract.entry_spot ?? 0),
            });
          }
        }
      } catch { /* ignore */ }
    });
    ws.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}
