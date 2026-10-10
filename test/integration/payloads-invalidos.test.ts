import { describe, expect, it } from "vitest";
import { setup } from "./helpers.ts";

type T = ReturnType<typeof setup>;

/** Uma campanha, uma entrega, um vídeo v1 e um roteiro v1, para os endpoints que precisam de id válido. */
async function fixture() {
  const t = setup();
  const d = await t.delivery(["video", "roteiro"]);
  const video = (await t.submit(d.id, "video", { duration_seconds: 30 })).body.version;
  const roteiro = (await t.submit(d.id, "roteiro")).body.version;
  return { t, campaignId: d.campaign_id as string, deliveryId: d.id as string, videoId: video.id as string, roteiroId: roteiro.id as string };
}

type Fx = Awaited<ReturnType<typeof fixture>>;

const ENDPOINTS: [string, (f: Fx) => string][] = [
  ["POST /campaigns", () => "/campaigns"],
  ["POST /campaigns/:id/deliveries", (f) => `/campaigns/${f.campaignId}/deliveries`],
  ["POST /deliveries/:id/pieces/video/versions", (f) => `/deliveries/${f.deliveryId}/pieces/video/versions`],
  ["POST /versions/:id/comments", (f) => `/versions/${f.videoId}/comments`],
  ["POST /versions/:id/request-changes", (f) => `/versions/${f.videoId}/request-changes`],
];

const BAD_BODIES: [string, string][] = [
  ["JSON malformado", "{nope"],
  ["JSON truncado", '{"name": "x"'],
  ["null", "null"],
  ["array", "[1, 2]"],
  ["string solta", '"texto"'],
  ["número solto", "42"],
  ["NaN literal", '{"at_second": NaN}'],
  ["Infinity literal", '{"duration_seconds": Infinity}'],
];

