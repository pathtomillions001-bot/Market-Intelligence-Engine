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
  minConfidenceThreshold: numeric("min_confidence_threshold", { precision: 5, scale: 2 }).notNull().default("65"),
  marketRotationAfter: integer("market_rotation_after").notNull().default(3),
  preferredContractTypes: text("preferred_contract_types").notNull().default("CALL,PUT"),
  preferredCategories: text("preferred_categories").notNull().default("synthetic,forex"),
  autonomousEnabled: boolean("autonomous_enabled").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertSettingsSchema = createInsertSchema(settingsTable).omit({ id: true });
export type InsertSettings = z.infer<typeof insertSettingsSchema>;
export type Settings = typeof settingsTable.$inferSelect;
