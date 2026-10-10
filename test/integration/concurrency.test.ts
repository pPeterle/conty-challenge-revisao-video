import { describe, expect, it } from "vitest";
import { setup } from "./helpers.ts";

describe("concorrência", () => {
  it("aprovar versão e enviar versão nova ao mesmo tempo: a aprovação só vale se a versão ainda for a atual", async () => {
    for (let round = 0; round < 20; round++) {
      const t = setup();
      const d = await t.delivery(["video"]);
      const v1 = await t.submit(d.id, "video");
      const [approve, v2] = await Promise.all([t.call("POST", `/versions/${v1.body.version.id}/approve`), t.submit(d.id, "video")]);

      expect(v2.status).toBe(201);
      if (approve.status === 200) {
        expect(approve.body.status).toBe("aprovada");
      } else {
        expect(approve.status).toBe(409);
        expect(approve.body.error.code).toBe("versao_desatualizada");
      }
      const view = await t.call("GET", `/deliveries/${d.id}`);
      expect(view.body.pieces[0].current_version).toMatchObject({ number: 2, status: "em_revisao" });
      expect(view.body.status).toBe("em_producao");
    }
  });

  it("aprovar a entrega enquanto chega versão nova numa peça exigida nunca deixa entrega aprovada com peça pendente", async () => {
    for (let round = 0; round < 20; round++) {
      const t = setup();
      const d = await t.delivery(["video", "capa"]);
      await t.submitAndApprove(d.id, "video");
      await t.submitAndApprove(d.id, "capa");
      const [approve, sent] = await Promise.all([t.call("POST", `/deliveries/${d.id}/approve`), t.submit(d.id, "capa")]);

      expect(sent.status).toBe(201);
      expect([200, 422]).toContain(approve.status);
      const view = await t.call("GET", `/deliveries/${d.id}`);
      expect(view.body.status).toBe("em_producao");
      const events = (await t.call("GET", `/deliveries/${d.id}/events`)).body as { type: string }[];
      const approved = events.filter((e) => e.type === "delivery.approved").length;
      const revoked = events.filter((e) => e.type === "delivery.approval_revoked").length;
      expect(approved - revoked).toBe(0);
    }
  });

  it("muitas aprovações simultâneas da mesma entrega emitem um único delivery.approved", async () => {
    const t = setup();
    const d = await t.delivery(["video"]);
    await t.submitAndApprove(d.id, "video");
    const results = await Promise.all(Array.from({ length: 25 }, () => t.call("POST", `/deliveries/${d.id}/approve`)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.already_approved === false)).toHaveLength(1);
    const events = (await t.call("GET", `/deliveries/${d.id}/events`)).body as { type: string }[];
    expect(events.filter((e) => e.type === "delivery.approved")).toHaveLength(1);
  });

  it("envios simultâneos na mesma peça recebem números de versão distintos e contíguos", async () => {
    const t = setup();
    const d = await t.delivery(["video"]);
    const results = await Promise.all(Array.from({ length: 30 }, () => t.submit(d.id, "video")));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const numbers = results.map((r) => r.body.version.number).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });

  it("a rodada de aprovação tem índice único: o banco recusa um segundo delivery.approved na mesma rodada", async () => {
    const t = setup();
    const d = await t.delivery(["video"]);
    await t.submitAndApprove(d.id, "video");
    await t.call("POST", `/deliveries/${d.id}/approve`);
    expect(() =>
      t.db
        .prepare("INSERT INTO delivery_events (delivery_id, type, round, payload, created_at) VALUES (?, 'delivery.approved', 1, '{}', 'x')")
        .run(d.id),
    ).toThrow(/UNIQUE/);
  });
});
