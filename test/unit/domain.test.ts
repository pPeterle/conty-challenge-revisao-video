import { describe, expect, it } from "vitest";
import {
  describePending,
  isValidAtSecond,
  pendingPieces,
  reviewTransition,
  shouldAutoReapprove,
  submissionRevokesApproval,
  type CurrentVersion,
} from "../../src/domain.ts";

const v = (number: number, status: CurrentVersion["status"]): CurrentVersion => ({ id: `v${number}`, number, status });

describe("pendingPieces", () => {
  it("lista cada peça exigida sem versão como sem_versao", () => {
    const pending = pendingPieces(["roteiro", "video"], new Map());
    expect(pending).toEqual([
      { piece_type: "roteiro", reason: "sem_versao" },
      { piece_type: "video", reason: "sem_versao" },
    ]);
  });

  it("aponta peça exigida cuja versão atual não está aprovada", () => {
    const pending = pendingPieces(["video", "capa"], new Map([["video", v(2, "em_revisao")], ["capa", v(1, "aprovada")]]));
    expect(pending).toEqual([
      {
        piece_type: "video",
        reason: "versao_atual_nao_aprovada",
        current_version: { id: "v2", number: 2, status: "em_revisao" },
      },
    ]);
  });

  it("peça não exigida pendente não bloqueia a primeira aprovação", () => {
    const pending = pendingPieces(["video"], new Map([["video", v(1, "aprovada")], ["roteiro", v(1, "em_revisao")]]));
    expect(pending).toEqual([]);
  });

  it("campanha só de vídeo não exige roteiro", () => {
    expect(pendingPieces(["video"], new Map([["video", v(1, "aprovada")]]))).toEqual([]);
  });

  it("a regra depende só da lista recebida: mesma entrega, listas diferentes, resultados diferentes", () => {
    const current = new Map([["video", v(1, "aprovada")]]);
    expect(pendingPieces(["video"], current)).toHaveLength(0);
    expect(pendingPieces(["roteiro", "video", "capa", "legenda"], current).map((p) => p.piece_type)).toEqual([
      "roteiro",
      "capa",
      "legenda",
    ]);
  });
});

describe("describePending", () => {
  it("monta uma mensagem que diz qual peça falta e por quê", () => {
    const msg = describePending([
      { piece_type: "roteiro", reason: "sem_versao" },
      {
        piece_type: "capa",
        reason: "versao_atual_nao_aprovada",
        current_version: { id: "x", number: 2, status: "alteracao_solicitada" },
      },
    ]);
    expect(msg).toBe(
      "A entrega não pode ser aprovada. Peças exigidas pendentes: roteiro: nenhuma versão enviada; capa: versão atual v2 com alteração solicitada.",
    );
  });
});

describe("reviewTransition", () => {
  it("em_revisao aceita qualquer decisão", () => {
    expect(reviewTransition("em_revisao", "aprovada")).toEqual({ kind: "apply" });
    expect(reviewTransition("em_revisao", "alteracao_solicitada")).toEqual({ kind: "apply" });
  });

  it("repetir a mesma decisão não faz nada", () => {
    expect(reviewTransition("aprovada", "aprovada")).toEqual({ kind: "noop" });
    expect(reviewTransition("alteracao_solicitada", "alteracao_solicitada")).toEqual({ kind: "noop" });
  });

  it("decisão contrária sobre versão já revisada é inválida", () => {
    expect(reviewTransition("aprovada", "alteracao_solicitada")).toEqual({ kind: "invalid", from: "aprovada" });
    expect(reviewTransition("alteracao_solicitada", "aprovada")).toEqual({ kind: "invalid", from: "alteracao_solicitada" });
  });
});

describe("submissionRevokesApproval", () => {
  it("versão nova em peça exigida de entrega aprovada desfaz a aprovação", () => {
    expect(submissionRevokesApproval("aprovada", "video", ["video", "capa"])).toBe(true);
  });

  it("entrega em produção não tem o que desfazer", () => {
    expect(submissionRevokesApproval("em_producao", "video", ["video"])).toBe(false);
  });

  it("peça não exigida não desfaz", () => {
    expect(submissionRevokesApproval("aprovada", "roteiro", ["video"])).toBe(false);
  });
});

describe("shouldAutoReapprove", () => {
  it("entrega desfeita volta a aprovada quando não resta pendência", () => {
    expect(shouldAutoReapprove("em_producao", 1, [])).toBe(true);
  });

  it("primeira aprovação nunca é automática", () => {
    expect(shouldAutoReapprove("em_producao", 0, [])).toBe(false);
  });

  it("com pendência, ou já aprovada, não faz nada", () => {
    expect(shouldAutoReapprove("em_producao", 1, [{ piece_type: "video", reason: "sem_versao" }])).toBe(false);
    expect(shouldAutoReapprove("aprovada", 1, [])).toBe(false);
  });
});

describe("isValidAtSecond", () => {
  it("aceita de 0 até a duração, inclusive", () => {
    expect(isValidAtSecond(0, 30)).toBe(true);
    expect(isValidAtSecond(12.5, 30)).toBe(true);
    expect(isValidAtSecond(30, 30)).toBe(true);
  });

  it("recusa negativo e além da duração", () => {
    expect(isValidAtSecond(-1, 30)).toBe(false);
    expect(isValidAtSecond(30.01, 30)).toBe(false);
  });
});
