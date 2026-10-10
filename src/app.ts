import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "./clock.ts";
import { AppError } from "./errors.ts";
import {
  LIMITS,
  idParam,
  newCampaignSchema,
  newCommentSchema,
  newDeliverySchema,
  newVersionSchema,
  pageQuery,
  pieceParam,
  requestChangesSchema,
  validate,
} from "./schemas.ts";
import { ReviewService } from "./service.ts";

export interface AppDeps {
  db: DatabaseSync;
  clock: Clock;
  newId?: () => string;
}

function errorBody(code: string, message: string, details?: Record<string, unknown>) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

export function createApp(deps: AppDeps) {
  const service = new ReviewService(deps);
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(errorBody(err.code, err.message, err.details), err.status);
    // O validador do Hono lança HTTPException 400 quando o corpo não é JSON válido.
    if (err instanceof HTTPException && err.status === 400) {
      return c.json(errorBody("validacao", "Corpo da requisição não é JSON válido."), 400);
    }
    console.error(err);
    return c.json(errorBody("erro_interno", "Erro interno."), 500);
  });

  app.notFound((c) => c.json(errorBody("rota_inexistente", "Rota não existe."), 404));

  app.use(
    "*",
    bodyLimit({
      maxSize: LIMITS.bodyBytes,
      onError: (c) => c.json(errorBody("corpo_grande_demais", `Corpo passa de ${LIMITS.bodyBytes} bytes.`), 413),
    }),
  );

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/piece-types", (c) => c.json(service.pieceTypes()));

  app.post("/campaigns", validate("json", newCampaignSchema), (c) =>
    c.json(service.createCampaign(c.req.valid("json")), 201),
  );

  app.get("/campaigns/:id", validate("param", idParam), (c) => c.json(service.getCampaign(c.req.valid("param").id)));

  app.post("/campaigns/:id/deliveries", validate("param", idParam), validate("json", newDeliverySchema), (c) => {
    const result = service.createDelivery(c.req.valid("param").id, c.req.valid("json").creator_id);
    return c.json(result.delivery, result.created ? 201 : 200);
  });

  app.get("/deliveries/:id", validate("param", idParam), (c) => c.json(service.getDelivery(c.req.valid("param").id)));

  app.post("/deliveries/:id/approve", validate("param", idParam), (c) =>
    c.json(service.approveDelivery(c.req.valid("param").id)),
  );

  app.get("/deliveries/:id/events", validate("param", idParam), validate("query", pageQuery), (c) =>
    c.json(service.listEvents(c.req.valid("param").id, c.req.valid("query"))),
  );

  app.post(
    "/deliveries/:id/pieces/:pieceType/versions",
    validate("param", pieceParam),
    validate("json", newVersionSchema),
    (c) => {
      const { id, pieceType } = c.req.valid("param");
      return c.json(service.submitVersion(id, pieceType, c.req.valid("json")), 201);
    },
  );

  app.get("/deliveries/:id/pieces/:pieceType/versions", validate("param", pieceParam), validate("query", pageQuery), (c) => {
    const { id, pieceType } = c.req.valid("param");
    return c.json(service.listVersions(id, pieceType, c.req.valid("query")));
  });

  app.get("/versions/:id", validate("param", idParam), (c) => c.json(service.getVersion(c.req.valid("param").id)));

  app.post("/versions/:id/approve", validate("param", idParam), (c) =>
    c.json(service.approveVersion(c.req.valid("param").id)),
  );

  app.post("/versions/:id/request-changes", validate("param", idParam), validate("json", requestChangesSchema), (c) =>
    c.json(service.requestChanges(c.req.valid("param").id, c.req.valid("json").note ?? null)),
  );

  app.post("/versions/:id/comments", validate("param", idParam), validate("json", newCommentSchema), (c) =>
    c.json(service.addComment(c.req.valid("param").id, c.req.valid("json")), 201),
  );

  app.get("/versions/:id/comments", validate("param", idParam), validate("query", pageQuery), (c) =>
    c.json(service.listComments(c.req.valid("param").id, c.req.valid("query"))),
  );

  return app;
}
