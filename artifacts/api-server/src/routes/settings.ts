import { Router } from "express";
import { db } from "@workspace/db";
import { settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { UpdateSettingsBody } from "@workspace/api-zod";

const router = Router();

async function getOrCreateSettings() {
  const existing = await db.select().from(settingsTable).limit(1);
  if (existing.length > 0) return existing[0];
  const [created] = await db.insert(settingsTable).values({}).returning();
  return created;
}

function formatSettings(s: typeof settingsTable.$inferSelect) {
  return {
    id: s.id,
    riskProfile: s.riskProfile,
    maxRiskPerTrade: Number(s.maxRiskPerTrade),
    dailyTarget: Number(s.dailyTarget),
    dailyLossLimit: Number(s.dailyLossLimit),
    maxDrawdown: Number(s.maxDrawdown),
    consecutiveLossLimit: s.consecutiveLossLimit,
    minConfidenceThreshold: Number(s.minConfidenceThreshold),
    marketRotationAfter: s.marketRotationAfter,
    preferredContractTypes: s.preferredContractTypes.split(",").filter(Boolean),
    preferredCategories: s.preferredCategories.split(",").filter(Boolean),
    allowedMarkets: s.allowedMarkets ? s.allowedMarkets.split(",").filter(Boolean) : [],
    autonomousEnabled: s.autonomousEnabled,
    loopIntervalSec: s.loopIntervalSec,
    recoveryMode: s.recoveryMode,
    recoveryMultiplier: Number(s.recoveryMultiplier),
    maxRecoverySteps: s.maxRecoverySteps,
    scanAllMarkets: s.scanAllMarkets,
    tradeDurationSec: s.tradeDurationSec,
    maxTradeStake: Number(s.maxTradeStake),
    paperTradeMode: (s as { paperTradeMode?: boolean }).paperTradeMode ?? false,
    requirePositiveEv: (s as { requirePositiveEv?: boolean }).requirePositiveEv ?? true,
  };
}

router.get("/", async (_req, res): Promise<void> => {
  const settings = await getOrCreateSettings();
  res.json(formatSettings(settings));
});

router.put("/", async (req, res): Promise<void> => {
  const parseResult = UpdateSettingsBody.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: "Invalid settings" });
    return;
  }

  const settings = await getOrCreateSettings();
  const updates = parseResult.data;

  const updateData: Partial<typeof settingsTable.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (updates.riskProfile !== undefined) updateData.riskProfile = updates.riskProfile;
  if (updates.maxRiskPerTrade !== undefined) updateData.maxRiskPerTrade = String(updates.maxRiskPerTrade);
  if (updates.dailyTarget !== undefined) updateData.dailyTarget = String(updates.dailyTarget);
  if (updates.dailyLossLimit !== undefined) updateData.dailyLossLimit = String(updates.dailyLossLimit);
  if (updates.maxDrawdown !== undefined) updateData.maxDrawdown = String(updates.maxDrawdown);
  if (updates.consecutiveLossLimit !== undefined) updateData.consecutiveLossLimit = updates.consecutiveLossLimit;
  if (updates.minConfidenceThreshold !== undefined) updateData.minConfidenceThreshold = String(updates.minConfidenceThreshold);
  if (updates.marketRotationAfter !== undefined) updateData.marketRotationAfter = updates.marketRotationAfter;
  if (updates.preferredContractTypes !== undefined) updateData.preferredContractTypes = updates.preferredContractTypes.join(",");
  if (updates.preferredCategories !== undefined) updateData.preferredCategories = updates.preferredCategories.join(",");
  if (updates.autonomousEnabled !== undefined) updateData.autonomousEnabled = updates.autonomousEnabled;
  if ((updates as any).allowedMarkets !== undefined) {
    const am = (updates as any).allowedMarkets;
    updateData.allowedMarkets = Array.isArray(am) ? am.join(",") : (am ?? "");
  }
  if ((updates as any).loopIntervalSec !== undefined) updateData.loopIntervalSec = (updates as any).loopIntervalSec;
  if ((updates as any).recoveryMode !== undefined) updateData.recoveryMode = (updates as any).recoveryMode;
  if ((updates as any).recoveryMultiplier !== undefined) updateData.recoveryMultiplier = String((updates as any).recoveryMultiplier);
  if ((updates as any).maxRecoverySteps !== undefined) updateData.maxRecoverySteps = (updates as any).maxRecoverySteps;
  if ((updates as any).scanAllMarkets !== undefined) updateData.scanAllMarkets = (updates as any).scanAllMarkets;
  if ((updates as any).tradeDurationSec !== undefined) updateData.tradeDurationSec = (updates as any).tradeDurationSec;
  if ((updates as any).maxTradeStake !== undefined) updateData.maxTradeStake = String((updates as any).maxTradeStake);
  if ((updates as any).paperTradeMode !== undefined) updateData.paperTradeMode = (updates as any).paperTradeMode;
  if ((updates as any).requirePositiveEv !== undefined) updateData.requirePositiveEv = (updates as any).requirePositiveEv;

  const [updated] = await db.update(settingsTable)
    .set(updateData)
    .where(eq(settingsTable.id, settings.id))
    .returning();

  res.json(formatSettings(updated));
});

export default router;
