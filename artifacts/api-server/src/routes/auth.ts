import { Router } from "express";
import { db } from "@workspace/db";
import { accountsTable } from "@workspace/db";
import { eq, ne, like } from "drizzle-orm";
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
import { createHash } from "crypto";

const router = Router();

// Rows created with this loginId prefix represent tokens saved locally that have
// NOT yet been verified against Deriv (e.g. Deriv's API was unreachable at
// connect time). They are placeholders until verification succeeds and the real
// Deriv sub-accounts are upserted.
const PENDING_LOGIN_PREFIX = "pending_";

// Cooldown between verification attempts for unverified tokens (avoids spamming
// Deriv's API while it is unreachable — e.g. restricted sandbox egress).
const VERIFY_COOLDOWN_MS = 60_000;
const lastVerifyAttempt = new Map<string, number>();

function isPendingLoginId(loginId: string | null | undefined): boolean {
  return !!loginId && loginId.startsWith(PENDING_LOGIN_PREFIX);
}

function pendingLoginIdFor(token: string): string {
  const hash = createHash("sha256").update(token).digest("hex").slice(0, 12);
  return `${PENDING_LOGIN_PREFIX}${hash}`;
}

/**
 * Save a token locally WITHOUT requiring a successful Deriv round-trip.
 *
 * Used when Deriv's API is unreachable or rejects the token: the credential is
 * persisted (and activated in the module cache) so the user's connection is not
 * silently lost. The row is a placeholder that gets upgraded to the real Deriv
 * sub-accounts as soon as verification succeeds (see enrichPendingAccount).
 */
async function savePendingTokenAccount(token: string): Promise<{
  account: typeof accountsTable.$inferSelect;
  warning: string;
}> {
  const loginId = pendingLoginIdFor(token);
  await db.update(accountsTable).set({ isActive: false });

  const existing = await db.select().from(accountsTable).where(eq(accountsTable.loginId, loginId));
  let row: typeof accountsTable.$inferSelect;
  if (existing.length > 0) {
    const [updated] = await db
      .update(accountsTable)
      .set({
        token,
        bearerToken: token,
        derivAccountId: null,
        isActive: true,
        updatedAt: new Date(),
      })
      .where(eq(accountsTable.loginId, loginId))
      .returning();
    row = updated;
  } else {
    const [created] = await db
      .insert(accountsTable)
      .values({
        loginId,
        token,
        bearerToken: token,
        derivAccountId: null,
        isActive: true,
      })
      .returning();
    row = created;
  }

  setDerivCredentials(token, loginId);

  return {
    account: row,
    warning:
      "Token saved, but Deriv's API could not be reached to verify it. " +
      "Live trading stays in offline/paper mode until verification succeeds.",
  };
}

/**
 * Upsert ALL Deriv sub-accounts discovered for a token, marking only the
 * preferred one active. Returns the DB row of the preferred account.
 */
async function upsertDerivAccounts(
  token: string,
  derivAccounts: Array<{
    account_id: string;
    balance: number;
    currency: string;
    account_type: "demo" | "real";
    status?: string;
  }>,
  preferredAccountId: string,
): Promise<typeof accountsTable.$inferSelect> {
  await db.update(accountsTable).set({ isActive: false });

  let preferredDbAccount: any = null;
  for (const derivAcc of derivAccounts) {
    const isActive = derivAcc.account_id === preferredAccountId;
    const existing = await db.select().from(accountsTable)
      .where(eq(accountsTable.loginId, derivAcc.account_id));

    if (existing.length > 0) {
      const [updated] = await db.update(accountsTable).set({
        bearerToken: token, token: null,
        derivAccountId: derivAcc.account_id,
        currency: derivAcc.currency,
        balance: String(derivAcc.balance),
        isVirtual: derivAcc.account_type === "demo",
        isActive,
        updatedAt: new Date(),
      }).where(eq(accountsTable.loginId, derivAcc.account_id)).returning();
      if (isActive) preferredDbAccount = updated;
    } else {
      const [created] = await db.insert(accountsTable).values({
        loginId: derivAcc.account_id,
        token: null,
        bearerToken: token,
        derivAccountId: derivAcc.account_id,
        currency: derivAcc.currency,
        balance: String(derivAcc.balance),
        isVirtual: derivAcc.account_type === "demo",
        isActive,
      }).returning();
      if (isActive) preferredDbAccount = created;
    }
  }

  // Clean up stale placeholder rows left over from offline connects
  await db.delete(accountsTable).where(like(accountsTable.loginId, `${PENDING_LOGIN_PREFIX}%`));
  return preferredDbAccount;
}

