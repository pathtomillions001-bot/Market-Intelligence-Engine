import { Router } from "express";
import { db } from "@workspace/db";
import { accountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  authorizeWithDeriv,
  setDerivCredentials,
  setDerivToken,
  clearDerivToken,
  getLiveBalance,
  getCachedToken,
  getCachedAccountId,
  exchangeOAuthCode,
  getDerivAccounts,
  DERIV_AUTH_BASE,
  APP_ID,
} from "../lib/deriv";
import { ConnectDerivAccountBody } from "@workspace/api-zod";
import { logger } from "../lib/logger";

const router = Router();

// ── PKCE state store (in-memory, keyed by state param) ──────────────────────
// In production you'd use Redis or a DB; for single-server use this is fine.
const pendingPkce = new Map<string, { codeVerifier: string; redirectUri: string; expiresAt: number }>();

// Clean up expired PKCE entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingPkce) {
    if (v.expiresAt < now) pendingPkce.delete(k);
  }
}, 10 * 60 * 1000);

// ── Load persisted credentials on startup ────────────────────────────────────
export async function loadPersistedToken() {
  try {
    const accounts = await db.select().from(accountsTable).limit(1);
    if (accounts.length > 0) {
      const account = accounts[0];
      const bearer = account.bearerToken;
      const derivAccountId = account.derivAccountId;

      if (bearer && derivAccountId) {
        setDerivCredentials(bearer, derivAccountId);
        logger.info({ loginId: account.loginId }, "Loaded persisted Bearer token + accountId from DB");
      } else if (bearer) {
        // Bearer but no accountId yet — use loginId as accountId fallback
        setDerivCredentials(bearer, account.loginId);
        logger.info({ loginId: account.loginId }, "Loaded persisted Bearer token from DB (using loginId as accountId)");
      } else if (account.token) {
        // Legacy PAT — set token without accountId (market data still works)
        setDerivToken(account.token);
        logger.info({ loginId: account.loginId }, "Loaded persisted PAT token from DB (no accountId — live trading unavailable until OAuth)");
      }
    }
  } catch (err) {
    logger.warn({ err }, "Failed to load persisted token");
  }
}

// ── OAuth2 + PKCE helpers ─────────────────────────────────────────────────────

/**
 * GET /api/auth/oauth/initiate
 *
 * The frontend sends the PKCE code_verifier + code_challenge it generated,
 * plus the redirect_uri where Deriv should send the auth code.
 * We store the verifier server-side (keyed by state) so it can't be tampered
 * with on the client, and return the full authorization URL to redirect to.
 */
