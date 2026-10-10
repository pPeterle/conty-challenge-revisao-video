import { Hono, type Context } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "./clock.ts";
import { AppError, validation } from "./errors.ts";
import { ReviewService, type NewComment, type NewVersion } from "./service.ts";

export interface AppDeps {
  db: DatabaseSync;
  clock: Clock;
  newId?: () => string;
}

type Body = Record<string, unknown>;

async function readBody(c: Context): Promise<Body> {
  const text = await c.req.text();
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw validation("Corpo da requisição não é JSON válido.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw validation("Corpo da requisição precisa ser um objeto JSON.");
  }
  return parsed as Body;
}

function requiredString(body: Body, field: string, max = 2000): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") throw validation(`${field} é obrigatório (texto).`);
  if (value.length > max) throw validation(`${field} passa de ${max} caracteres.`);
  return value.trim();
}

function optionalString(body: Body, field: string, max = 2000): string | undefined {
  if (body[field] === undefined || body[field] === null) return undefined;
  return requiredString(body, field, max);
}

function optionalNumber(body: Body, field: string): number | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw validation(`${field} precisa ser número.`);
  return value;
}

function parseVersion(body: Body): NewVersion {
  const url = optionalString(body, "url");
  const file_name = optionalString(body, "file_name", 255);
  if ((url === undefined) === (file_name === undefined)) {
    throw validation("Informe exatamente um entre url e file_name.");
  }
  if (url !== undefined && !/^https?:\/\/\S+$/.test(url)) throw validation("url precisa começar com http:// ou https://.");
  const duration_seconds = optionalNumber(body, "duration_seconds");
  if (duration_seconds !== undefined && duration_seconds <= 0) throw validation("duration_seconds precisa ser maior que zero.");
  return { url, file_name, duration_seconds };
}

function parseComment(body: Body): NewComment {
  return {
    author: requiredString(body, "author", 200),
    body: requiredString(body, "body"),
    at_second: optionalNumber(body, "at_second"),
  };
}

export function createApp(deps: AppDeps) {
  const service = new ReviewService(deps);
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(
        { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } },
        err.status,
      );
    }
    console.error(err);
    return c.json({ error: { code: "erro_interno", message: "Erro interno." } }, 500);
  });

  app.notFound((c) => c.json({ error: { code: "rota_inexistente", message: "Rota não existe." } }, 404));

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/piece-types", (c) => c.json(service.pieceTypes()));

  app.post("/campaigns", async (c) => {
    const body = await readBody(c);
    const name = requiredString(body, "name", 200);
    const pieces = body.required_pieces;
    if (!Array.isArray(pieces) || pieces.length === 0 || !pieces.every((p) => typeof p === "string")) {
      throw validation("required_pieces precisa ser uma lista não vazia de tipos de peça.");
    }
    return c.json(service.createCampaign({ name, required_pieces: pieces }), 201);
  });

  app.get("/campaigns/:id", (c) => c.json(service.getCampaign(c.req.param("id"))));

  app.post("/campaigns/:id/deliveries", async (c) => {
    const body = await readBody(c);
    const result = service.createDelivery(c.req.param("id"), requiredString(body, "creator_id", 200));
    return c.json(result.delivery, result.created ? 201 : 200);
  });

  app.get("/deliveries/:id", (c) => c.json(service.getDelivery(c.req.param("id"))));

  app.post("/deliveries/:id/approve", (c) => c.json(service.approveDelivery(c.req.param("id"))));

  app.get("/deliveries/:id/events", (c) => c.json(service.listEvents(c.req.param("id"))));

  app.post("/deliveries/:id/pieces/:pieceType/versions", async (c) => {
    const input = parseVersion(await readBody(c));
    return c.json(service.submitVersion(c.req.param("id"), c.req.param("pieceType"), input), 201);
  });

  app.get("/deliveries/:id/pieces/:pieceType/versions", (c) =>
    c.json(service.listVersions(c.req.param("id"), c.req.param("pieceType"))),
  );

  app.get("/versions/:id", (c) => c.json(service.getVersion(c.req.param("id"))));

  app.post("/versions/:id/approve", (c) => c.json(service.approveVersion(c.req.param("id"))));

  app.post("/versions/:id/request-changes", async (c) => {
    const body = await readBody(c);
    return c.json(service.requestChanges(c.req.param("id"), optionalString(body, "note") ?? null));
  });

  app.post("/versions/:id/comments", async (c) => {
    const input = parseComment(await readBody(c));
    return c.json(service.addComment(c.req.param("id"), input), 201);
  });

  app.get("/versions/:id/comments", (c) => c.json(service.listComments(c.req.param("id"))));

  return app;
}
