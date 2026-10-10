// Todo dado que vem do cliente (corpo, params, query) passa por um destes schemas.
// Objetos usam strip: campo desconhecido é descartado sem erro.
import { zValidator } from "@hono/zod-validator";
import type { MiddlewareHandler, ValidationTargets } from "hono";
import { z } from "zod";
import { AppError } from "./errors.ts";

export const LIMITS = {
  bodyBytes: 64 * 1024,
  requiredPieces: 20,
  maxDurationSeconds: 6 * 60 * 60,
  pageMax: 500,
  pageDefault: 100,
};

const TYPE_NAMES: Record<string, string> = {
  string: "texto",
  number: "número",
  integer: "inteiro",
  array: "lista",
  object: "objeto",
  boolean: "booleano",
};

const ptErrorMap: z.ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      if (issue.received === "undefined" || issue.received === "null") return { message: "é obrigatório" };
      return { message: `precisa ser ${TYPE_NAMES[issue.expected] ?? issue.expected}` };
    case z.ZodIssueCode.too_small:
      if (issue.type === "string") return { message: issue.minimum === 1 ? "não pode ser vazio" : `precisa ter ao menos ${issue.minimum} caracteres` };
      if (issue.type === "array") return { message: `precisa ter ao menos ${issue.minimum} item(ns)` };
      return { message: `precisa ser ${issue.inclusive ? "no mínimo" : "maior que"} ${issue.minimum}` };
    case z.ZodIssueCode.too_big:
      if (issue.type === "string") return { message: `passa de ${issue.maximum} caracteres` };
      if (issue.type === "array") return { message: `aceita no máximo ${issue.maximum} itens` };
      return { message: `precisa ser no máximo ${issue.maximum}` };
    case z.ZodIssueCode.not_finite:
      return { message: "precisa ser um número finito" };
    case z.ZodIssueCode.invalid_string:
      return { message: "formato inválido" };
    default:
      return { message: ctx.defaultError };
  }
};
z.setErrorMap(ptErrorMap);

const text = (max: number) => z.string().trim().min(1).max(max);

/** Campo opcional: ausente ou null vira undefined; de outro tipo, erro com mensagem própria. */
const optionalText = (max: number) =>
  z
    .string({ invalid_type_error: "é opcional, mas quando enviado precisa ser texto" })
    .trim()
    .min(1)
    .max(max)
    .nullish()
    .transform((v) => v ?? undefined);

const optionalNumber = (min: number, max: number, exclusiveMin = false) => {
  const base = z.number({ invalid_type_error: "é opcional, mas quando enviado precisa ser número" }).finite().max(max);
  return (exclusiveMin ? base.gt(min) : base.min(min)).nullish().transform((v) => v ?? undefined);
};

// ---------- params e query ----------

const id = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "id com formato inválido");

export const idParam = z.object({ id });
export const pieceParam = z.object({ id, pieceType: z.string().max(40) });

const pageNumber = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/, "precisa ser inteiro não negativo")
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

export const pageQuery = z.object({
  limit: pageNumber(1, LIMITS.pageMax).default(String(LIMITS.pageDefault)),
  offset: pageNumber(0, Number.MAX_SAFE_INTEGER).default("0"),
});

// ---------- corpos ----------

export const newCampaignSchema = z.object({
  name: text(200),
  required_pieces: z.array(z.string().trim().min(1).max(40)).min(1).max(LIMITS.requiredPieces),
});
export type NewCampaign = z.infer<typeof newCampaignSchema>;

export const newDeliverySchema = z.object({
  creator_id: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._:@-]{1,100}$/, "aceita só letras sem acento, números e . _ : @ - (até 100 caracteres)"),
});

export const newVersionSchema = z
  .object({
    url: optionalText(2000).refine((u) => u === undefined || /^https?:\/\/\S+$/.test(u), "precisa começar com http:// ou https://"),
    file_name: optionalText(255),
    duration_seconds: optionalNumber(0, LIMITS.maxDurationSeconds, true),
  })
  .refine((v) => (v.url === undefined) !== (v.file_name === undefined), {
    message: "informe exatamente um entre url e file_name",
    path: ["url"],
  });
export type NewVersion = z.infer<typeof newVersionSchema>;

export const newCommentSchema = z.object({
  author: text(200),
  body: text(2000),
  at_second: optionalNumber(-Infinity, Number.MAX_VALUE),
});
export type NewComment = z.infer<typeof newCommentSchema>;

export const requestChangesSchema = z.object({ note: optionalText(2000) });

// ---------- validador ----------

const JSON_CONTENT_TYPE = /^application\/([a-z-.]+\+)?json(\s*;.*)?$/i;

/**
 * Rota com corpo exige Content-Type JSON (415 se ausente ou outro). Em rota de corpo opcional,
 * requisição sem corpo nenhum passa.
 */
export function requireJson(options: { bodyOptional?: boolean } = {}): MiddlewareHandler {
  return async (c, next) => {
    const contentType = c.req.header("content-type");
    if (contentType && JSON_CONTENT_TYPE.test(contentType)) return next();
    if (options.bodyOptional && (await c.req.text()) === "") return next();
    throw new AppError(415, "content_type_invalido", "Envie o corpo como JSON, com Content-Type: application/json.");
  };
}

export function toValidationError(error: z.ZodError): AppError {
  const issues = error.issues.map((i) => ({ path: i.path.join(".") || "(corpo)", message: i.message }));
  return new AppError(400, "validacao", issues.map((i) => `${i.path}: ${i.message}`).join("; ") + ".", { issues });
}

/** zValidator com um único hook: erro de schema vira o JSON de erro padrão. */
export function validate<T extends z.ZodTypeAny, Target extends keyof ValidationTargets>(target: Target, schema: T) {
  return zValidator(target, schema, (result) => {
    if (!result.success) throw toValidationError(result.error);
  });
}
