import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { systemClock } from "./clock.ts";
import { openDatabase } from "./db.ts";
import { createLogger, flushOnShutdown } from "./logger.ts";

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DB_PATH ?? "data/revisao.sqlite";

const logger = createLogger();
const db = openDatabase(dbPath);
const app = createApp({ db, clock: systemClock, logger });

const server = serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port, db: dbPath }, `API de revisão ouvindo em http://localhost:${info.port}`);
});
flushOnShutdown(logger, () => server.close());