router.get("/oauth/initiate", (req, res): void => {
  const { code_challenge, code_challenge_method, redirect_uri, state } = req.query as Record<string, string>;
  const code_verifier = req.query["code_verifier"] as string | undefined;

  if (!code_challenge || !redirect_uri || !state) {
    res.status(400).json({ error: "Missing required OAuth params: code_challenge, redirect_uri, state" });
    return;
  }

  if (!APP_ID) {
    res.status(503).json({ error: "DERIV_APP_ID is not configured on the server. Set it to your alphanumeric Deriv app ID." });
    return;
  }

  // Store PKCE verifier server-side (expires in 10 minutes)
  if (code_verifier) {
    pendingPkce.set(state, {
      codeVerifier: code_verifier,
      redirectUri: redirect_uri,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
  }

  const params = new URLSearchParams({
    response_type: "code",
    client_id: APP_ID,
    redirect_uri,
    scope: "trade",
    state,
    code_challenge,
    code_challenge_method: code_challenge_method ?? "S256",
  });

  const authUrl = `${DERIV_AUTH_BASE}/oauth2/auth?${params.toString()}`;
  res.json({ url: authUrl });
});

/**
 * POST /api/auth/oauth/callback
 *
 * Called by the frontend after Deriv redirects back with `?code=...&state=...`.
 * Exchanges the code for Bearer + refresh tokens, fetches account list, and
 * stores everything in the DB.
 */
router.post("/oauth/callback", async (req, res): Promise<void> => {
  const { code, state, redirect_uri, code_verifier: bodyVerifier } = req.body as {
    code?: string;
    state?: string;
    redirect_uri?: string;
    code_verifier?: string;
  };

  if (!code) {
    res.status(400).json({ error: "Missing authorization code" });
    return;
  }

  // Resolve code_verifier: prefer server-side stored (keyed by state), fall back to body
  let codeVerifier: string | undefined;
  let redirectUri: string | undefined;

  if (state && pendingPkce.has(state)) {
    const pending = pendingPkce.get(state)!;
    codeVerifier = pending.codeVerifier;
    redirectUri = pending.redirectUri;
    pendingPkce.delete(state);
  }

  codeVerifier ??= bodyVerifier;
  redirectUri ??= redirect_uri;

  if (!codeVerifier) {
    res.status(400).json({ error: "PKCE code_verifier not found — did the OAuth flow start correctly?" });
    return;
  }
  if (!redirectUri) {
    res.status(400).json({ error: "redirect_uri is required" });
    return;
  }

  try {
    // Exchange auth code for Bearer + refresh tokens
    const tokens = await exchangeOAuthCode(code, redirectUri, codeVerifier);
    const bearerToken = tokens.accessToken;
    const refreshToken = tokens.refreshToken;

    // Fetch account list with the Bearer token
    const accounts = await getDerivAccounts(bearerToken);
    if (accounts.length === 0) {
      res.status(400).json({ error: "No trading accounts found for this Deriv account" });
      return;
    }

    // Prefer real account; fall back to first available
    const preferred = accounts.find((a) => a.account_type === "real" && a.status === "active") ?? accounts[0];
    const accountId = preferred.account_id;
    const currency = preferred.currency;
    const balance = preferred.balance;
    const isVirtual = preferred.account_type === "demo";

    // Store credentials in module-level cache
    setDerivCredentials(bearerToken, accountId);

    // Upsert in DB
    const existing = await db.select().from(accountsTable).where(eq(accountsTable.loginId, accountId));
    let dbAccount;
    if (existing.length > 0) {
      const [updated] = await db
        .update(accountsTable)
        .set({
          bearerToken,
          refreshToken,
          derivAccountId: accountId,
          // token column left as-is (may be null or old PAT)
          currency,
          balance: String(balance),
          isVirtual,
          updatedAt: new Date(),
        })
        .where(eq(accountsTable.loginId, accountId))
        .returning();
      dbAccount = updated;
    } else {
      const [created] = await db
        .insert(accountsTable)
        .values({
          loginId: accountId,
          token: null,
          bearerToken,
          refreshToken,
          derivAccountId: accountId,
          currency,
          balance: String(balance),
          isVirtual,
        })
        .returning();
      dbAccount = created;
    }

    res.json({
      id: dbAccount.id,
      loginId: dbAccount.loginId,
      currency: dbAccount.currency,
      balance: Number(dbAccount.balance),
      isVirtual: dbAccount.isVirtual,
      email: dbAccount.email,
      fullName: dbAccount.fullName,
      country: dbAccount.country,
      connectedAt: dbAccount.connectedAt.toISOString(),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "OAuth callback failed";
    logger.error({ err }, "OAuth callback error");
    res.status(400).json({ error: msg });
  }
});

// ── Legacy PAT token connect ──────────────────────────────────────────────────
/**
 * POST /api/auth/connect
 *
 * Accepts a Deriv Bearer token (from OAuth) or a legacy PAT.
 * Tries to use it as a Bearer token to call GET /accounts.
 * If that succeeds, stores full credentials. If not, stores the PAT for
 * future upgrade and marks the account as limited.
 */
router.post("/connect", async (req, res): Promise<void> => {
  const parseResult = ConnectDerivAccountBody.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const token = parseResult.data.token.trim();
  if (!token) {
    res.status(400).json({ error: "Token cannot be empty" });
    return;
  }

  try {
    // Try to use the token as a Bearer token for the new REST API
    const accountInfo = await authorizeWithDeriv(token);
    const accountId = accountInfo.loginid;

    setDerivCredentials(token, accountId);

    const existing = await db.select().from(accountsTable).where(eq(accountsTable.loginId, accountId));
    let account;
    if (existing.length > 0) {
      const [updated] = await db
        .update(accountsTable)
        .set({
          bearerToken: token,
          derivAccountId: accountId,
          balance: String(accountInfo.balance),
          currency: accountInfo.currency,
          isVirtual: accountInfo.is_virtual === 1,
          updatedAt: new Date(),
        })
        .where(eq(accountsTable.loginId, accountId))
        .returning();
      account = updated;
    } else {
      const [created] = await db
        .insert(accountsTable)
        .values({
          loginId: accountId,
          token: null,
          bearerToken: token,
          derivAccountId: accountId,
          currency: accountInfo.currency,
          balance: String(accountInfo.balance),
          isVirtual: accountInfo.is_virtual === 1,
          email: accountInfo.email ?? null,
          fullName: accountInfo.fullname ?? null,
          country: accountInfo.country ?? null,
        })
        .returning();
      account = created;
    }

    res.json({
      id: account.id,
      loginId: account.loginId,
      currency: account.currency,
      balance: Number(account.balance),
      isVirtual: account.isVirtual,
      email: account.email,
      fullName: account.fullName,
      country: account.country,
      connectedAt: account.connectedAt.toISOString(),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Authorization failed";
    logger.error({ err }, "Deriv connect failed");
    res.status(400).json({ error: msg });
  }
});

function formatAccount(account: {
  id: number;
  loginId: string;
  currency: string;
  balance: string;
  isVirtual: boolean;
  email: string | null;
  fullName: string | null;
  country: string | null;
  connectedAt: Date;
}, balance?: number) {
  return {
    id: account.id,
    loginId: account.loginId,
    currency: account.currency,
    balance: balance ?? Number(account.balance),
    isVirtual: account.isVirtual,
    email: account.email,
    fullName: account.fullName,
    country: account.country,
    connectedAt: account.connectedAt.toISOString(),
  };
}

router.get("/account", async (req, res): Promise<void> => {
  let accounts = await db.select().from(accountsTable).limit(1);

  if (accounts.length === 0) {
    const cachedToken = getCachedToken();
    const cachedAccountId = getCachedAccountId();
    if (!cachedToken) {
      res.status(404).json({ error: "No account connected" });
      return;
    }
    try {
      logger.info("Restoring account from cached credentials");
      const info = await authorizeWithDeriv(cachedToken);
      const [restored] = await db.insert(accountsTable).values({
        loginId: info.loginid,
        token: null,
        bearerToken: cachedToken,
        derivAccountId: cachedAccountId ?? info.loginid,
        currency: info.currency,
        balance: String(info.balance),
        isVirtual: info.is_virtual === 1,
        email: info.email ?? null,
        fullName: info.fullname ?? null,
        country: info.country ?? null,
      }).returning();
      res.json(formatAccount(restored, info.balance));
      return;
    } catch {
      res.status(404).json({ error: "No account connected" });
      return;
    }
  }

  const account = accounts[0];
  const bearerToken = account.bearerToken ?? account.token;

  // Sync live balance (uses 60s cache — no extra WS per poll)
  if (bearerToken) {
    try {
      const liveBalance = await getLiveBalance(bearerToken);
      if (liveBalance !== null && Math.abs(liveBalance - Number(account.balance)) > 0.01) {
        await db
          .update(accountsTable)
          .set({ balance: String(liveBalance), updatedAt: new Date() })
          .where(eq(accountsTable.id, account.id));
        res.json(formatAccount(account, liveBalance));
        return;
      }
    } catch {
      // fall through to cached balance
    }
  }

  res.json(formatAccount(account));
});

router.post("/disconnect", async (_req, res): Promise<void> => {
  clearDerivToken();
  await db.delete(accountsTable);
  res.json({ success: true, message: "Account disconnected" });
});

export default router;
