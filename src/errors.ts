export type ErrorStatus = 400 | 404 | 409 | 413 | 415 | 422;

export class AppError extends Error {
  constructor(
    readonly status: ErrorStatus,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const validation = (message: string) => new AppError(400, "validacao", message);

export const notFound = (what: string) =>
  new AppError(404, "nao_encontrado", `${what} não encontrada.`);
