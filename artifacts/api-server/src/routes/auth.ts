import { Router } from "express";
import { db } from "@workspace/db";
import { accountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { authorizeWithDeriv, setDerivToken, clearDerivToken, getLiveBalance, getCachedToken, invalidateBalanceCache } from "../lib/deriv";
import { ConnectDerivAccountBody } from "@workspace/api-zod";
import { logger } from "../lib/logger";

const router = Router();

// ── Load persisted token on startup ─────────────────────────────────────────
export async function loadPersistedToken() {
  try {
    const accounts = await db.select().from(accountsTable).limit(1);
    if (accounts.length > 0 && accounts[0].token) {
      setDerivToken(accounts[0].token);
      logger.info({ loginId: accounts[0].loginId }, "Loaded persisted Deriv token from DB");
      // Background: try to verify/refresh if account info is incomplete (loginId starts with "pending_")
      if (accounts[0].loginId.startsWith("pending_")) {
        scheduleTokenVerification(accounts[0].token, accounts[0].id);
      }
    }
  } catch (err) {
    logger.warn({ err }, "Failed to load persisted token");
  }
}

// ── Background token verification (after rate-limit-safe connect) ────────────
function scheduleTokenVerification(token: string, accountId: number, delayMs = 15_000) {
  setTimeout(async () => {
    try {
      logger.info("Background: verifying pending Deriv token");
      const info = await authorizeWithDeriv(token);
      const existing = await db.select().from(accountsTable).where(eq(accountsTable.id, accountId)).limit(1);
      if (existing.length === 0) return; // account was disconnected in the meantime

      // Check if another real account already exists (e.g. another connect replaced this one)
      const byLogin = await db.select().from(accountsTable).where(eq(accountsTable.loginId, info.loginid)).limit(1);
      if (byLogin.length > 0 && byLogin[0].id !== accountId) {
        // Remove the pending duplicate
        await db.delete(accountsTable).where(eq(accountsTable.id, accountId));
        return;
      }

      await db.update(accountsTable).set({
        loginId: info.loginid,
        currency: info.currency,
        balance: String(info.balance),
        isVirtual: info.is_virtual === 1,
        email: info.email ?? null,
        fullName: info.fullname ?? null,
        country: info.country ?? null,
        updatedAt: new Date(),
      }).where(eq(accountsTable.id, accountId));
      invalidateBalanceCache();
      logger.info({ loginId: info.loginid }, "Background: token verified and account updated");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("rate limit")) {
        logger.warn("Background: still rate-limited, will retry in 60s");
        scheduleTokenVerification(token, accountId, 60_000);
      } else {
        logger.warn({ err }, "Background: token verification failed — removing invalid token");
        await db.delete(accountsTable).where(eq(accountsTable.id, accountId)).catch(() => {});
        clearDerivToken();
      }
    }
  }, delayMs);
}

router.post("/connect", async (req, res): Promise<void> => {
  const parseResult = ConnectDerivAccountBody.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const token = parseResult.data.token.trim();
  if (!token) {
    res.status(400).json({ error: "API token cannot be empty" });
    return;
  }

  // ── Try live authorization first ─────────────────────────────────────────
  try {
    const accountInfo = await authorizeWithDeriv(token);
    setDerivToken(token);
    invalidateBalanceCache();

    const existing = await db.select().from(accountsTable).where(eq(accountsTable.loginId, accountInfo.loginid));
    let account;
    if (existing.length > 0) {
      const [updated] = await db
        .update(accountsTable)
        .set({
          token,
          balance: String(accountInfo.balance),
          currency: accountInfo.currency,
          email: accountInfo.email ?? null,
          fullName: accountInfo.fullname ?? null,
          country: accountInfo.country ?? null,
          updatedAt: new Date(),
        })
        .where(eq(accountsTable.loginId, accountInfo.loginid))
        .returning();
      account = updated;
    } else {
      // Also clear any pending placeholder rows before inserting
      await db.delete(accountsTable).where(eq(accountsTable.loginId, `pending_${token.slice(-8)}`)).catch(() => {});
      const [created] = await db
        .insert(accountsTable)
        .values({
          loginId: accountInfo.loginid,
          token,
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
    return;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Authorization failed";
    const isRateLimit = msg.toLowerCase().includes("rate limit");

    if (!isRateLimit) {
      // Real auth failure (bad token, network error, etc.) — reject cleanly
      req.log.error({ err }, "Deriv auth failed");
      res.status(400).json({ error: msg });
      return;
    }

    // ── Rate-limited: save token optimistically and verify in background ──
    logger.warn("Deriv rate-limited during connect — saving token for background verification");
  }

  try {
    // Save a placeholder account row so the token is persisted immediately
    setDerivToken(token);
    const pendingLoginId = `pending_${token.slice(-8)}`;

    // Remove any existing pending row first
    await db.delete(accountsTable).where(eq(accountsTable.loginId, pendingLoginId)).catch(() => {});

    const [account] = await db.insert(accountsTable).values({
      loginId: pendingLoginId,
      token,
      currency: "USD",
      balance: "0",
      isVirtual: false,
      email: null,
      fullName: null,
      country: null,
    }).returning();

    // Kick off background verification
    scheduleTokenVerification(token, account.id);

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
      pendingVerification: true,
    });
  } catch (dbErr) {
    logger.error({ err: dbErr }, "Failed to save pending token");
    res.status(500).json({ error: "Failed to save token. Please try again." });
  }
});

function formatAccount(account: { id: number; loginId: string; currency: string; balance: string; isVirtual: boolean; email: string | null; fullName: string | null; country: string | null; connectedAt: Date }, balance?: number) {
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

  // ── Auto-restore: if DB row is missing but token is cached in memory ──────
  if (accounts.length === 0) {
    const cached = getCachedToken();
    if (!cached) {
      res.status(404).json({ error: "No account connected" });
      return;
    }
    try {
      logger.info("Restoring account from cached token");
      const info = await authorizeWithDeriv(cached);
      const [restored] = await db.insert(accountsTable).values({
        loginId: info.loginid,
        token: cached,
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

  // ── Sync live balance (uses 60s cache — no extra WS per poll) ───────────
  if (account.token && !account.loginId.startsWith("pending_")) {
    try {
      const liveBalance = await getLiveBalance(account.token);
      if (liveBalance !== null && Math.abs(liveBalance - Number(account.balance)) > 0.01) {
        await db.update(accountsTable).set({ balance: String(liveBalance), updatedAt: new Date() }).where(eq(accountsTable.id, account.id));
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
