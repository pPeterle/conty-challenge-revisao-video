// Regras puras, sem I/O. O serviço lê o banco, chama estas funções e grava o resultado.

export const VERSION_STATUSES = ["em_revisao", "alteracao_solicitada", "aprovada"] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

export type DeliveryStatus = "em_producao" | "aprovada";

export type ReviewDecision = "aprovada" | "alteracao_solicitada";

export interface CurrentVersion {
  id: string;
  number: number;
  status: VersionStatus;
}

export type PendingReason = "sem_versao" | "versao_atual_nao_aprovada";

export interface PendingPiece {
  piece_type: string;
  reason: PendingReason;
  current_version?: { id: string; number: number; status: VersionStatus };
}

/**
 * Lista o que impede a entrega de ser aprovada. Só olha as peças exigidas pela campanha:
 * peça enviada fora dessa lista nunca aparece aqui.
 */
export function pendingPieces(
  requiredPieces: readonly string[],
  currentByPiece: ReadonlyMap<string, CurrentVersion>,
): PendingPiece[] {
  const pending: PendingPiece[] = [];
  for (const pieceType of requiredPieces) {
    const current = currentByPiece.get(pieceType);
    if (!current) {
      pending.push({ piece_type: pieceType, reason: "sem_versao" });
    } else if (current.status !== "aprovada") {
      pending.push({
        piece_type: pieceType,
        reason: "versao_atual_nao_aprovada",
        current_version: { id: current.id, number: current.number, status: current.status },
      });
    }
  }
  return pending;
}

const STATUS_LABEL: Record<VersionStatus, string> = {
  em_revisao: "em revisão",
  alteracao_solicitada: "com alteração solicitada",
  aprovada: "aprovada",
};

export function describePending(pending: readonly PendingPiece[]): string {
  const parts = pending.map((p) =>
    p.reason === "sem_versao"
      ? `${p.piece_type}: nenhuma versão enviada`
      : `${p.piece_type}: versão atual v${p.current_version!.number} ${STATUS_LABEL[p.current_version!.status]}`,
  );
  return `A entrega não pode ser aprovada. Peças exigidas pendentes: ${parts.join("; ")}.`;
}

export type TransitionResult =
  | { kind: "apply" }
  | { kind: "noop" }
  | { kind: "invalid"; from: VersionStatus };

/** Decisão de revisão sobre uma versão: só sai de em_revisao, e repetir a mesma decisão é inofensivo. */
export function reviewTransition(from: VersionStatus, decision: ReviewDecision): TransitionResult {
  if (from === "em_revisao") return { kind: "apply" };
  if (from === decision) return { kind: "noop" };
  return { kind: "invalid", from };
}

/**
 * Versão nova desfaz a aprovação só quando a peça é exigida. Peça não exigida não conta para
 * aprovar, então também não pode desfazer nem bloquear.
 */
export function submissionRevokesApproval(
  deliveryStatus: DeliveryStatus,
  pieceType: string,
  requiredPieces: readonly string[],
): boolean {
  return deliveryStatus === "aprovada" && requiredPieces.includes(pieceType);
}

/**
 * Depois de desfeita, a entrega volta a aprovada sozinha quando a última pendência é aprovada.
 * A primeira aprovação (rodada 0) continua sendo ato explícito.
 */
export function shouldAutoReapprove(
  deliveryStatus: DeliveryStatus,
  approvalRound: number,
  pending: readonly PendingPiece[],
): boolean {
  return deliveryStatus === "em_producao" && approvalRound > 0 && pending.length === 0;
}

export function isValidAtSecond(atSecond: number, durationSeconds: number): boolean {
  return Number.isFinite(atSecond) && atSecond >= 0 && atSecond <= durationSeconds;
}
