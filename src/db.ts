import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DeliveryStatus, VersionStatus } from "./domain.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS piece_types (
  code  TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  timed INTEGER NOT NULL CHECK (timed IN (0, 1))
);

CREATE TABLE IF NOT EXISTS campaigns (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_required_pieces (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  piece_type  TEXT NOT NULL REFERENCES piece_types(code),
  PRIMARY KEY (campaign_id, piece_type)
);

CREATE TABLE IF NOT EXISTS deliveries (
  id             TEXT PRIMARY KEY,
  campaign_id    TEXT NOT NULL REFERENCES campaigns(id),
  creator_id     TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('em_producao', 'aprovada')),
  approval_round INTEGER NOT NULL DEFAULT 0,
  approved_at    TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (campaign_id, creator_id)
);

CREATE TABLE IF NOT EXISTS piece_versions (
  id               TEXT PRIMARY KEY,
  delivery_id      TEXT NOT NULL REFERENCES deliveries(id),
  piece_type       TEXT NOT NULL REFERENCES piece_types(code),
  number           INTEGER NOT NULL CHECK (number >= 1),
  url              TEXT,
  file_name        TEXT,
  duration_seconds REAL,
  status           TEXT NOT NULL CHECK (status IN ('em_revisao', 'alteracao_solicitada', 'aprovada')),
  review_note      TEXT,
  created_at       TEXT NOT NULL,
  reviewed_at      TEXT,
  UNIQUE (delivery_id, piece_type, number)
);

-- Peça não exigida que recebeu versão nova com a entrega aprovada passa a bloquear a reaprovação.
CREATE TABLE IF NOT EXISTS delivery_changed_pieces (
  delivery_id TEXT NOT NULL REFERENCES deliveries(id),
  piece_type  TEXT NOT NULL REFERENCES piece_types(code),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (delivery_id, piece_type)
);

CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES piece_versions(id),
  author     TEXT NOT NULL,
  body       TEXT NOT NULL,
  at_second  REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_by_version ON comments (version_id, at_second);

CREATE TABLE IF NOT EXISTS delivery_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id),
  type        TEXT NOT NULL,
  round       INTEGER,
  payload     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_delivery ON delivery_events (delivery_id, id);
-- Rede de segurança: uma rodada de aprovação só pode ser emitida (e revogada) uma vez.
CREATE UNIQUE INDEX IF NOT EXISTS one_approval_per_round
  ON delivery_events (delivery_id, round) WHERE type = 'delivery.approved';
CREATE UNIQUE INDEX IF NOT EXISTS one_revocation_per_round
  ON delivery_events (delivery_id, round) WHERE type = 'delivery.approval_revoked';

INSERT INTO piece_types (code, label, timed) VALUES
  ('roteiro', 'Roteiro', 0),
  ('video',   'Vídeo',   1),
  ('capa',    'Capa',    0),
  ('legenda', 'Legenda', 0)
