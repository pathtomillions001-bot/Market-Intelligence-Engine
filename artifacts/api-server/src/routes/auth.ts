import { Router } from "express";
import { db } from "@workspace/db";
import { accountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { authorizeWithDeriv, setDerivToken, clearDerivToken, getCachedAccountInfo } from "../lib/deriv";
import { ConnectDerivAccountBody } from "@workspace/api-zod";

const router = Router();

router.post("/connect", async (req, res): Promise<void> => {
  const parseResult = ConnectDerivAccountBody.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { token } = parseResult.data;

  try {
    const accountInfo = await authorizeWithDeriv(token);
    setDerivToken(token);

    // Upsert account
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
