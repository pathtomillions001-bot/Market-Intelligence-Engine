import { pgTable, serial, text, boolean, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const accountsTable = pgTable("accounts", {
  id: serial("id").primaryKey(),
  loginId: text("login_id").notNull().unique(),
  token: text("token").notNull(),
  currency: text("currency").notNull().default("USD"),
  balance: numeric("balance", { precision: 20, scale: 2 }).notNull().default("0"),
  isVirtual: boolean("is_virtual").notNull().default(false),
  email: text("email"),
  fullName: text("full_name"),
  country: text("country"),
  connectedAt: timestamp("connected_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertAccountSchema = createInsertSchema(accountsTable).omit({ id: true });
export type InsertAccount = z.infer<typeof insertAccountSchema>;
export type Account = typeof accountsTable.$inferSelect;
