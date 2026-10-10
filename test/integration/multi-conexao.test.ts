import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { systemClock } from "../../src/clock.ts";
import { openDatabase } from "../../src/db.ts";
import { checkInvariants } from "../../src/invariants.ts";

const THREADS = 6;
const ITERATIONS = 150;
const dir = mkdtempSync(join(tmpdir(), "revisao-multi-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function post(app: ReturnType<typeof createApp>, path: string, body?: unknown) {
  const res = await app.request(path, {
    method: "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as { id: string; version: { id: string } };
}

describe("várias conexões ao mesmo arquivo sqlite", () => {
  it(
    "threads aprovando e enviando versão em paralelo mantêm as invariantes",
    async () => {
      const dbPath = join(dir, "multi.sqlite");
      const db = openDatabase(dbPath); // WAL e busy_timeout ficam ligados em openDatabase
      const app = createApp({ db, clock: systemClock });

      // Poucas entregas, já aprovadas, para as threads disputarem revogação e reaprovação.
      const deliveries: string[] = [];
      const shapes = [["roteiro", "video", "capa", "legenda"], ["video"], ["video", "capa"]];
      for (let i = 0; i < 6; i++) {
        const required = shapes[i % shapes.length];
        const campaign = await post(app, "/campaigns", { name: `c${i}`, required_pieces: required });
        const delivery = await post(app, `/campaigns/${campaign.id}/deliveries`, { creator_id: `criador-${i}` });
        for (const piece of required) {
          const body = piece === "video" ? { url: "https://x/v.mp4", duration_seconds: 20 } : { file_name: "f.pdf" };
          const sent = await post(app, `/deliveries/${delivery.id}/pieces/${piece}/versions`, body);
          await post(app, `/versions/${sent.version.id}/approve`);
        }
        await post(app, `/deliveries/${delivery.id}/approve`);
        deliveries.push(delivery.id);
      }

      const shared = new SharedArrayBuffer(8);
      const flags = new Int32Array(shared);
      const workers = Array.from(
        { length: THREADS },
        () =>
          new Worker(new URL("./workers/actor.ts", import.meta.url), {
            execArgv: ["--import", "tsx"],
            workerData: { dbPath, deliveries, shared, iterations: ITERATIONS },
          }),
      );
      const results = workers.map(
        (w) =>
          new Promise<Record<string, number>>((resolve, reject) => {
            w.once("message", resolve);
            w.once("error", reject);
          }),
      );

      // Espera todas as threads abrirem a conexão e só então solta a barreira.
      while (Atomics.load(flags, 0) < THREADS) Atomics.wait(flags, 0, Atomics.load(flags, 0), 50);
      Atomics.store(flags, 1, 1);
      Atomics.notify(flags, 1);

      const statuses: Record<string, number> = {};
      for (const r of await Promise.all(results)) {
        for (const [k, n] of Object.entries(r)) statuses[k] = (statuses[k] ?? 0) + n;
      }
      await Promise.all(workers.map((w) => w.terminate()));

      // Nenhum 5xx (inclui SQLITE_BUSY que escapasse do busy_timeout).
      expect(Object.keys(statuses).filter((k) => k.startsWith("5"))).toEqual([]);
      const allowed = ["200", "201", "409:versao_desatualizada", "409:transicao_invalida", "422:pecas_pendentes"];
      expect(Object.keys(statuses).filter((k) => !allowed.includes(k))).toEqual([]);

      const { failures, summary } = checkInvariants(db);
      expect(failures).toEqual([]);
      expect(summary.eventos_approval_revoked).toBeGreaterThan(0);
      expect(summary.eventos_delivery_approved).toBeGreaterThan(deliveries.length);
      db.close();
    },
    60_000,
  );
});
