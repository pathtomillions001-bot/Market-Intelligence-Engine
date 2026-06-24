import { Router } from "express";
import { db } from "@workspace/db";
import { accountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { authorizeWithDeriv, setDerivToken, clearDerivToken, getCachedAccountInfo, getLiveBalance } from "../lib/deriv";
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
    }
  } catch (err) {
    logger.warn({ err }, "Failed to load persisted token");
  }
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

  try {
    const accountInfo = await authorizeWithDeriv(token);
    setDerivToken(token);

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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Authorization failed";
    req.log.error({ err }, "Deriv auth failed");
    res.status(400).json({ error: msg });
  }
});

router.get("/account", async (req, res): Promise<void> => {
  const accounts = await db.select().from(accountsTable).limit(1);
  if (accounts.length === 0) {
    res.status(404).json({ error: "No account connected" });
    return;
  }
  const account = accounts[0];

  // Sync live balance if token is available
  if (account.token) {
    try {
      const liveBalance = await getLiveBalance(account.token);
      if (liveBalance !== null && Math.abs(liveBalance - Number(account.balance)) > 0.01) {
        await db.update(accountsTable).set({ balance: String(liveBalance), updatedAt: new Date() }).where(eq(accountsTable.id, account.id));
        res.json({
          id: account.id,
          loginId: account.loginId,
          currency: account.currency,
          balance: liveBalance,
          isVirtual: account.isVirtual,
          email: account.email,
          fullName: account.fullName,
          country: account.country,
          connectedAt: account.connectedAt.toISOString(),
        });
        return;
      }
    } catch {
      // fall through to cached balance
    }
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
});

router.post("/disconnect", async (_req, res): Promise<void> => {
  clearDerivToken();
  await db.delete(accountsTable);
  res.json({ success: true, message: "Account disconnected" });
});

export default router;
