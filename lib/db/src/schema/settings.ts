import { pgTable, serial, text, boolean, numeric, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const settingsTable = pgTable("settings", {
  id: serial("id").primaryKey(),
  riskProfile: text("risk_profile").notNull().default("moderate"),
  maxRiskPerTrade: numeric("max_risk_per_trade", { precision: 5, scale: 2 }).notNull().default("2"),
  dailyTarget: numeric("daily_target", { precision: 20, scale: 2 }).notNull().default("50"),
  dailyLossLimit: numeric("daily_loss_limit", { precision: 20, scale: 2 }).notNull().default("30"),
  maxDrawdown: numeric("max_drawdown", { precision: 5, scale: 2 }).notNull().default("10"),
  consecutiveLossLimit: integer("consecutive_loss_limit").notNull().default(3),
  minConfidenceThreshold: numeric("min_confidence_threshold", { precision: 5, scale: 2 }).notNull().default("55"),
  marketRotationAfter: integer("market_rotation_after").notNull().default(5),
  preferredContractTypes: text("preferred_contract_types").notNull().default("CALL,PUT,RISE,FALL"),
  preferredCategories: text("preferred_categories").notNull().default("synthetic,forex"),
  allowedMarkets: text("allowed_markets").default(""),
  autonomousEnabled: boolean("autonomous_enabled").notNull().default(false),
  loopIntervalSec: integer("loop_interval_sec").notNull().default(30),
  recoveryMode: boolean("recovery_mode").notNull().default(false),
  recoveryMultiplier: numeric("recovery_multiplier", { precision: 4, scale: 2 }).notNull().default("1.2"),
  maxRecoverySteps: integer("max_recovery_steps").notNull().default(3),
  scanAllMarkets: boolean("scan_all_markets").notNull().default(true),
  tradeDurationSec: integer("trade_duration_sec").notNull().default(5),
  maxTradeStake: numeric("max_trade_stake", { precision: 20, scale: 2 }).notNull().default("500"),
  paperTradeMode: boolean("paper_trade_mode").notNull().default(false),
  requirePositiveEv: boolean("require_positive_ev").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertSettingsSchema = createInsertSchema(settingsTable).omit({ id: true });
export type InsertSettings = z.infer<typeof insertSettingsSchema>;
export type Settings = typeof settingsTable.$inferSelect;
