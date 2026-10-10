import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "./clock.ts";
import { Repository, transaction, type Page, type CommentRow, type DeliveryRow, type EventRow, type VersionRow } from "./db.ts";
import {
  blockingPieces,
  describePending,
  isValidAtSecond,
  pendingPieces,
  reviewTransition,
  shouldAutoReapprove,
  submissionRevokesApproval,
  type CurrentVersion,
  type ReviewDecision,
} from "./domain.ts";
import { AppError, notFound, validation } from "./errors.ts";
import { LIMITS, type NewCampaign, type NewComment, type NewVersion } from "./schemas.ts";

export interface ServiceDeps {
  db: DatabaseSync;
  clock: Clock;
  newId?: () => string;
}

export const DEFAULT_PAGE: Page = { limit: LIMITS.pageDefault, offset: 0 };

export class ReviewService {
  private readonly repo: Repository;
  private readonly clock: Clock;
  private readonly newId: () => string;

  constructor(deps: ServiceDeps) {
    this.repo = new Repository(deps.db);
    this.clock = deps.clock;
    this.newId = deps.newId ?? randomUUID;
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  private tx<T>(fn: () => T): T {
    return transaction(this.repo.db, fn);
  }

  private assertKnownPiece(pieceType: string) {
    const piece = this.repo.getPieceType(pieceType);
    if (!piece) {
      const known = this.repo.listPieceTypes().map((p) => p.code);
      throw new AppError(
        400,
        "tipo_de_peca_desconhecido",
        `Tipo de peça desconhecido: "${pieceType}". Tipos aceitos: ${known.join(", ")}.`,
      );
    }
    return piece;
  }

  // ---------- leitura ----------

  pieceTypes() {
    return this.repo.listPieceTypes().map((p) => ({ code: p.code, label: p.label, timed: p.timed === 1 }));
  }

  getCampaign(id: string) {
    const campaign = this.repo.getCampaign(id);
    if (!campaign) throw notFound("Campanha");
    return { ...campaign, required_pieces: this.repo.requiredPieces(id) };
  }

  getDelivery(id: string) {
    const delivery = this.repo.getDelivery(id);
    if (!delivery) throw notFound("Entrega");
    return this.deliveryView(delivery);
  }

  getVersion(id: string) {
    const version = this.repo.getVersion(id);
    if (!version) throw notFound("Versão");
    return this.versionView(version);
  }

  listVersions(deliveryId: string, pieceType: string, page: Page = DEFAULT_PAGE) {
    if (!this.repo.getDelivery(deliveryId)) throw notFound("Entrega");
    this.assertKnownPiece(pieceType);
    const versions = this.repo.listVersions(deliveryId, pieceType, page);
    const currentNumber = this.repo.currentVersion(deliveryId, pieceType)?.number;
    return versions.map((v) => toVersionJson(v, v.number === currentNumber));
  }

  listComments(versionId: string, page: Page = DEFAULT_PAGE) {
    if (!this.repo.getVersion(versionId)) throw notFound("Versão");
    return this.repo.listComments(versionId, page).map(toCommentJson);
  }

  listEvents(deliveryId: string, page: Page = DEFAULT_PAGE) {
    if (!this.repo.getDelivery(deliveryId)) throw notFound("Entrega");
    return this.repo.listEvents(deliveryId, page).map(toEventJson);
  }

  // ---------- escrita ----------

  createCampaign(input: NewCampaign) {
    const unique = [...new Set(input.required_pieces)];
    if (unique.length !== input.required_pieces.length) {
      throw validation("required_pieces não pode ter peça repetida.");
    }
    for (const piece of unique) this.assertKnownPiece(piece);
    const id = this.newId();
    this.tx(() => this.repo.insertCampaign({ id, name: input.name, created_at: this.now() }, unique));
    return this.getCampaign(id);
  }

  /** Uma entrega por criador e campanha. Repetir a chamada devolve a mesma entrega. */
  createDelivery(campaignId: string, creatorId: string) {
    return this.tx(() => {
      if (!this.repo.getCampaign(campaignId)) throw notFound("Campanha");
      const created = this.repo.insertDeliveryIfAbsent({
        id: this.newId(),
        campaign_id: campaignId,
        creator_id: creatorId,
        status: "em_producao",
        approval_round: 0,
        approved_at: null,
        created_at: this.now(),
      });
      const delivery = this.repo.getDeliveryByCreator(campaignId, creatorId)!;
      return { created, delivery: this.deliveryView(delivery) };
    });
  }

  submitVersion(deliveryId: string, pieceType: string, input: NewVersion) {
    const piece = this.assertKnownPiece(pieceType);
    const timed = piece.timed === 1;
    if (timed && input.duration_seconds === undefined) {
      throw validation(`Versão de ${pieceType} precisa de duration_seconds.`);
    }
    if (!timed && input.duration_seconds !== undefined) {
      throw validation(`Peça ${pieceType} não tem duração; não envie duration_seconds.`);
    }

    return this.tx(() => {
      const delivery = this.repo.getDelivery(deliveryId);
      if (!delivery) throw notFound("Entrega");
      const now = this.now();
      const version: VersionRow = {
        id: this.newId(),
        delivery_id: deliveryId,
        piece_type: pieceType,
        number: this.repo.nextVersionNumber(deliveryId, pieceType),
        url: input.url ?? null,
        file_name: input.file_name ?? null,
        duration_seconds: input.duration_seconds ?? null,
        status: "em_revisao",
        review_note: null,
        created_at: now,
        reviewed_at: null,
      };
      this.repo.insertVersion(version);
      this.event(delivery.id, "version.submitted", null, {
        version_id: version.id,
        piece_type: pieceType,
        number: version.number,
      });

      const revoked = submissionRevokesApproval(delivery.status);
      if (revoked) {
        const required = this.repo.requiredPieces(delivery.campaign_id).includes(pieceType);
        if (!required) this.repo.markPieceChangedAfterApproval(delivery.id, pieceType, now);
        this.repo.markDeliveryInProduction(delivery.id);
        this.event(delivery.id, "delivery.approval_revoked", delivery.approval_round, {
          reason: "nova_versao",
          piece_type: pieceType,
          required,
          version_id: version.id,
          number: version.number,
        });
      }
      return {
        version: toVersionJson(version, true),
        approval_revoked: revoked,
        delivery: this.deliveryView(this.repo.getDelivery(delivery.id)!),
      };
    });
  }

  approveVersion(versionId: string) {
    return this.review(versionId, "aprovada", null);
  }

  requestChanges(versionId: string, note: string | null) {
    return this.review(versionId, "alteracao_solicitada", note);
  }

  private review(versionId: string, decision: ReviewDecision, note: string | null) {
    return this.tx(() => {
      const version = this.repo.getVersion(versionId);
      if (!version) throw notFound("Versão");
      const current = this.repo.currentVersion(version.delivery_id, version.piece_type)!;
      if (current.id !== version.id) {
        throw new AppError(
          409,
          "versao_desatualizada",
          `A versão v${version.number} de ${version.piece_type} não é mais a atual (atual: v${current.number}). Revise a versão atual.`,
          { current_version: { id: current.id, number: current.number, status: current.status } },
        );
      }
      const transition = reviewTransition(version.status, decision);
      if (transition.kind === "invalid") {
        throw new AppError(
          409,
          "transicao_invalida",
          `A versão v${version.number} de ${version.piece_type} já foi revisada (${transition.from}). Para mudar o resultado, envie uma versão nova.`,
        );
      }
      if (transition.kind === "apply") {
        this.repo.setVersionReview(version.id, decision, note, this.now());
        this.event(version.delivery_id, decision === "aprovada" ? "version.approved" : "version.changes_requested", null, {
          version_id: version.id,
          piece_type: version.piece_type,
          number: version.number,
          ...(note ? { note } : {}),
        });
        if (decision === "aprovada") this.reapproveIfResolved(version.delivery_id);
      }
      return this.versionView(this.repo.getVersion(version.id)!);
    });
  }

  addComment(versionId: string, input: NewComment) {
    return this.tx(() => {
      const version = this.repo.getVersion(versionId);
      if (!version) throw notFound("Versão");
      if (version.duration_seconds !== null) {
        if (input.at_second === undefined) {
          throw validation("Comentário em versão com duração precisa de at_second.");
        }
        if (!isValidAtSecond(input.at_second, version.duration_seconds)) {
          throw new AppError(
            422,
            "segundo_fora_da_duracao",
            `at_second ${input.at_second} está fora da versão v${version.number}, que dura ${version.duration_seconds}s.`,
          );
        }
      } else if (input.at_second !== undefined) {
        throw validation(`Peça ${version.piece_type} não tem duração; comentário não leva at_second.`);
      }
      const comment: CommentRow = {
        id: this.newId(),
        version_id: version.id,
        author: input.author,
        body: input.body,
        at_second: input.at_second ?? null,
        created_at: this.now(),
      };
      this.repo.insertComment(comment);
      return toCommentJson(comment);
    });
  }

  /**
   * Ato explícito de aprovar a entrega. A regra é recalculada aqui a partir das versões atuais.
   * Entrega já aprovada devolve o estado sem emitir evento novo.
   */
  approveDelivery(deliveryId: string) {
    return this.tx(() => {
      const delivery = this.repo.getDelivery(deliveryId);
      if (!delivery) throw notFound("Entrega");
      if (delivery.status === "aprovada") return { already_approved: true, delivery: this.deliveryView(delivery) };

      const { pending } = this.evaluate(delivery);
      if (pending.length > 0) {
        throw new AppError(422, "pecas_pendentes", describePending(pending), { pending });
      }
      this.markApproved(delivery, false);
      return { already_approved: false, delivery: this.deliveryView(this.repo.getDelivery(delivery.id)!) };
    });
  }

  /** Chamada dentro da transação que aprovou uma versão. */
  private reapproveIfResolved(deliveryId: string) {
    const delivery = this.repo.getDelivery(deliveryId)!;
    const { pending } = this.evaluate(delivery);
    if (shouldAutoReapprove(delivery.status, delivery.approval_round, pending)) this.markApproved(delivery, true);
  }

  private evaluate(delivery: DeliveryRow) {
    const required = this.repo.requiredPieces(delivery.campaign_id);
    const changed = this.repo.piecesChangedAfterApproval(delivery.id);
    const current = this.currentByPiece(delivery.id);
    return { required, changed, current, pending: pendingPieces(required, changed, current) };
  }

  private markApproved(delivery: DeliveryRow, automatic: boolean) {
    const { required, changed, current } = this.evaluate(delivery);
    const round = delivery.approval_round + 1;
    this.repo.markDeliveryApproved(delivery.id, round, this.now());
    this.event(delivery.id, "delivery.approved", round, {
      automatic,
      versions: blockingPieces(required, changed).map((p) => ({
        piece_type: p,
        version_id: current.get(p)!.id,
        number: current.get(p)!.number,
      })),
    });
  }

  // ---------- montagem das respostas ----------

  private event(deliveryId: string, type: string, round: number | null, payload: Record<string, unknown>) {
    this.repo.insertEvent({
      delivery_id: deliveryId,
      type,
      round,
      payload: JSON.stringify(payload),
      created_at: this.now(),
    });
  }

  private currentByPiece(deliveryId: string): Map<string, VersionRow & CurrentVersion> {
    return new Map(this.repo.currentVersions(deliveryId).map((v) => [v.piece_type, v]));
  }

  private versionView(version: VersionRow) {
    const current = this.repo.currentVersion(version.delivery_id, version.piece_type)!;
    return toVersionJson(version, current.id === version.id);
  }

  private deliveryView(delivery: DeliveryRow) {
    const { required, changed, current, pending } = this.evaluate(delivery);
    const blocking = blockingPieces(required, changed);
    const counts = this.repo.versionCounts(delivery.id);
    const pieceTypes = [...blocking, ...[...current.keys()].filter((p) => !blocking.includes(p)).sort()];
    return {
      id: delivery.id,
      campaign_id: delivery.campaign_id,
      creator_id: delivery.creator_id,
      status: delivery.status,
      payable: delivery.status === "aprovada",
      approval_round: delivery.approval_round,
      approved_at: delivery.approved_at,
      created_at: delivery.created_at,
      required_pieces: required,
      blocking_pieces: blocking,
      ready_to_approve: pending.length === 0,
      pending,
      pieces: pieceTypes.map((p) => {
        const v = current.get(p);
        return {
          piece_type: p,
          required: required.includes(p),
          blocking: blocking.includes(p),
          versions_count: counts.get(p) ?? 0,
          current_version: v ? toVersionJson(v, true) : null,
        };
      }),
    };
  }
}

function toVersionJson(v: VersionRow, isCurrent: boolean) {
  return {
    id: v.id,
    delivery_id: v.delivery_id,
    piece_type: v.piece_type,
    number: v.number,
    is_current: isCurrent,
    url: v.url,
    file_name: v.file_name,
    duration_seconds: v.duration_seconds,
    status: v.status,
    review_note: v.review_note,
    created_at: v.created_at,
    reviewed_at: v.reviewed_at,
  };
}

function toCommentJson(c: CommentRow) {
  return { ...c };
}

function toEventJson(e: EventRow) {
  return { id: e.id, type: e.type, round: e.round, payload: JSON.parse(e.payload), created_at: e.created_at };
}
