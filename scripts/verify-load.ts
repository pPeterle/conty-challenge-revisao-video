// Confere as invariantes direto no banco depois da carga. Sai com código 1 se alguma quebrou.
import { DatabaseSync } from "node:sqlite";

const path = process.argv[2];
if (!path) {
  console.error("uso: tsx scripts/verify-load.ts <arquivo.sqlite>");
  process.exit(2);
}
const db = new DatabaseSync(path, { readOnly: true });
const failures: string[] = [];
const all = <T>(sql: string) => db.prepare(sql).all() as T[];

// Peças que bloqueiam cada entrega: as exigidas pela campanha e as não exigidas que mudaram
// depois de uma aprovação.
const BLOCKING = `
  SELECT d.id AS delivery_id, r.piece_type FROM deliveries d
  JOIN campaign_required_pieces r ON r.campaign_id = d.campaign_id
  UNION
  SELECT delivery_id, piece_type FROM delivery_changed_pieces`;

// I1: entrega aprovada => toda peça que bloqueia tem versão atual aprovada.
const brokenApprovals = all<{ id: string; piece_type: string; status: string | null }>(`
  SELECT d.id, r.piece_type, v.status
  FROM deliveries d
  JOIN (${BLOCKING}) r ON r.delivery_id = d.id
  LEFT JOIN piece_versions v ON v.delivery_id = d.id AND v.piece_type = r.piece_type
    AND v.number = (SELECT MAX(number) FROM piece_versions WHERE delivery_id = d.id AND piece_type = r.piece_type)
  WHERE d.status = 'aprovada' AND (v.status IS NULL OR v.status <> 'aprovada')`);
// I8: entrega desfeita (rodada > 0, em produção) sem nenhuma pendência deveria ter voltado a aprovada sozinha.
const stuck = all<{ id: string }>(`
  SELECT d.id FROM deliveries d
  WHERE d.status = 'em_producao' AND d.approval_round > 0
    AND NOT EXISTS (
      SELECT 1 FROM (${BLOCKING}) r
      LEFT JOIN piece_versions v ON v.delivery_id = d.id AND v.piece_type = r.piece_type
        AND v.number = (SELECT MAX(number) FROM piece_versions WHERE delivery_id = d.id AND piece_type = r.piece_type)
      WHERE r.delivery_id = d.id AND (v.status IS NULL OR v.status <> 'aprovada'))`);
for (const s of stuck) failures.push(`entrega ${s.id} desfeita e sem pendência, mas não voltou a aprovada`);

for (const b of brokenApprovals) failures.push(`entrega ${b.id} aprovada com ${b.piece_type} em ${b.status ?? "sem_versao"}`);

// I2: números de versão 1..n por peça, sem repetição nem buraco.
const badNumbers = all<{ delivery_id: string; piece_type: string; n: number; distinct_n: number; max_n: number }>(`
  SELECT delivery_id, piece_type, COUNT(*) AS n, COUNT(DISTINCT number) AS distinct_n, MAX(number) AS max_n
  FROM piece_versions GROUP BY delivery_id, piece_type
  HAVING n <> distinct_n OR n <> max_n`);
for (const b of badNumbers) failures.push(`numeração quebrada em ${b.delivery_id}/${b.piece_type}: ${b.n} versões, max ${b.max_n}`);

// I3: no máximo um delivery.approved por rodada.
const dupApprovals = all<{ delivery_id: string; round: number; n: number }>(`
  SELECT delivery_id, round, COUNT(*) AS n FROM delivery_events
  WHERE type = 'delivery.approved' GROUP BY delivery_id, round HAVING n > 1`);
for (const d of dupApprovals) failures.push(`delivery.approved duplicado em ${d.delivery_id} rodada ${d.round}`);

// I4: aprovações menos revogações bate com o status atual, e approval_round bate com o número de aprovações.
const balance = all<{ id: string; status: string; approval_round: number; approved: number; revoked: number }>(`
  SELECT d.id, d.status, d.approval_round,
    (SELECT COUNT(*) FROM delivery_events e WHERE e.delivery_id = d.id AND e.type = 'delivery.approved') AS approved,
    (SELECT COUNT(*) FROM delivery_events e WHERE e.delivery_id = d.id AND e.type = 'delivery.approval_revoked') AS revoked
  FROM deliveries d`);
for (const b of balance) {
  const expected = b.status === "aprovada" ? 1 : 0;
  if (b.approved - b.revoked !== expected) failures.push(`entrega ${b.id}: ${b.approved} aprovações, ${b.revoked} revogações, status ${b.status}`);
  if (b.approval_round !== b.approved) failures.push(`entrega ${b.id}: approval_round ${b.approval_round} diferente de ${b.approved} eventos`);
}

// I5: comentário dentro da duração da própria versão.
const badComments = all<{ id: string }>(`
  SELECT c.id FROM comments c JOIN piece_versions v ON v.id = c.version_id
  WHERE v.duration_seconds IS NOT NULL AND (c.at_second IS NULL OR c.at_second < 0 OR c.at_second > v.duration_seconds)`);
for (const c of badComments) failures.push(`comentário ${c.id} fora da duração da versão`);

const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
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
  pecas_nao_exigidas_que_passaram_a_bloquear: count("SELECT COUNT(*) AS n FROM delivery_changed_pieces"),
};
console.log("resumo do banco após a carga:", summary);

// Sem aprovação nem revogação a carga não exercitou a regra; isso também é falha.
if (summary.eventos_delivery_approved === 0) failures.push("nenhuma entrega foi aprovada durante a carga");
if (summary.eventos_approval_revoked === 0) failures.push("nenhuma aprovação foi desfeita durante a carga");
if (summary.reaprovacoes_automaticas === 0) failures.push("nenhuma reaprovação automática aconteceu durante a carga");

if (failures.length > 0) {
  console.error(`FALHOU: ${failures.length} violação(ões)`);
  for (const f of failures.slice(0, 50)) console.error(" -", f);
  process.exit(1);
}
console.log("OK: invariantes I1 a I5 e I8 valem em todas as entregas.");
