import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { execSync } from "child_process";
import { resolve } from "path";
import router from "./routes";
import { logger } from "./lib/logger";
import { loadPersistedToken } from "./routes/auth";
import { tickManager, DERIV_MARKETS, APP_ID } from "./lib/deriv";
import { loadWinRatesFromDb } from "./lib/win-rate-store";
import { loadCalibrationCache } from "./lib/calibration";
import { loadRecoveryStateFromDb } from "./routes/ai";
import { pool } from "@workspace/db";

/** Ensure DB schema is applied — runs drizzle-kit push if tables are missing. */
async function bootstrapDb() {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'settings'`
    );
    if (Number(rows[0].n) > 0) return; // schema already applied
    logger.warn("DB schema missing — running schema push");
    const root = resolve(import.meta.dirname, "../../../../");
    execSync("pnpm --filter @workspace/db run push", { cwd: root, stdio: "inherit" });
    logger.info("DB schema push complete");
  } catch (err) {
    logger.error({ err }, "DB bootstrap failed — continuing, routes will surface errors");
  }
}

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// ── Startup ──────────────────────────────────────────────────────────────────
// Ensure DB schema is applied before anything else touches the database
bootstrapDb().then(() => {
  loadPersistedToken().catch((err) => logger.warn({ err }, "Token load on startup failed"));
  loadWinRatesFromDb().catch((err) => logger.warn({ err }, "Win rate load on startup failed"));
  loadCalibrationCache().catch((err) => logger.warn({ err }, "Calibration load on startup failed"));
  loadRecoveryStateFromDb().catch((err) => logger.warn({ err }, "Recovery state load on startup failed"));
});

// Start persistent Deriv tick subscription for all synthetic markets
tickManager.start(DERIV_MARKETS.map((m) => m.symbol));
logger.info({ count: DERIV_MARKETS.length, appId: APP_ID }, "TickManager starting up");

export default app;
