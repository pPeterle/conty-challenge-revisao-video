import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { systemClock } from "./clock.ts";
import { openDatabase } from "./db.ts";

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DB_PATH ?? "data/revisao.sqlite";

const db = openDatabase(dbPath);
const app = createApp({ db, clock: systemClock });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API de revisão ouvindo em http://localhost:${info.port} (banco: ${dbPath})`);
});
