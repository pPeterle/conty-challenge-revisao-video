// Um "cliente" rodando em outra thread, com a própria conexão sqlite ao mesmo arquivo.
import { parentPort, workerData } from "node:worker_threads";
import { createApp } from "../../../src/app.ts";
import { systemClock } from "../../../src/clock.ts";
import { openDatabase } from "../../../src/db.ts";

interface Input {
  dbPath: string;
  deliveries: string[];
  shared: SharedArrayBuffer;
  iterations: number;
}

const { dbPath, deliveries, shared, iterations } = workerData as Input;
const PIECES = ["roteiro", "video", "capa", "legenda"];
const flags = new Int32Array(shared); // [0] = threads prontas, [1] = largada

const app = createApp({ db: openDatabase(dbPath), clock: systemClock });
const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)];

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

Atomics.add(flags, 0, 1);
Atomics.notify(flags, 0);
Atomics.wait(flags, 1, 0); // barreira: todas as threads saem juntas

const statuses: Record<string, number> = {};
for (let i = 0; i < iterations; i++) {
  const deliveryId = pick(deliveries);
  const roll = Math.random();
  let res: { status: number; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (roll < 0.4) {
    const piece = pick(PIECES);
    res = await call("POST", `/deliveries/${deliveryId}/pieces/${piece}/versions`,
      piece === "video" ? { url: "https://x/v.mp4", duration_seconds: 20 } : { file_name: `${piece}.pdf` });
  } else if (roll < 0.85) {
    const view = await call("GET", `/deliveries/${deliveryId}`);
    const inReview = (view.body.pieces as { current_version: { id: string; status: string } | null }[]).filter(
      (p) => p.current_version?.status === "em_revisao",
    );
    if (inReview.length === 0) continue;
    res = await call("POST", `/versions/${pick(inReview).current_version!.id}/approve`);
  } else {
    res = await call("POST", `/deliveries/${deliveryId}/approve`);
  }
  const key = res.status >= 400 ? `${res.status}:${res.body.error?.code}` : String(res.status);
  statuses[key] = (statuses[key] ?? 0) + 1;
}

parentPort!.postMessage(statuses);
