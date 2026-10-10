import { describe, expect, it } from "vitest";
import { setup } from "./helpers.ts";

const FULL = ["roteiro", "video", "capa", "legenda"];

describe("campanha declara as peças exigidas", () => {
  it("a lista de peças exigidas é dado da campanha e volta no GET", async () => {
    const t = setup();
    const c = await t.campaign(["video", "capa"]);
    const res = await t.call("GET", `/campaigns/${c.id}`);
    expect(res.status).toBe(200);
    expect(res.body.required_pieces).toEqual(["video", "capa"]);
    const rows = t.db.prepare("SELECT piece_type FROM campaign_required_pieces WHERE campaign_id = ? ORDER BY piece_type").all(c.id);
    expect(rows.map((r) => r.piece_type)).toEqual(["capa", "video"]);
  });

  it("tipo de peça desconhecido na campanha é recusado", async () => {
    const t = setup();
    const res = await t.call("POST", "/campaigns", { name: "x", required_pieces: ["video", "trilha"] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("tipo_de_peca_desconhecido");
  });

  it("lista vazia ou repetida é recusada", async () => {
    const t = setup();
    expect((await t.call("POST", "/campaigns", { name: "x", required_pieces: [] })).status).toBe(400);
    expect((await t.call("POST", "/campaigns", { name: "x", required_pieces: ["video", "video"] })).status).toBe(400);
  });

  it("criar a entrega do mesmo criador duas vezes devolve a mesma entrega", async () => {
    const t = setup();
    const c = await t.campaign(["video"]);
    const a = await t.call("POST", `/campaigns/${c.id}/deliveries`, { creator_id: "ana" });
    const b = await t.call("POST", `/campaigns/${c.id}/deliveries`, { creator_id: "ana" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
  });
});

describe("regra de peças exigidas", () => {
  it("aprovar com peça obrigatória pendente falha com erro claro listando o que falta e por quê", async () => {
    const t = setup();
    const d = await t.delivery(FULL);
    await t.submitAndApprove(d.id, "video");
    const capa = await t.submit(d.id, "capa");
    await t.call("POST", `/versions/${capa.body.version.id}/request-changes`, { note: "logo cortado" });
    await t.submit(d.id, "legenda");

    const res = await t.call("POST", `/deliveries/${d.id}/approve`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("pecas_pendentes");
    expect(res.body.error.message).toBe(
      "A entrega não pode ser aprovada. Peças exigidas pendentes: roteiro: nenhuma versão enviada; capa: versão atual v1 com alteração solicitada; legenda: versão atual v1 em revisão.",
    );
    expect(res.body.error.details.pending).toEqual([
      { piece_type: "roteiro", reason: "sem_versao" },
      {
        piece_type: "capa",
        reason: "versao_atual_nao_aprovada",
        current_version: { id: capa.body.version.id, number: 1, status: "alteracao_solicitada" },
      },
      { piece_type: "legenda", reason: "versao_atual_nao_aprovada", current_version: expect.objectContaining({ number: 1, status: "em_revisao" }) },
    ]);

    const after = await t.call("GET", `/deliveries/${d.id}`);
    expect(after.body.status).toBe("em_producao");
    expect(after.body.payable).toBe(false);
    const events = await t.call("GET", `/deliveries/${d.id}/events`);
    expect(events.body.some((e: { type: string }) => e.type === "delivery.approved")).toBe(false);
  });

  it("aprovar o vídeo cedo não aprova a entrega: ela segue em produção sem pagamento", async () => {
    const t = setup();
    const d = await t.delivery(FULL);
    await t.submitAndApprove(d.id, "video");
    const res = await t.call("GET", `/deliveries/${d.id}`);
    expect(res.body.status).toBe("em_producao");
    expect(res.body.payable).toBe(false);
    expect(res.body.ready_to_approve).toBe(false);
    expect(res.body.pending.map((p: { piece_type: string }) => p.piece_type)).toEqual(["roteiro", "capa", "legenda"]);
  });

  it("com todas as peças exigidas aprovadas a entrega é aprovada e fica pagável", async () => {
    const t = setup();
    const d = await t.delivery(FULL);
    for (const p of FULL) await t.submitAndApprove(d.id, p);
    const res = await t.call("POST", `/deliveries/${d.id}/approve`);
    expect(res.status).toBe(200);
    expect(res.body.already_approved).toBe(false);
    expect(res.body.delivery.status).toBe("aprovada");
    expect(res.body.delivery.payable).toBe(true);
    expect(res.body.delivery.approval_round).toBe(1);
  });

  it("campanha só de vídeo não exige roteiro", async () => {
    const t = setup();
    const d = await t.delivery(["video"]);
    expect(d.pending).toEqual([{ piece_type: "video", reason: "sem_versao" }]);
    await t.submitAndApprove(d.id, "video");
    const res = await t.call("POST", `/deliveries/${d.id}/approve`);
    expect(res.status).toBe(200);
    expect(res.body.delivery.status).toBe("aprovada");
    expect(res.body.delivery.required_pieces).toEqual(["video"]);
  });

  it("peça que a campanha não pediu não bloqueia, mesmo enviada e pendente", async () => {
    const t = setup();
    const d = await t.delivery(["video"]);
    await t.submitAndApprove(d.id, "video");
    const roteiro = await t.submit(d.id, "roteiro");
    expect(roteiro.status).toBe(201);
    await t.call("POST", `/versions/${roteiro.body.version.id}/request-changes`);

    const res = await t.call("POST", `/deliveries/${d.id}/approve`);
    expect(res.status).toBe(200);
    const roteiroPiece = res.body.delivery.pieces.find((p: { piece_type: string }) => p.piece_type === "roteiro");
    expect(roteiroPiece).toMatchObject({ required: false, current_version: { status: "alteracao_solicitada" } });
  });

  it("aprovar entrega já aprovada é idempotente e não emite segundo evento", async () => {
    const t = setup();
    const d = await t.delivery(["video"]);
    await t.submitAndApprove(d.id, "video");
    await t.call("POST", `/deliveries/${d.id}/approve`);
    const again = await t.call("POST", `/deliveries/${d.id}/approve`);
    expect(again.status).toBe(200);
    expect(again.body.already_approved).toBe(true);
    const events = await t.call("GET", `/deliveries/${d.id}/events`);
    expect(events.body.filter((e: { type: string }) => e.type === "delivery.approved")).toHaveLength(1);
  });
});

describe("versões", () => {
  it("versão nova substitui a anterior como atual e a anterior fica preservada", async () => {
    const t = setup();
    const d = await t.delivery(["video"]);
    const v1 = await t.submit(d.id, "video", { url: "https://cdn.exemplo/v1.mp4", duration_seconds: 30 });
    await t.call("POST", `/versions/${v1.body.version.id}/request-changes`, { note: "áudio baixo" });
    t.clock.advance(60_000);
    const v2 = await t.submit(d.id, "video", { url: "https://cdn.exemplo/v2.mp4", duration_seconds: 28 });

    expect(v2.body.version).toMatchObject({ number: 2, is_current: true, status: "em_revisao", duration_seconds: 28 });
    const list = await t.call("GET", `/deliveries/${d.id}/pieces/video/versions`);
    expect(list.body.map((v: { number: number; is_current: boolean; url: string; status: string }) => [v.number, v.is_current, v.url, v.status])).toEqual([
      [1, false, "https://cdn.exemplo/v1.mp4", "alteracao_solicitada"],
      [2, true, "https://cdn.exemplo/v2.mp4", "em_revisao"],
    ]);
    const old = await t.call("GET", `/versions/${v1.body.version.id}`);
    expect(old.body).toMatchObject({ number: 1, is_current: false, review_note: "áudio baixo" });

    const view = await t.call("GET", `/deliveries/${d.id}`);
    expect(view.body.pieces[0]).toMatchObject({ piece_type: "video", versions_count: 2, current_version: { number: 2 } });
  });

  it("aprovar versão que já não é a atual falha com versao_desatualizada", async () => {
    const t = setup();
    const d = await t.delivery(["video"]);
    const v1 = await t.submit(d.id, "video");
    const v2 = await t.submit(d.id, "video");
    const res = await t.call("POST", `/versions/${v1.body.version.id}/approve`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("versao_desatualizada");
    expect(res.body.error.details.current_version).toEqual({ id: v2.body.version.id, number: 2, status: "em_revisao" });
    const reqChanges = await t.call("POST", `/versions/${v1.body.version.id}/request-changes`);
    expect(reqChanges.status).toBe(409);
    expect((await t.call("GET", `/versions/${v1.body.version.id}`)).body.status).toBe("em_revisao");
  });

  it("versão já revisada não muda de decisão; repetir a mesma decisão é inofensivo", async () => {
    const t = setup();
    const d = await t.delivery(["video"]);
    const v1 = await t.submit(d.id, "video");
    expect((await t.call("POST", `/versions/${v1.body.version.id}/approve`)).status).toBe(200);
    expect((await t.call("POST", `/versions/${v1.body.version.id}/approve`)).status).toBe(200);
    const flip = await t.call("POST", `/versions/${v1.body.version.id}/request-changes`);
    expect(flip.status).toBe(409);
    expect(flip.body.error.code).toBe("transicao_invalida");
    const events = await t.call("GET", `/deliveries/${d.id}/events`);
    expect(events.body.filter((e: { type: string }) => e.type === "version.approved")).toHaveLength(1);
  });

  it("vídeo exige duração; peça sem duração recusa duração; tipo desconhecido é recusado", async () => {
    const t = setup();
    const d = await t.delivery(FULL);
    const noDuration = await t.call("POST", `/deliveries/${d.id}/pieces/video/versions`, { url: "https://x/v.mp4" });
    expect(noDuration.status).toBe(400);
    const capaDuration = await t.call("POST", `/deliveries/${d.id}/pieces/capa/versions`, { file_name: "capa.png", duration_seconds: 3 });
    expect(capaDuration.status).toBe(400);
    const unknown = await t.call("POST", `/deliveries/${d.id}/pieces/trilha/versions`, { file_name: "t.mp3" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("tipo_de_peca_desconhecido");
    const both = await t.call("POST", `/deliveries/${d.id}/pieces/capa/versions`, { file_name: "c.png", url: "https://x/c.png" });
    expect(both.status).toBe(400);
  });
});

describe("entrega aprovada que recebe versão nova", () => {
  it("versão nova numa peça exigida desfaz a aprovação até ser aprovada e reaprovada", async () => {
    const t = setup();
    const d = await t.delivery(["video", "capa"]);
    await t.submitAndApprove(d.id, "video");
    await t.submitAndApprove(d.id, "capa");
    await t.call("POST", `/deliveries/${d.id}/approve`);

    const v2 = await t.submit(d.id, "video", { url: "https://cdn.exemplo/v2.mp4", duration_seconds: 31 });
    expect(v2.status).toBe(201);
    expect(v2.body.approval_revoked).toBe(true);
    expect(v2.body.delivery).toMatchObject({ status: "em_producao", payable: false, approved_at: null });

    const blocked = await t.call("POST", `/deliveries/${d.id}/approve`);
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.details.pending).toEqual([
      { piece_type: "video", reason: "versao_atual_nao_aprovada", current_version: { id: v2.body.version.id, number: 2, status: "em_revisao" } },
    ]);

    await t.call("POST", `/versions/${v2.body.version.id}/approve`);
    const stillNot = await t.call("GET", `/deliveries/${d.id}`);
    expect(stillNot.body).toMatchObject({ status: "em_producao", ready_to_approve: true });

    const reapproved = await t.call("POST", `/deliveries/${d.id}/approve`);
    expect(reapproved.status).toBe(200);
    expect(reapproved.body.delivery).toMatchObject({ status: "aprovada", payable: true, approval_round: 2 });

    const events = (await t.call("GET", `/deliveries/${d.id}/events`)).body as { type: string; round: number | null; payload: { version_id?: string } }[];
    const lifecycle = events.filter((e) => e.type.startsWith("delivery."));
    expect(lifecycle.map((e) => [e.type, e.round])).toEqual([
      ["delivery.approved", 1],
      ["delivery.approval_revoked", 1],
      ["delivery.approved", 2],
    ]);
    expect(lifecycle[1].payload.version_id).toBe(v2.body.version.id);
  });

  it("versão nova em peça não exigida não desfaz a aprovação", async () => {
    const t = setup();
    const d = await t.delivery(["video"]);
    await t.submitAndApprove(d.id, "video");
    await t.call("POST", `/deliveries/${d.id}/approve`);
    const extra = await t.submit(d.id, "legenda");
    expect(extra.body.approval_revoked).toBe(false);
    expect(extra.body.delivery.status).toBe("aprovada");
  });
});

describe("comentários ancorados em segundo", () => {
  it("comentário preso a um segundo fica visível na versão em que foi feito", async () => {
    const t = setup();
    const d = await t.delivery(["video"]);
    const v1 = await t.submit(d.id, "video", { duration_seconds: 45 });
    const id = v1.body.version.id;
    await t.call("POST", `/versions/${id}/comments`, { author: "marca", body: "logo aparece tarde", at_second: 12.5 });
    await t.call("POST", `/versions/${id}/comments`, { author: "marca", body: "abertura ótima", at_second: 0 });
    const end = await t.call("POST", `/versions/${id}/comments`, { author: "marca", body: "corta o final", at_second: 45 });
    expect(end.status).toBe(201);
    expect(end.body).toMatchObject({ version_id: id, at_second: 45 });

    const list = await t.call("GET", `/versions/${id}/comments`);
    expect(list.body.map((c: { at_second: number; body: string }) => [c.at_second, c.body])).toEqual([
      [0, "abertura ótima"],
      [12.5, "logo aparece tarde"],
      [45, "corta o final"],
    ]);
  });

  it("comentário não migra sozinho para a versão nova, e o antigo segue na versão antiga", async () => {
    const t = setup();
    const d = await t.delivery(["video"]);
    const v1 = await t.submit(d.id, "video");
    await t.call("POST", `/versions/${v1.body.version.id}/comments`, { author: "marca", body: "trocar trilha", at_second: 8 });
    const v2 = await t.submit(d.id, "video");

    expect((await t.call("GET", `/versions/${v2.body.version.id}/comments`)).body).toEqual([]);
    const old = await t.call("GET", `/versions/${v1.body.version.id}/comments`);
    expect(old.body).toHaveLength(1);
    expect(old.body[0]).toMatchObject({ body: "trocar trilha", at_second: 8, version_id: v1.body.version.id });
  });

  it("segundo fora da duração da versão é recusado", async () => {
    const t = setup();
    const d = await t.delivery(["video"]);
    const v1 = await t.submit(d.id, "video", { duration_seconds: 30 });
    const after = await t.call("POST", `/versions/${v1.body.version.id}/comments`, { author: "m", body: "x", at_second: 31 });
    expect(after.status).toBe(422);
    expect(after.body.error.code).toBe("segundo_fora_da_duracao");
    const negative = await t.call("POST", `/versions/${v1.body.version.id}/comments`, { author: "m", body: "x", at_second: -1 });
    expect(negative.status).toBe(422);
    const missing = await t.call("POST", `/versions/${v1.body.version.id}/comments`, { author: "m", body: "x" });
    expect(missing.status).toBe(400);
  });

  it("a validação usa a duração da versão comentada, não a da atual", async () => {
    const t = setup();
    const d = await t.delivery(["video"]);
    const v1 = await t.submit(d.id, "video", { duration_seconds: 60 });
    await t.submit(d.id, "video", { duration_seconds: 20 });
    const res = await t.call("POST", `/versions/${v1.body.version.id}/comments`, { author: "m", body: "no segundo 50", at_second: 50 });
    expect(res.status).toBe(201);
  });

  it("peça sem duração aceita comentário sem at_second", async () => {
    const t = setup();
    const d = await t.delivery(["roteiro"]);
    const r = await t.submit(d.id, "roteiro");
    const ok = await t.call("POST", `/versions/${r.body.version.id}/comments`, { author: "m", body: "revisar CTA" });
    expect(ok.status).toBe(201);
    expect(ok.body.at_second).toBeNull();
    const withSecond = await t.call("POST", `/versions/${r.body.version.id}/comments`, { author: "m", body: "x", at_second: 3 });
    expect(withSecond.status).toBe(400);
  });
});

describe("erros", () => {
  it("recursos inexistentes devolvem 404 no formato padrão", async () => {
    const t = setup();
    const res = await t.call("GET", "/deliveries/nao-existe");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "nao_encontrado", message: "Entrega não encontrada." } });
    expect((await t.call("POST", "/versions/nao-existe/approve")).status).toBe(404);
  });

  it("JSON inválido devolve 400", async () => {
    const t = setup();
    const res = await t.app.request("/campaigns", { method: "POST", body: "{nope", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
  });
});