/**
 * Attempt to verify + enrich a saved-but-unverified token. If Deriv's API is
 * reachable and the token is valid, the real sub-accounts are upserted and the
 * placeholder row is replaced. Returns the (possibly upgraded) active account,
 * or null if nothing is connected.
 */
async function enrichPendingAccount(
  token: string,
  placeholderLoginId: string,
): Promise<{ account: any; verificationPending: boolean } | null> {
  const now = Date.now();
  const last = lastVerifyAttempt.get(placeholderLoginId) ?? 0;
  if (now - last < VERIFY_COOLDOWN_MS) return null;
  lastVerifyAttempt.set(placeholderLoginId, now);

  try {
    const derivAccounts = await getDerivAccounts(token);
    if (derivAccounts.length === 0) throw new Error("No trading accounts found for this token");
    const preferred = derivAccounts.find((a) => a.account_type === "real" && a.status === "active")
      ?? derivAccounts[0];
    const account = await upsertDerivAccounts(token, derivAccounts, preferred.account_id);
    setDerivCredentials(token, preferred.account_id);
    logger.info({ placeholderLoginId, active: preferred.account_id }, "Offline token verified — upgraded to live Deriv accounts");
    return { account, verificationPending: false };
  } catch (err) {
    logger.warn({ err, placeholderLoginId }, "Token still unverified — Deriv unreachable or rejected");
    return null;
  }
}


// ── PKCE state store (in-memory, keyed by state param) ──────────────────────
const pendingPkce = new Map<string, { codeVerifier: string; redirectUri: string; expiresAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingPkce) {
    if (v.expiresAt < now) pendingPkce.delete(k);
  }
}, 10 * 60 * 1000);

// ── Load persisted credentials on startup ────────────────────────────────────
export async function loadPersistedToken() {
  try {
    // Prefer the account marked active; fall back to first row
    let accounts = await db.select().from(accountsTable).where(eq(accountsTable.isActive, true)).limit(1);
    if (accounts.length === 0) {
      accounts = await db.select().from(accountsTable).limit(1);
    }
    if (accounts.length > 0) {
      const account = accounts[0];
      const bearer = account.bearerToken;
      const derivAccountId = account.derivAccountId;

      if (bearer && derivAccountId) {
        setDerivCredentials(bearer, derivAccountId);
        logger.info({ loginId: account.loginId }, "Loaded persisted Bearer token + accountId from DB");
      } else if (bearer) {
        setDerivCredentials(bearer, account.loginId);
        logger.info({ loginId: account.loginId }, "Loaded persisted Bearer token from DB (using loginId as accountId)");
      } else if (account.token) {
        setDerivToken(account.token);
        logger.info({ loginId: account.loginId }, "Loaded persisted PAT token from DB");
      }
    }
  } catch (err) {
    logger.warn({ err }, "Failed to load persisted token");
  }
}

// ── Shared account formatter ──────────────────────────────────────────────────
function formatAccount(account: {
  id: number;
  loginId: string;
  currency: string;
  balance: string;
  isVirtual: boolean;
  isActive: boolean;
  email: string | null;
  fullName: string | null;
  country: string | null;
  connectedAt: Date;
}, balance?: number, verificationPending = isPendingLoginId(account.loginId)) {
  return {
    id: account.id,
    loginId: account.loginId,
    currency: account.currency,
    balance: balance ?? Number(account.balance),
    isVirtual: account.isVirtual,
    isActive: account.isActive,
    verificationPending,
    email: account.email,
    fullName: account.fullName,
    country: account.country,
    connectedAt: account.connectedAt.toISOString(),
  };
}

// ── OAuth2 + PKCE initiate ────────────────────────────────────────────────────
router.get("/oauth/initiate", (req, res): void => {
  const { code_challenge, code_challenge_method, redirect_uri, state } = req.query as Record<string, string>;
  const code_verifier = req.query["code_verifier"] as string | undefined;

  if (!code_challenge || !redirect_uri || !state) {
    res.status(400).json({ error: "Missing required OAuth params: code_challenge, redirect_uri, state" });
    return;
  }
  if (!APP_ID) {
    res.status(503).json({ error: "DERIV_APP_ID is not configured on the server." });
    return;
  }

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

  res.json({ url: `${DERIV_AUTH_BASE}/oauth2/auth?${params.toString()}` });
});

