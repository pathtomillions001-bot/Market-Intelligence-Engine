import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { loadPersistedToken } from "./routes/auth";
import { tickManager, DERIV_MARKETS, APP_ID } from "./lib/deriv";

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
// Start persistent Deriv tick subscription for all synthetic markets
tickManager.start(DERIV_MARKETS.map((m) => m.symbol));
logger.info({ count: DERIV_MARKETS.length, appId: APP_ID }, "TickManager starting up");

// Load persisted token so live trading resumes after restart
loadPersistedToken().catch((err) => logger.warn({ err }, "Token load on startup failed"));

export default app;
