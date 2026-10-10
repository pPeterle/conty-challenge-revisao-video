import { createApp } from "../../src/app.ts";
import { FixedClock } from "../../src/clock.ts";
import { openDatabase } from "../../src/db.ts";

export function setup() {
  const db = openDatabase(":memory:");
  const clock = new FixedClock("2026-03-01T10:00:00.000Z");
  const app = createApp({ db, clock });

  async function call(method: string, path: string, body?: unknown) {
    const res = await app.request(path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json();
    return { status: res.status, body: json };
  }

  async function campaign(required_pieces: string[]) {
    const res = await call("POST", "/campaigns", { name: "Campanha teste", required_pieces });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return res.body;
  }

  async function delivery(required_pieces: string[], creator_id = "criador-1") {
    const c = await campaign(required_pieces);
    const res = await call("POST", `/campaigns/${c.id}/deliveries`, { creator_id });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return res.body;
  }

  function submit(deliveryId: string, pieceType: string, extra: Record<string, unknown> = {}) {
    const body = pieceType === "video" ? { url: "https://cdn.exemplo/video.mp4", duration_seconds: 30, ...extra } : { file_name: `${pieceType}.pdf`, ...extra };
    return call("POST", `/deliveries/${deliveryId}/pieces/${pieceType}/versions`, body);
  }

  async function submitAndApprove(deliveryId: string, pieceType: string) {
    const sent = await submit(deliveryId, pieceType);
    if (sent.status !== 201) throw new Error(JSON.stringify(sent.body));
    const approved = await call("POST", `/versions/${sent.body.version.id}/approve`);
    if (approved.status !== 200) throw new Error(JSON.stringify(approved.body));
    return approved.body;
  }

  return { db, clock, app, call, campaign, delivery, submit, submitAndApprove };
}
