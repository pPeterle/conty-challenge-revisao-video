// Teste baseado em modelo: sequências aleatórias de ações contra a API e contra um modelo de
// referência escrito a partir do enunciado. O estado é comparado depois de cada passo.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { setup } from "./helpers.ts";

const PIECES = ["roteiro", "video", "capa", "legenda"] as const;
type Piece = (typeof PIECES)[number];
type Status = "em_revisao" | "alteracao_solicitada" | "aprovada";

/** Modelo de referência: só o que o enunciado diz, sem olhar o código. */
class Model {
  versions = new Map<Piece, Status[]>();
  approved = false;
  round = 0;

  constructor(readonly required: Piece[]) {}

  current(p: Piece): Status | undefined {
    return this.versions.get(p)?.at(-1);
  }

  /** "A entrega só pode ser aprovada quando cada peça exigida tem uma versão aprovada" (a atual). */
  pending(): Piece[] {
    return this.required.filter((p) => this.current(p) !== "aprovada");
  }

  submit(p: Piece): { revoked: boolean } {
    this.versions.set(p, [...(this.versions.get(p) ?? []), "em_revisao"]);
    // Versão nova desfaz a aprovação; peça não pedida não conta.
    const revoked = this.approved && this.required.includes(p);
    if (revoked) this.approved = false;
    return { revoked };
  }

  review(p: Piece, decision: Exclude<Status, "em_revisao">): number {
    const list = this.versions.get(p)!;
    const status = list.at(-1)!;
    if (status === decision) return 200;
    if (status !== "em_revisao") return 409;
    list[list.length - 1] = decision;
    // "deixa de estar aprovada até a nova versão ser aprovada": aprovada a pendência, volta.
    if (decision === "aprovada" && !this.approved && this.round > 0 && this.pending().length === 0) {
      this.approved = true;
      this.round++;
    }
    return 200;
  }

  approveDelivery(): number {
    if (this.approved) return 200;
    if (this.pending().length > 0) return 422;
    this.approved = true;
    this.round++;
    return 200;
  }
}

type Action =
  | { kind: "submit"; piece: Piece }
  | { kind: "approve"; piece: Piece }
  | { kind: "requestChanges"; piece: Piece }
  | { kind: "approveStale"; piece: Piece }
  | { kind: "approveDelivery" };

const piece = fc.constantFrom(...PIECES);
const action: fc.Arbitrary<Action> = fc.oneof(
  { arbitrary: piece.map((p) => ({ kind: "submit" as const, piece: p })), weight: 3 },
  { arbitrary: piece.map((p) => ({ kind: "approve" as const, piece: p })), weight: 4 },
  { arbitrary: piece.map((p) => ({ kind: "requestChanges" as const, piece: p })), weight: 1 },
  { arbitrary: piece.map((p) => ({ kind: "approveStale" as const, piece: p })), weight: 1 },
  { arbitrary: fc.constant({ kind: "approveDelivery" as const }), weight: 2 },
);

describe("API contra o modelo de referência", () => {
  it("qualquer sequência de envios, revisões e aprovações deixa a API no mesmo estado do modelo", async () => {
    await fc.assert(
      fc.asyncProperty(fc.subarray([...PIECES], { minLength: 1 }), fc.array(action, { minLength: 1, maxLength: 30 }), async (required, actions) => {
        const t = setup();
        const d = await t.delivery(required);
        const model = new Model(required);
        const ids = new Map<Piece, string[]>();

        for (const a of actions) {
          if (a.kind === "submit") {
            const res = await t.submit(d.id, a.piece);
            expect(res.status).toBe(201);
            ids.set(a.piece, [...(ids.get(a.piece) ?? []), res.body.version.id]);
            expect(res.body.approval_revoked).toBe(model.submit(a.piece).revoked);
          } else if (a.kind === "approve" || a.kind === "requestChanges") {
            const versionId = ids.get(a.piece)?.at(-1);
            if (!versionId) continue;
            const path = a.kind === "approve" ? "approve" : "request-changes";
            const res = await t.call("POST", `/versions/${versionId}/${path}`);
            expect(res.status).toBe(model.review(a.piece, a.kind === "approve" ? "aprovada" : "alteracao_solicitada"));
          } else if (a.kind === "approveStale") {
            const list = ids.get(a.piece) ?? [];
            if (list.length < 2) continue;
            const res = await t.call("POST", `/versions/${list[0]}/approve`);
            expect(res.status).toBe(409);
            expect(res.body.error.code).toBe("versao_desatualizada");
          } else {
            const res = await t.call("POST", `/deliveries/${d.id}/approve`);
            expect(res.status).toBe(model.approveDelivery());
          }

          const view = (await t.call("GET", `/deliveries/${d.id}`)).body;
          expect(view.status).toBe(model.approved ? "aprovada" : "em_producao");
          expect(view.payable).toBe(model.approved);
          expect(view.approval_round).toBe(model.round);
          expect(view.pending.map((p: { piece_type: string }) => p.piece_type)).toEqual(model.pending());
          for (const p of PIECES) {
            const shown = view.pieces.find((x: { piece_type: string }) => x.piece_type === p)?.current_version;
            expect(shown?.status).toBe(model.current(p));
            expect(shown?.number).toBe(model.versions.get(p)?.length);
          }
        }
      }),
      { numRuns: 150 },
    );
  }, 60_000);
});