async function raw(t: T, path: string, body: string, contentType: string | null = "application/json") {
  const res = await t.app.request(path, {
    method: "POST",
    headers: contentType ? { "content-type": contentType } : {},
    body,
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
}

function expectError(res: { status: number; json: { error?: { code?: unknown; message?: unknown } }; text: string }, status: number) {
  expect(res.status).toBe(status);
  expect(typeof res.json.error?.code).toBe("string");
  expect(typeof res.json.error?.message).toBe("string");
  expect(res.text).not.toMatch(/at .*\.ts|stack|Error:/);
}

describe("payloads inválidos não derrubam a API nem gravam nada", () => {
  const cases = ENDPOINTS.flatMap(([name, path]) => BAD_BODIES.map(([label, body]) => [name, label, path, body] as const));

  it.each(cases)("%s com %s devolve 400", async (_name, _label, path, body) => {
    const f = await fixture();
    expectError(await raw(f.t, path(f), body), 400);
  });

  const campaignCases: [string, unknown][] = [
    ["corpo vazio", undefined],
    ["sem name", { required_pieces: ["video"] }],
    ["name número", { name: 123, required_pieces: ["video"] }],
    ["name só espaços", { name: "   ", required_pieces: ["video"] }],
    ["name gigante", { name: "x".repeat(201), required_pieces: ["video"] }],
    ["required_pieces objeto", { name: "x", required_pieces: { video: true } }],
    ["required_pieces string", { name: "x", required_pieces: "video" }],
    ["required_pieces vazio", { name: "x", required_pieces: [] }],
    ["required_pieces com número", { name: "x", required_pieces: ["video", 1] }],
    ["required_pieces repetido", { name: "x", required_pieces: ["video", "video"] }],
    ["required_pieces desconhecido", { name: "x", required_pieces: ["trilha"] }],
    ["required_pieces com unicode", { name: "x", required_pieces: ["vídeo"] }],
    ["required_pieces enorme", { name: "x", required_pieces: Array.from({ length: 21 }, () => "video") }],
  ];

  it.each(campaignCases)("POST /campaigns com %s devolve 400", async (_label, body) => {
    const t = setup();
    const res = await raw(t, "/campaigns", body === undefined ? "" : JSON.stringify(body));
    expectError(res, 400);
  });

  const deliveryCases: [string, unknown][] = [
    ["corpo vazio", {}],
    ["creator_id número", { creator_id: 7 }],
    ["creator_id vazio", { creator_id: "" }],
    ["creator_id com espaço", { creator_id: "ana maria" }],
    ["creator_id com unicode", { creator_id: "joão" }],
    ["creator_id gigante", { creator_id: "a".repeat(101) }],
    ["creator_id objeto", { creator_id: { id: "ana" } }],
  ];

  it.each(deliveryCases)("POST /campaigns/:id/deliveries com %s devolve 400", async (_label, body) => {
    const f = await fixture();
    expectError(await raw(f.t, `/campaigns/${f.campaignId}/deliveries`, JSON.stringify(body)), 400);
  });

  const versionCases: [string, string, unknown][] = [
    ["video", "sem url nem arquivo", { duration_seconds: 10 }],
    ["video", "url e arquivo juntos", { url: "https://x/v.mp4", file_name: "v.mp4", duration_seconds: 10 }],
    ["video", "url sem esquema", { url: "cdn/v.mp4", duration_seconds: 10 }],
    ["video", "url javascript:", { url: "javascript:alert(1)", duration_seconds: 10 }],
    ["video", "url número", { url: 5, duration_seconds: 10 }],
    ["video", "url gigante", { url: `https://x/${"a".repeat(2000)}`, duration_seconds: 10 }],
    ["video", "sem duração", { url: "https://x/v.mp4" }],
    ["video", "duração string", { url: "https://x/v.mp4", duration_seconds: "10" }],
    ["video", "duração negativa", { url: "https://x/v.mp4", duration_seconds: -5 }],
    ["video", "duração zero", { url: "https://x/v.mp4", duration_seconds: 0 }],
    ["video", "duração enorme", { url: "https://x/v.mp4", duration_seconds: 1e12 }],
    ["video", "duração 1e309 (vira Infinity)", null],
    ["capa", "duração em peça sem duração", { file_name: "c.png", duration_seconds: 3 }],
    ["capa", "file_name só espaços", { file_name: "   " }],
    ["capa", "file_name array", { file_name: ["c.png"] }],
    ["trilha", "tipo de peça desconhecido", { file_name: "t.mp3" }],
    ["VIDEO", "tipo em maiúsculas", { url: "https://x/v.mp4", duration_seconds: 10 }],
  ];

  it.each(versionCases)("POST versions de %s com %s devolve 400", async (piece, _label, body) => {
    const f = await fixture();
    const text = body === null ? '{"url":"https://x/v.mp4","duration_seconds":1e309}' : JSON.stringify(body);
    expectError(await raw(f.t, `/deliveries/${f.deliveryId}/pieces/${piece}/versions`, text), 400);
  });

  const commentCases: [string, unknown, number][] = [
    ["sem author", { body: "x", at_second: 1 }, 400],
    ["author número", { author: 1, body: "x", at_second: 1 }, 400],
    ["body vazio", { author: "m", body: "", at_second: 1 }, 400],
    ["sem at_second em vídeo", { author: "m", body: "x" }, 400],
    ["at_second string", { author: "m", body: "x", at_second: "3" }, 400],
    ["at_second negativo", { author: "m", body: "x", at_second: -1 }, 400],
    ["at_second além da duração", { author: "m", body: "x", at_second: 31 }, 422],
    ["at_second enorme", { author: "m", body: "x", at_second: 1e300 }, 422],
    ["body gigante", { author: "m", body: "x".repeat(2001), at_second: 1 }, 400],
  ];

  it.each(commentCases)("POST comments com %s devolve 4xx", async (_label, body, status) => {
    const f = await fixture();
    expectError(await raw(f.t, `/versions/${f.videoId}/comments`, JSON.stringify(body)), status);
  });

  it("request-changes com note de tipo errado devolve 400 com mensagem de campo opcional", async () => {
    const f = await fixture();
    const res = await raw(f.t, `/versions/${f.videoId}/request-changes`, JSON.stringify({ note: 12 }));
    expectError(res, 400);
    expect(res.json.error.message).toBe("note: é opcional, mas quando enviado precisa ser texto.");
    expect(res.json.error.details.issues).toEqual([{ path: "note", message: "é opcional, mas quando enviado precisa ser texto" }]);
  });

  it("comentário com at_second em peça sem duração devolve 400", async () => {
    const f = await fixture();
    expectError(await raw(f.t, `/versions/${f.roteiroId}/comments`, JSON.stringify({ author: "m", body: "x", at_second: 2 })), 400);
  });

  it("corpo acima de 64 KB devolve 413", async () => {
    const t = setup();
    const res = await raw(t, "/campaigns", JSON.stringify({ name: "x", required_pieces: ["video"], pad: "a".repeat(70_000) }));
    expectError(res, 413);
  });

  it("campo desconhecido no corpo é recusado com 400 e o nome do campo nos detalhes", async () => {
    const t = setup();
    const res = await raw(t, "/campaigns", JSON.stringify({ name: "x", required_pieces: ["video"], admin: true, status: "aprovada" }));
    expectError(res, 400);
    expect(res.json.error.code).toBe("validacao");
    expect(res.json.error.details.issues).toEqual([
      { path: "admin", message: "campo não aceito" },
      { path: "status", message: "campo não aceito" },
    ]);
  });

  it.each(ENDPOINTS)("%s recusa __proto__ no corpo", async (_name, path) => {
    const f = await fixture();
    // JSON.parse cria "__proto__" como chave própria; o schema strict tem que enxergá-la.
    const res = await raw(f.t, path(f), '{"__proto__": {"status": "aprovada"}}');
    expectError(res, 400);
    expect(res.json.error.details.issues).toContainEqual({ path: "__proto__", message: "campo não aceito" });
    expect(({} as Record<string, unknown>).status).toBeUndefined();
  });

  it("at_second negativo é erro de formato (400); passar da duração é regra da versão (422)", async () => {
    const f = await fixture();
    const negative = await raw(f.t, `/versions/${f.videoId}/comments`, JSON.stringify({ author: "m", body: "x", at_second: -0.5 }));
    expectError(negative, 400);
    expect(negative.json.error.details.issues).toEqual([{ path: "at_second", message: "precisa ser no mínimo 0" }]);
    const beyond = await raw(f.t, `/versions/${f.videoId}/comments`, JSON.stringify({ author: "m", body: "x", at_second: 30.5 }));
    expectError(beyond, 422);
    expect(beyond.json.error.code).toBe("segundo_fora_da_duracao");
  });

  it.each(ENDPOINTS)("%s sem Content-Type JSON devolve 415", async (_name, path) => {
    const f = await fixture();
    const body = JSON.stringify({ name: "x", required_pieces: ["video"] });
    for (const contentType of [null, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const res = await raw(f.t, path(f), body, contentType);
      expectError(res, 415);
      expect(res.json.error.code).toBe("content_type_invalido");
    }
  });

  it("Content-Type JSON com charset é aceito", async () => {
    const t = setup();
    const res = await raw(t, "/campaigns", JSON.stringify({ name: "x", required_pieces: ["video"] }), "application/json; charset=utf-8");
    expect(res.status).toBe(201);
  });

  it("request-changes sem corpo nenhum é aceito sem Content-Type", async () => {
    const f = await fixture();
    const res = await f.t.app.request(`/versions/${f.videoId}/request-changes`, { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("erro de validação traz caminho e motivo de cada campo", async () => {
    const t = setup();
    const res = await raw(t, "/campaigns", JSON.stringify({ name: 5, required_pieces: ["video", 3] }));
    expectError(res, 400);
    expect(res.json.error).toEqual({
      code: "validacao",
      message: "name: precisa ser texto; required_pieces.1: precisa ser texto.",
      details: {
        issues: [
          { path: "name", message: "precisa ser texto" },
          { path: "required_pieces.1", message: "precisa ser texto" },
        ],
      },
    });
  });

  it.each([
    ["GET", "/deliveries/%20com%20espa%C3%A7o"],
    ["GET", "/versions/%F0%9F%92%A5/comments"],
    ["POST", `/versions/${"a".repeat(65)}/approve`],
  ])("%s %s com id em formato inválido devolve 400", async (method, path) => {
    const t = setup();
    const res = await t.app.request(path, { method });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("validacao");
  });

  it.each([
    ["GET", "/deliveries/nao-existe"],
    ["POST", "/versions/nao-existe/approve"],
    ["POST", "/deliveries/nao-existe/approve"],
    ["POST", "/campaigns/nao-existe/deliveries"],
    ["GET", "/rota/que/nao/existe"],
    ["DELETE", "/campaigns"],
    ["PUT", "/deliveries/x/approve"],
  ])("%s %s devolve 404 JSON", async (method, path) => {
    const t = setup();
    const res = await t.app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify({ creator_id: "ana" }),
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { code: string } };
    expect(typeof json.error.code).toBe("string");
  });

  it.each([
    ["limit=0"],
    ["limit=501"],
    ["limit=-1"],
    ["limit=abc"],
    ["offset=-5"],
    ["offset=1.5"],
  ])("listagem com %s devolve 400", async (query) => {
    const f = await fixture();
    for (const path of [
      `/deliveries/${f.deliveryId}/events`,
      `/versions/${f.videoId}/comments`,
      `/deliveries/${f.deliveryId}/pieces/video/versions`,
    ]) {
      const res = await f.t.app.request(`${path}?${query}`);
      expect(res.status).toBe(400);
    }
  });

  it("limit e offset paginam as listagens", async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++) {
      await f.t.call("POST", `/versions/${f.videoId}/comments`, { author: "m", body: `c${i}`, at_second: i });
    }
    const page = await f.t.call("GET", `/versions/${f.videoId}/comments?limit=2&offset=1`);
    expect(page.body.map((c: { body: string }) => c.body)).toEqual(["c1", "c2"]);
  });

  it("nenhum payload inválido grava nada no banco", async () => {
    const f = await fixture();
    const tables = ["campaigns", "campaign_required_pieces", "deliveries", "piece_versions", "comments", "delivery_events"];
    const snapshot = () => tables.map((tb) => (f.t.db.prepare(`SELECT COUNT(*) AS n FROM ${tb}`).get() as { n: number }).n);
    const before = snapshot();

    for (const [, path] of ENDPOINTS) for (const [, body] of BAD_BODIES) await raw(f.t, path(f), body);
    for (const [, body] of campaignCases) await raw(f.t, "/campaigns", body === undefined ? "" : JSON.stringify(body));
    for (const [, body] of deliveryCases) await raw(f.t, `/campaigns/${f.campaignId}/deliveries`, JSON.stringify(body));
    for (const [piece, , body] of versionCases) {
      if (body !== null) await raw(f.t, `/deliveries/${f.deliveryId}/pieces/${piece}/versions`, JSON.stringify(body));
    }
    for (const [, body] of commentCases) await raw(f.t, `/versions/${f.videoId}/comments`, JSON.stringify(body));
    await raw(f.t, `/versions/${f.videoId}/request-changes`, JSON.stringify({ note: 12 }));

    expect(snapshot()).toEqual(before);
    expect((await f.t.call("GET", `/versions/${f.videoId}`)).body.status).toBe("em_revisao");
  });

  it("erro inesperado vira 500 JSON genérico, sem stack trace", async () => {
    const f = await fixture();
    f.t.db.close();
    const original = console.error;
    console.error = () => {};
    try {
      const res = await f.t.call("GET", `/deliveries/${f.deliveryId}`);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: { code: "erro_interno", message: "Erro interno." } });
      expect(JSON.stringify(res.body)).not.toMatch(/at |\.ts|database/);
    } finally {
      console.error = original;
    }
  });
});