ON CONFLICT (code) DO NOTHING;
`;

export interface PieceTypeRow {
  code: string;
  label: string;
  timed: number;
}

export interface CampaignRow {
  id: string;
  name: string;
  created_at: string;
}

export interface DeliveryRow {
  id: string;
  campaign_id: string;
  creator_id: string;
  status: DeliveryStatus;
  approval_round: number;
  approved_at: string | null;
  created_at: string;
}

export interface VersionRow {
  id: string;
  delivery_id: string;
  piece_type: string;
  number: number;
  url: string | null;
  file_name: string | null;
  duration_seconds: number | null;
  status: VersionStatus;
  review_note: string | null;
  created_at: string;
  reviewed_at: string | null;
}

export interface CommentRow {
  id: string;
  version_id: string;
  author: string;
  body: string;
  at_second: number | null;
  created_at: string;
}

export interface EventRow {
  id: number;
  delivery_id: string;
  type: string;
  round: number | null;
  payload: string;
  created_at: string;
}

export interface Page {
  limit: number;
  offset: number;
}

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

/**
 * Toda escrita passa por aqui. BEGIN IMMEDIATE pega o lock de escrita antes da primeira leitura,
 * então a checagem e a gravação enxergam o mesmo estado. A função precisa ser síncrona.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export class Repository {
  constructor(readonly db: DatabaseSync) {}

  listPieceTypes(): PieceTypeRow[] {
    return this.db.prepare("SELECT code, label, timed FROM piece_types ORDER BY rowid").all() as unknown as PieceTypeRow[];
  }

  getPieceType(code: string): PieceTypeRow | undefined {
    return this.db.prepare("SELECT code, label, timed FROM piece_types WHERE code = ?").get(code) as
      | PieceTypeRow
      | undefined;
  }

  insertCampaign(c: CampaignRow, requiredPieces: readonly string[]): void {
    this.db.prepare("INSERT INTO campaigns (id, name, created_at) VALUES (?, ?, ?)").run(c.id, c.name, c.created_at);
    const insertPiece = this.db.prepare("INSERT INTO campaign_required_pieces (campaign_id, piece_type) VALUES (?, ?)");
    for (const piece of requiredPieces) insertPiece.run(c.id, piece);
  }

  getCampaign(id: string): CampaignRow | undefined {
    return this.db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as CampaignRow | undefined;
  }

  requiredPieces(campaignId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT r.piece_type FROM campaign_required_pieces r
         JOIN piece_types t ON t.code = r.piece_type
         WHERE r.campaign_id = ? ORDER BY t.rowid`,
      )
      .all(campaignId) as { piece_type: string }[];
    return rows.map((r) => r.piece_type);
  }

  insertDeliveryIfAbsent(d: DeliveryRow): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO deliveries (id, campaign_id, creator_id, status, approval_round, approved_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (campaign_id, creator_id) DO NOTHING`,
      )
      .run(d.id, d.campaign_id, d.creator_id, d.status, d.approval_round, d.approved_at, d.created_at);
    return result.changes === 1;
  }

  getDelivery(id: string): DeliveryRow | undefined {
    return this.db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id) as DeliveryRow | undefined;
  }

  getDeliveryByCreator(campaignId: string, creatorId: string): DeliveryRow | undefined {
    return this.db.prepare("SELECT * FROM deliveries WHERE campaign_id = ? AND creator_id = ?").get(campaignId, creatorId) as
      | DeliveryRow
      | undefined;
  }

  markPieceChangedAfterApproval(deliveryId: string, pieceType: string, at: string): void {
    this.db
      .prepare(
        `INSERT INTO delivery_changed_pieces (delivery_id, piece_type, created_at) VALUES (?, ?, ?)
         ON CONFLICT (delivery_id, piece_type) DO NOTHING`,
      )
      .run(deliveryId, pieceType, at);
  }

  piecesChangedAfterApproval(deliveryId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT c.piece_type FROM delivery_changed_pieces c JOIN piece_types t ON t.code = c.piece_type
         WHERE c.delivery_id = ? ORDER BY t.rowid`,
      )
      .all(deliveryId) as { piece_type: string }[];
    return rows.map((r) => r.piece_type);
  }

  markDeliveryApproved(id: string, round: number, at: string): void {
    this.db
      .prepare("UPDATE deliveries SET status = 'aprovada', approval_round = ?, approved_at = ? WHERE id = ?")
      .run(round, at, id);
  }

  markDeliveryInProduction(id: string): void {
    this.db.prepare("UPDATE deliveries SET status = 'em_producao', approved_at = NULL WHERE id = ?").run(id);
  }

  nextVersionNumber(deliveryId: string, pieceType: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(number), 0) + 1 AS next FROM piece_versions WHERE delivery_id = ? AND piece_type = ?")
      .get(deliveryId, pieceType) as { next: number };
    return row.next;
  }

  insertVersion(v: VersionRow): void {
    this.db
      .prepare(
        `INSERT INTO piece_versions
           (id, delivery_id, piece_type, number, url, file_name, duration_seconds, status, review_note, created_at, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        v.id,
        v.delivery_id,
        v.piece_type,
        v.number,
        v.url,
        v.file_name,
        v.duration_seconds,
        v.status,
        v.review_note,
        v.created_at,
        v.reviewed_at,
      );
  }

  getVersion(id: string): VersionRow | undefined {
    return this.db.prepare("SELECT * FROM piece_versions WHERE id = ?").get(id) as VersionRow | undefined;
  }

  currentVersion(deliveryId: string, pieceType: string): VersionRow | undefined {
    return this.db
      .prepare("SELECT * FROM piece_versions WHERE delivery_id = ? AND piece_type = ? ORDER BY number DESC LIMIT 1")
      .get(deliveryId, pieceType) as VersionRow | undefined;
  }

  /** Versão atual (maior número) de cada peça enviada na entrega. */
  currentVersions(deliveryId: string): VersionRow[] {
    return this.db
      .prepare(
        `SELECT v.* FROM piece_versions v
         WHERE v.delivery_id = ?
           AND v.number = (SELECT MAX(number) FROM piece_versions
                           WHERE delivery_id = v.delivery_id AND piece_type = v.piece_type)`,
      )
      .all(deliveryId) as unknown as VersionRow[];
  }

  versionCounts(deliveryId: string): Map<string, number> {
    const rows = this.db
      .prepare("SELECT piece_type, COUNT(*) AS n FROM piece_versions WHERE delivery_id = ? GROUP BY piece_type")
      .all(deliveryId) as { piece_type: string; n: number }[];
    return new Map(rows.map((r) => [r.piece_type, r.n]));
  }

  listVersions(deliveryId: string, pieceType: string, page: Page): VersionRow[] {
    return this.db
      .prepare("SELECT * FROM piece_versions WHERE delivery_id = ? AND piece_type = ? ORDER BY number LIMIT ? OFFSET ?")
      .all(deliveryId, pieceType, page.limit, page.offset) as unknown as VersionRow[];
  }

  setVersionReview(id: string, status: VersionStatus, note: string | null, at: string): void {
    this.db
      .prepare("UPDATE piece_versions SET status = ?, review_note = ?, reviewed_at = ? WHERE id = ?")
      .run(status, note, at, id);
  }

  insertComment(c: CommentRow): void {
    this.db
      .prepare("INSERT INTO comments (id, version_id, author, body, at_second, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(c.id, c.version_id, c.author, c.body, c.at_second, c.created_at);
  }

  listComments(versionId: string, page: Page): CommentRow[] {
    return this.db
      .prepare("SELECT * FROM comments WHERE version_id = ? ORDER BY at_second, created_at, rowid LIMIT ? OFFSET ?")
      .all(versionId, page.limit, page.offset) as unknown as CommentRow[];
  }

  insertEvent(e: Omit<EventRow, "id">): void {
    this.db
      .prepare("INSERT INTO delivery_events (delivery_id, type, round, payload, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(e.delivery_id, e.type, e.round, e.payload, e.created_at);
  }

  listEvents(deliveryId: string, page: Page): EventRow[] {
    return this.db
      .prepare("SELECT * FROM delivery_events WHERE delivery_id = ? ORDER BY id LIMIT ? OFFSET ?")
      .all(deliveryId, page.limit, page.offset) as unknown as EventRow[];
  }
}
