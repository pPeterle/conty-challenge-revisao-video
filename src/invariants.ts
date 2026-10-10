// Invariantes do modelo conferidas direto no banco. Usado pela verificação da carga e pelo teste
// com várias conexões; a numeração segue docs/design.md.
import type { DatabaseSync } from "node:sqlite";

const REQUIRED = `
  SELECT d.id AS delivery_id, r.piece_type FROM deliveries d
  JOIN campaign_required_pieces r ON r.campaign_id = d.campaign_id`;

const CURRENT_VERSION_JOIN = `
  LEFT JOIN piece_versions v ON v.delivery_id = d.id AND v.piece_type = r.piece_type
    AND v.number = (SELECT MAX(number) FROM piece_versions WHERE delivery_id = d.id AND piece_type = r.piece_type)`;

export interface InvariantReport {
  failures: string[];
  summary: Record<string, number>;
}

export function checkInvariants(db: DatabaseSync): InvariantReport {
  const failures: string[] = [];
  const all = <T>(sql: string) => db.prepare(sql).all() as T[];
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

  // I1: entrega aprovada => toda peça exigida tem versão atual aprovada.
  for (const b of all<{ id: string; piece_type: string; status: string | null }>(`
    SELECT d.id, r.piece_type, v.status
    FROM deliveries d JOIN (${REQUIRED}) r ON r.delivery_id = d.id ${CURRENT_VERSION_JOIN}
    WHERE d.status = 'aprovada' AND (v.status IS NULL OR v.status <> 'aprovada')`)) {
    failures.push(`I1: entrega ${b.id} aprovada com ${b.piece_type} em ${b.status ?? "sem_versao"}`);
  }

  // I2: números de versão 1..n por peça, sem repetição nem buraco.
  for (const b of all<{ delivery_id: string; piece_type: string; n: number; max_n: number }>(`
    SELECT delivery_id, piece_type, COUNT(*) AS n, COUNT(DISTINCT number) AS distinct_n, MAX(number) AS max_n
    FROM piece_versions GROUP BY delivery_id, piece_type
    HAVING n <> distinct_n OR n <> max_n`)) {
    failures.push(`I2: numeração quebrada em ${b.delivery_id}/${b.piece_type}: ${b.n} versões, max ${b.max_n}`);
  }

  // I3: no máximo um delivery.approved por rodada.
  for (const d of all<{ delivery_id: string; round: number }>(`
    SELECT delivery_id, round, COUNT(*) AS n FROM delivery_events
    WHERE type = 'delivery.approved' GROUP BY delivery_id, round HAVING n > 1`)) {
    failures.push(`I3: delivery.approved duplicado em ${d.delivery_id} rodada ${d.round}`);
  }

  // I4: aprovações menos revogações bate com o status, e approval_round com o número de aprovações.
  for (const b of all<{ id: string; status: string; approval_round: number; approved: number; revoked: number }>(`
    SELECT d.id, d.status, d.approval_round,
      (SELECT COUNT(*) FROM delivery_events e WHERE e.delivery_id = d.id AND e.type = 'delivery.approved') AS approved,
      (SELECT COUNT(*) FROM delivery_events e WHERE e.delivery_id = d.id AND e.type = 'delivery.approval_revoked') AS revoked
    FROM deliveries d`)) {
    const expected = b.status === "aprovada" ? 1 : 0;
    if (b.approved - b.revoked !== expected) {
      failures.push(`I4: entrega ${b.id} com ${b.approved} aprovações, ${b.revoked} revogações e status ${b.status}`);
    }
    if (b.approval_round !== b.approved) {
      failures.push(`I4: entrega ${b.id} com approval_round ${b.approval_round} e ${b.approved} eventos de aprovação`);
    }
  }

  // I5: comentário dentro da duração da própria versão.
  for (const c of all<{ id: string }>(`
    SELECT c.id FROM comments c JOIN piece_versions v ON v.id = c.version_id
    WHERE v.duration_seconds IS NOT NULL AND (c.at_second IS NULL OR c.at_second < 0 OR c.at_second > v.duration_seconds)`)) {
    failures.push(`I5: comentário ${c.id} fora da duração da versão`);
  }

  // I8: entrega desfeita (rodada > 0, em produção) sem pendência já deveria ter voltado a aprovada.
  for (const s of all<{ id: string }>(`
    SELECT d.id FROM deliveries d
    WHERE d.status = 'em_producao' AND d.approval_round > 0
      AND NOT EXISTS (
        SELECT 1 FROM (${REQUIRED}) r ${CURRENT_VERSION_JOIN}
        WHERE r.delivery_id = d.id AND (v.status IS NULL OR v.status <> 'aprovada'))`)) {
    failures.push(`I8: entrega ${s.id} desfeita e sem pendência, mas não voltou a aprovada`);
  }

  const summary = {
    entregas: count("SELECT COUNT(*) AS n FROM deliveries"),
    entregas_aprovadas_agora: count("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'aprovada'"),
    versoes: count("SELECT COUNT(*) AS n FROM piece_versions"),
    versoes_aprovadas: count("SELECT COUNT(*) AS n FROM piece_versions WHERE status = 'aprovada'"),
    comentarios: count("SELECT COUNT(*) AS n FROM comments"),
    eventos_delivery_approved: count("SELECT COUNT(*) AS n FROM delivery_events WHERE type = 'delivery.approved'"),
    eventos_approval_revoked: count("SELECT COUNT(*) AS n FROM delivery_events WHERE type = 'delivery.approval_revoked'"),
    reaprovacoes_automaticas: count(
      "SELECT COUNT(*) AS n FROM delivery_events WHERE type = 'delivery.approved' AND json_extract(payload, '$.automatic') = 1",
    ),
  };
  return { failures, summary };
}