// ── OAuth2 + PKCE callback ────────────────────────────────────────────────────
router.post("/oauth/callback", async (req, res): Promise<void> => {
  const { code, state, redirect_uri, code_verifier: bodyVerifier } = req.body as {
    code?: string; state?: string; redirect_uri?: string; code_verifier?: string;
  };

  if (!code) { res.status(400).json({ error: "Missing authorization code" }); return; }

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

  if (!codeVerifier) { res.status(400).json({ error: "PKCE code_verifier not found" }); return; }
  if (!redirectUri) { res.status(400).json({ error: "redirect_uri is required" }); return; }

  try {
    const tokens = await exchangeOAuthCode(code, redirectUri, codeVerifier);
    const bearerToken = tokens.accessToken;
    const refreshToken = tokens.refreshToken;

    // Fetch ALL sub-accounts for this OAuth login
    const derivAccounts = await getDerivAccounts(bearerToken);
    if (derivAccounts.length === 0) {
      res.status(400).json({ error: "No trading accounts found for this Deriv account" });
      return;
    }

    // Pick the preferred (active real) account to mark as active
    const preferred = derivAccounts.find((a) => a.account_type === "real" && a.status === "active") ?? derivAccounts[0];

    // Fetch user profile from the preferred account for email/name/country
    let email: string | null = null;
    let fullName: string | null = null;
    let country: string | null = null;
    try {
      const profileRes = await fetch(`https://oauth.deriv.com/oauth2/user`, {
        headers: { Authorization: `Bearer ${bearerToken}` },
      });
      if (profileRes.ok) {
        const profile = await profileRes.json() as any;
        email = profile.email ?? null;
        fullName = profile.name ?? null;
        country = profile.country ?? null;
      }
    } catch { /* profile fetch is best-effort */ }

    // ── Upsert ALL sub-accounts, marking only the preferred one as active ──
    let preferredDbAccount: any = null;
    for (const derivAcc of derivAccounts) {
      const isActive = derivAcc.account_id === preferred.account_id;
      const existing = await db.select().from(accountsTable).where(eq(accountsTable.loginId, derivAcc.account_id));

      let dbRow;
      if (existing.length > 0) {
        const [updated] = await db
          .update(accountsTable)
          .set({
            bearerToken, refreshToken,
            derivAccountId: derivAcc.account_id,
            currency: derivAcc.currency,
            balance: String(derivAcc.balance),
            isVirtual: derivAcc.account_type === "demo",
            isActive,
            email: isActive ? email : existing[0].email,
            fullName: isActive ? fullName : existing[0].fullName,
            country: isActive ? country : existing[0].country,
            updatedAt: new Date(),
          })
          .where(eq(accountsTable.loginId, derivAcc.account_id))
          .returning();
        dbRow = updated;
      } else {
        const [created] = await db
          .insert(accountsTable)
          .values({
            loginId: derivAcc.account_id,
            token: null,
            bearerToken, refreshToken,
            derivAccountId: derivAcc.account_id,
            currency: derivAcc.currency,
            balance: String(derivAcc.balance),
            isVirtual: derivAcc.account_type === "demo",
            isActive,
            email: isActive ? email : null,
            fullName: isActive ? fullName : null,
            country: isActive ? country : null,
          })
          .returning();
        dbRow = created;
      }
      if (isActive) preferredDbAccount = dbRow;
    }

    // Activate module-level cache with the preferred account
    setDerivCredentials(bearerToken, preferred.account_id);

    logger.info({
      accounts: derivAccounts.map(a => ({ id: a.account_id, type: a.account_type })),
      active: preferred.account_id,
    }, "OAuth login: stored all sub-accounts");

    res.json(formatAccount(preferredDbAccount, preferred.balance));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "OAuth callback failed";
    logger.error({ err }, "OAuth callback error");
    res.status(400).json({ error: msg });
  }
});

// ── Legacy PAT / Bearer token connect ────────────────────────────────────────
/**
 * POST /api/auth/connect
 *
 * Accepts a Deriv Bearer/PAT token. Calls GET /trading/v1/options/accounts to
 * discover ALL sub-accounts (real + demo) associated with this token and stores
 * every one as a separate DB row — identical to the OAuth path — so the account
 * switcher works immediately after connecting with a token.
 *
 * If Deriv's API cannot be reached (network issue, sandbox egress restrictions,
 * etc.), the token is STILL saved locally as an unverified account so the user's
 * connection is never silently lost. It upgrades to the real Deriv sub-accounts
 * automatically as soon as verification succeeds (see GET /api/auth/account).
 */
