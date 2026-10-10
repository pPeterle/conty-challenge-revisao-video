// Muitos clientes enviando versões e aprovando (versões e entregas) ao mesmo tempo, sobre poucas
// entregas, para forçar disputa na mesma peça. 409 e 422 são respostas esperadas da regra.
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:3106";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };
const PIECES = ["roteiro", "video", "capa", "legenda"];

http.setResponseCallback(http.expectedStatuses(200, 201, 409, 422));

const deliveriesApproved = new Counter("deliveries_approved");
const approvalsRevoked = new Counter("approvals_revoked");
const staleApprovals = new Counter("stale_version_approvals");
const blockedApprovals = new Counter("blocked_delivery_approvals");

export const options = {
  scenarios: {
    revisao: {
      executor: "ramping-vus",
      startVUs: 5,
      stages: [
        { duration: "10s", target: 50 },
        { duration: "30s", target: 50 },
        { duration: "5s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<300"],
    checks: ["rate>0.99"],
  },
};

function post(path, body) {
  return http.post(`${BASE}${path}`, JSON.stringify(body ?? {}), JSON_HEADERS);
}

export function setup() {
  const deliveries = [];
  const shapes = [PIECES, ["video"], ["video", "capa"]];
  for (let i = 0; i < 24; i++) {
    const required = shapes[i % shapes.length];
    const campaign = post("/campaigns", { name: `Campanha carga ${i}`, required_pieces: required }).json();
    const delivery = post(`/campaigns/${campaign.id}/deliveries`, { creator_id: `criador-${i}` }).json();
    deliveries.push(delivery.id);
  }
  return { deliveries };
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function submitVersion(deliveryId) {
  const piece = pick(PIECES);
  const body =
    piece === "video"
      ? { url: `https://cdn.exemplo/${deliveryId}/${Date.now()}.mp4`, duration_seconds: 15 + Math.floor(Math.random() * 45) }
      : { file_name: `${piece}-${Date.now()}.pdf` };
  const res = post(`/deliveries/${deliveryId}/pieces/${piece}/versions`, body);
  check(res, { "envio de versão: 201": (r) => r.status === 201 });
  if (res.status === 201 && res.json("approval_revoked")) approvalsRevoked.add(1);
}

function reviewCurrent(deliveryId) {
  const view = http.get(`${BASE}/deliveries/${deliveryId}`);
  check(view, { "GET entrega: 200": (r) => r.status === 200 });
  if (view.status !== 200) return;
  const inReview = view.json("pieces").filter((p) => p.current_version && p.current_version.status === "em_revisao");
  if (inReview.length === 0) return;
  const version = pick(inReview).current_version;
  const requestChanges = Math.random() < 0.15;
  const res = requestChanges ? post(`/versions/${version.id}/request-changes`, { note: "ajustar" }) : post(`/versions/${version.id}/approve`);
  check(res, {
    "revisão de versão: 200 ou 409 conhecido": (r) =>
      r.status === 200 || (r.status === 409 && ["versao_desatualizada", "transicao_invalida"].includes(r.json("error.code"))),
  });
  if (res.status === 409 && res.json("error.code") === "versao_desatualizada") staleApprovals.add(1);
}

function approveDelivery(deliveryId) {
  const res = post(`/deliveries/${deliveryId}/approve`);
  check(res, {
    "aprovação da entrega: 200 ou 422 pecas_pendentes": (r) =>
      r.status === 200 || (r.status === 422 && r.json("error.code") === "pecas_pendentes"),
  });
  if (res.status === 200 && res.json("already_approved") === false) deliveriesApproved.add(1);
  if (res.status === 422) blockedApprovals.add(1);
}

function comment(deliveryId) {
  const view = http.get(`${BASE}/deliveries/${deliveryId}`);
  if (view.status !== 200) return;
  const video = view.json("pieces").find((p) => p.piece_type === "video" && p.current_version);
  if (!video) return;
  const v = video.current_version;
  const res = post(`/versions/${v.id}/comments`, {
    author: "marca",
    body: "comentário de carga",
    at_second: Math.floor(Math.random() * v.duration_seconds),
  });
  check(res, { "comentário: 201": (r) => r.status === 201 });
}

export default function (data) {
  const deliveryId = pick(data.deliveries);
  const roll = Math.random();
  if (roll < 0.3) submitVersion(deliveryId);
  else if (roll < 0.7) reviewCurrent(deliveryId);
  else if (roll < 0.92) approveDelivery(deliveryId);
  else comment(deliveryId);
}
