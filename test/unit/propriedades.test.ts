import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pendingPieces, shouldAutoReapprove, VERSION_STATUSES, type CurrentVersion } from "../../src/domain.ts";

const PIECES = ["roteiro", "video", "capa", "legenda"] as const;

const required = fc.subarray([...PIECES], { minLength: 1 });
const current = fc
  .dictionary(fc.constantFrom(...PIECES), fc.record({ number: fc.integer({ min: 1, max: 50 }), status: fc.constantFrom(...VERSION_STATUSES) }))
  .map((d) => new Map(Object.entries(d).map(([p, v]): [string, CurrentVersion] => [p, { id: `${p}-${v.number}`, ...v }])));

describe("propriedades de pendingPieces", () => {
  it("pendente é exatamente a peça exigida sem versão atual aprovada, na ordem da campanha", () => {
    fc.assert(
      fc.property(required, current, (req, cur) => {
        const expected = req.filter((p) => cur.get(p)?.status !== "aprovada");
        expect(pendingPieces(req, cur).map((p) => p.piece_type)).toEqual(expected);
      }),
    );
  });

  it("peça não exigida nunca aparece, qualquer que seja o estado dela", () => {
    fc.assert(
      fc.property(required, current, (req, cur) => {
        for (const p of pendingPieces(req, cur)) expect(req).toContain(p.piece_type);
      }),
    );
  });

  it("o motivo é sem_versao quando não há versão e versao_atual_nao_aprovada caso contrário", () => {
    fc.assert(
      fc.property(required, current, (req, cur) => {
        for (const p of pendingPieces(req, cur)) {
          expect(p.reason).toBe(cur.has(p.piece_type) ? "versao_atual_nao_aprovada" : "sem_versao");
        }
      }),
    );
  });

  it("mudar o estado de uma peça não exigida não muda o resultado", () => {
    fc.assert(
      fc.property(required, current, fc.constantFrom(...VERSION_STATUSES), (req, cur, status) => {
        const outside = PIECES.filter((p) => !req.includes(p));
        const changed = new Map(cur);
        for (const p of outside) changed.set(p, { id: `${p}-x`, number: 99, status });
        expect(pendingPieces(req, changed)).toEqual(pendingPieces(req, cur));
      }),
    );
  });
});

describe("propriedades de shouldAutoReapprove", () => {
  it("reaprova só entrega desfeita (rodada > 0, em produção) sem pendência", () => {
    fc.assert(
      fc.property(fc.constantFrom("em_producao", "aprovada" as const), fc.nat(5), required, current, (status, round, req, cur) => {
        const pending = pendingPieces(req, cur);
        expect(shouldAutoReapprove(status as "em_producao" | "aprovada", round, pending)).toBe(
          status === "em_producao" && round > 0 && pending.length === 0,
        );
      }),
    );
  });
});