router.post("/connect", async (req, res): Promise<void> => {
  const parseResult = ConnectDerivAccountBody.safeParse(req.body);
  if (!parseResult.success) { res.status(400).json({ error: "Invalid request body" }); return; }
  const token = parseResult.data.token.trim();
  if (!token) { res.status(400).json({ error: "Token cannot be empty" }); return; }

  try {
    // Fetch ALL sub-accounts for this token (same endpoint as OAuth path)
    let derivAccounts: Awaited<ReturnType<typeof getDerivAccounts>>;
    try {
      derivAccounts = await getDerivAccounts(token);
    } catch (err) {
      // Deriv unreachable / token rejected — persist the token anyway so the
      // user's connection is saved. It will be verified once Deriv is reachable.
      logger.warn({ err }, "Deriv account discovery failed — saving token unverified");
      const { account, warning } = await savePendingTokenAccount(token);
      res.json({
        ...formatAccount(account),
        // surface the underlying reason to the client for diagnostics
        warning,
      });
      return;
    }

    if (derivAccounts.length === 0) {
      // Fallback: try the older authorize path in case the token is a PAT
      // that doesn't work with the REST accounts endpoint
      const accountInfo = await authorizeWithDeriv(token);
      const accountId = accountInfo.loginid;
      await db.update(accountsTable).set({ isActive: false });
      setDerivCredentials(token, accountId);

      const existing = await db.select().from(accountsTable).where(eq(accountsTable.loginId, accountId));
      let account;
      if (existing.length > 0) {
        const [updated] = await db.update(accountsTable).set({
          bearerToken: token, derivAccountId: accountId,
          balance: String(accountInfo.balance), currency: accountInfo.currency,
          isVirtual: accountInfo.is_virtual === 1, isActive: true, updatedAt: new Date(),
        }).where(eq(accountsTable.loginId, accountId)).returning();
        account = updated;
      } else {
        const [created] = await db.insert(accountsTable).values({
          loginId: accountId, token: null, bearerToken: token,
          derivAccountId: accountId, currency: accountInfo.currency,
          balance: String(accountInfo.balance), isVirtual: accountInfo.is_virtual === 1,
          isActive: true, email: accountInfo.email ?? null,
          fullName: accountInfo.fullname ?? null, country: accountInfo.country ?? null,
        }).returning();
        account = created;
      }
      await db.delete(accountsTable).where(like(accountsTable.loginId, `${PENDING_LOGIN_PREFIX}%`));
      res.json(formatAccount(account, accountInfo.balance, false));
      return;
    }

    // Prefer active real account; fall back to first
    const preferred = derivAccounts.find((a) => a.account_type === "real" && a.status === "active")
      ?? derivAccounts[0];

    // Upsert ALL sub-accounts, marking only the preferred one as active
    const preferredDbAccount = await upsertDerivAccounts(token, derivAccounts, preferred.account_id);

    // Activate module-level cache with the preferred account
    setDerivCredentials(token, preferred.account_id);

    logger.info({
      accounts: derivAccounts.map(a => ({ id: a.account_id, type: a.account_type })),
      active: preferred.account_id,
    }, "Token connect: stored all sub-accounts");

    res.json(formatAccount(preferredDbAccount, preferred.balance, false));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Authorization failed";
    logger.error({ err }, "Deriv connect failed");
    // Last-resort: never lose the user's token — persist unverified and let
    // verification happen later.
    try {
      const { account, warning } = await savePendingTokenAccount(token);
      res.json({ ...formatAccount(account), warning });
    } catch (saveErr) {
      logger.error({ err: saveErr }, "Failed to save token even unverified");
      res.status(400).json({ error: msg });
    }
  }
});

