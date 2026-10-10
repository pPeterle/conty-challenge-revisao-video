// Confere as invariantes direto no banco depois da carga. Sai com código 1 se alguma quebrou.
import { DatabaseSync } from "node:sqlite";
import { checkInvariants } from "../src/invariants.ts";

const path = process.argv[2];
if (!path) {
  console.error("uso: tsx scripts/verify-load.ts <arquivo.sqlite>");
  process.exit(2);
}
const { failures, summary } = checkInvariants(new DatabaseSync(path, { readOnly: true }));
console.log("resumo do banco após a carga:", summary);

// Sem aprovação, revogação e reaprovação a carga não exercitou a regra; isso também é falha.
if (summary.eventos_delivery_approved === 0) failures.push("nenhuma entrega foi aprovada durante a carga");
if (summary.eventos_approval_revoked === 0) failures.push("nenhuma aprovação foi desfeita durante a carga");
if (summary.reaprovacoes_automaticas === 0) failures.push("nenhuma reaprovação automática aconteceu durante a carga");

if (failures.length > 0) {
  console.error(`FALHOU: ${failures.length} violação(ões)`);
  for (const f of failures.slice(0, 50)) console.error(" -", f);
  process.exit(1);
}
console.log("OK: invariantes I1 a I5 e I8 valem em todas as entregas.");