// ── GET /api/auth/account — active account ───────────────────────────────────
router.get("/account", async (req, res): Promise<void> => {
  // Load the active account; fall back to first row for backward compat
  let accounts = await db.select().from(accountsTable).where(eq(accountsTable.isActive, true)).limit(1);
  if (accounts.length === 0) {
    accounts = await db.select().from(accountsTable).limit(1);
  }

  if (accounts.length === 0) {
    const cachedToken = getCachedToken();
    const cachedAccountId = getCachedAccountId();
    if (!cachedToken) { res.status(404).json({ error: "No account connected" }); return; }
    try {
      logger.info("Restoring account from cached credentials");
      const info = await authorizeWithDeriv(cachedToken);
      await db.update(accountsTable).set({ isActive: false });
      const [restored] = await db.insert(accountsTable).values({
        loginId: info.loginid,
        token: null,
        bearerToken: cachedToken,
        derivAccountId: cachedAccountId ?? info.loginid,
        currency: info.currency,
        balance: String(info.balance),
        isVirtual: info.is_virtual === 1,
        isActive: true,
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

  // Offline-saved token (placeholder row)? Try to verify it against Deriv and
  // upgrade it to the real sub-accounts. Fails silently (and cheaply) while
  // Deriv's API is unreachable.
  if (isPendingLoginId(account.loginId) && bearerToken) {
    const enriched = await enrichPendingAccount(bearerToken, account.loginId);
    if (enriched) {
      res.json(formatAccount(enriched.account, undefined, enriched.verificationPending));
      return;
    }
    // Still unverified — report the placeholder as-is (verificationPending=true)
    // and skip the live balance refresh below to avoid hammering Deriv.
    res.json(formatAccount(account));
    return;
  }

  if (bearerToken) {
    try {
      const derivAccounts = await getDerivAccounts(bearerToken);
      const match = derivAccounts.find(a => a.account_id === account.derivAccountId) ?? null;
      if (match && Math.abs(match.balance - Number(account.balance)) > 0.01) {
        await db.update(accountsTable)
          .set({ balance: String(match.balance), updatedAt: new Date() })
          .where(eq(accountsTable.id, account.id));
        res.json(formatAccount(account, match.balance));
        return;
      }
    } catch { /* fall through to cached balance */ }
  }

  res.json(formatAccount(account));
});

// ── GET /api/auth/accounts — all linked accounts ─────────────────────────────
router.get("/accounts", async (_req, res): Promise<void> => {
  const accounts = await db.select().from(accountsTable);
  if (accounts.length === 0) {
    res.json([]);
    return;
  }

  // Refresh live balances for all accounts using the shared bearer token
  const bearerToken = accounts[0].bearerToken ?? accounts[0].token;
  let liveBalanceMap = new Map<string, number>();
  if (bearerToken) {
    try {
      const derivAccounts = await getDerivAccounts(bearerToken);
      for (const da of derivAccounts) {
        liveBalanceMap.set(da.account_id, da.balance);
      }
    } catch { /* fall back to cached */ }
  }

  const result = accounts.map(acc => {
    const live = liveBalanceMap.get(acc.derivAccountId ?? acc.loginId);
    return formatAccount(acc, live);
  });

  res.json(result);
});

// ── POST /api/auth/switch-account ─────────────────────────────────────────────
router.post("/switch-account", async (req, res): Promise<void> => {
  const { loginId } = req.body as { loginId?: string };
  if (!loginId) { res.status(400).json({ error: "loginId is required" }); return; }

  const target = await db.select().from(accountsTable).where(eq(accountsTable.loginId, loginId)).limit(1);
  if (target.length === 0) {
    res.status(404).json({ error: `Account ${loginId} not found — connect first` });
    return;
  }

  const targetAccount = target[0];
  const bearerToken = targetAccount.bearerToken ?? targetAccount.token;
  if (!bearerToken) {
    res.status(400).json({ error: "No bearer token for this account" });
    return;
  }

  // Mark all inactive, then mark target active
  await db.update(accountsTable).set({ isActive: false }).where(ne(accountsTable.loginId, loginId));
  const [activated] = await db
    .update(accountsTable)
    .set({ isActive: true, updatedAt: new Date() })
    .where(eq(accountsTable.loginId, loginId))
    .returning();

  // Update module-level cache — this reconnects the trading WS to the new account
  setDerivCredentials(bearerToken, activated.derivAccountId ?? loginId);

  logger.info({ loginId, derivAccountId: activated.derivAccountId, isVirtual: activated.isVirtual },
    "Account switched");

  // Return fresh balance for the activated account
  let balance = Number(activated.balance);
  try {
    const derivAccounts = await getDerivAccounts(bearerToken);
    const match = derivAccounts.find(a => a.account_id === (activated.derivAccountId ?? loginId));
    if (match) {
      balance = match.balance;
      await db.update(accountsTable)
        .set({ balance: String(balance), updatedAt: new Date() })
        .where(eq(accountsTable.id, activated.id));
    }
  } catch { /* use cached */ }

  res.json(formatAccount(activated, balance));
});

// ── POST /api/auth/disconnect ─────────────────────────────────────────────────
router.post("/disconnect", async (_req, res): Promise<void> => {
  clearDerivToken();
  await db.delete(accountsTable);
  res.json({ success: true, message: "Account disconnected" });
});

export default router;
