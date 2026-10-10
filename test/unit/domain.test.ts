import { describe, expect, it } from "vitest";
import {
  blockingPieces,
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
    const pending = pendingPieces(["roteiro", "video"], [], new Map());
    expect(pending).toEqual([
      { piece_type: "roteiro", required: true, reason: "sem_versao" },
      { piece_type: "video", required: true, reason: "sem_versao" },
    ]);
  });

  it("aponta peça exigida cuja versão atual não está aprovada", () => {
    const pending = pendingPieces(["video", "capa"], [], new Map([["video", v(2, "em_revisao")], ["capa", v(1, "aprovada")]]));
    expect(pending).toEqual([
      {
        piece_type: "video",
        required: true,
        reason: "versao_atual_nao_aprovada",
        current_version: { id: "v2", number: 2, status: "em_revisao" },
      },
    ]);
  });

  it("peça não exigida pendente não bloqueia a primeira aprovação", () => {
    const pending = pendingPieces(["video"], [], new Map([["video", v(1, "aprovada")], ["roteiro", v(1, "em_revisao")]]));
    expect(pending).toEqual([]);
  });

  it("peça não exigida que mudou depois da aprovação passa a bloquear até a versão nova ser aprovada", () => {
    const current = new Map([["video", v(1, "aprovada")], ["legenda", v(2, "em_revisao")]]);
    expect(pendingPieces(["video"], ["legenda"], current)).toEqual([
      {
        piece_type: "legenda",
        required: false,
        reason: "versao_atual_nao_aprovada",
        current_version: { id: "v2", number: 2, status: "em_revisao" },
      },
    ]);
    current.set("legenda", v(2, "aprovada"));
    expect(pendingPieces(["video"], ["legenda"], current)).toEqual([]);
  });

  it("campanha só de vídeo não exige roteiro", () => {
    expect(pendingPieces(["video"], [], new Map([["video", v(1, "aprovada")]]))).toEqual([]);
  });

  it("a regra depende só da lista recebida: mesma entrega, listas diferentes, resultados diferentes", () => {
    const current = new Map([["video", v(1, "aprovada")]]);
    expect(pendingPieces(["video"], [], current)).toHaveLength(0);
    expect(pendingPieces(["roteiro", "video", "capa", "legenda"], [], current).map((p) => p.piece_type)).toEqual([
      "roteiro",
      "capa",
      "legenda",
    ]);
  });
});

describe("blockingPieces", () => {
  it("junta exigidas e alteradas depois da aprovação, sem repetir", () => {
    expect(blockingPieces(["video", "capa"], ["capa", "legenda"])).toEqual(["video", "capa", "legenda"]);
  });
});

describe("describePending", () => {
  it("monta uma mensagem que diz qual peça falta e por quê", () => {
    const msg = describePending([
      { piece_type: "roteiro", required: true, reason: "sem_versao" },
      {
        piece_type: "capa",
        required: true,
        reason: "versao_atual_nao_aprovada",
        current_version: { id: "x", number: 2, status: "alteracao_solicitada" },
      },
      {
        piece_type: "legenda",
        required: false,
        reason: "versao_atual_nao_aprovada",
        current_version: { id: "y", number: 3, status: "em_revisao" },
      },
    ]);
    expect(msg).toBe(
      "A entrega não pode ser aprovada. Peças pendentes: roteiro: nenhuma versão enviada; capa: versão atual v2 com alteração solicitada; legenda (não exigida, mudou depois da aprovação): versão atual v3 em revisão.",
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
  it("versão nova em entrega aprovada desfaz a aprovação, seja qual for a peça", () => {
    expect(submissionRevokesApproval("aprovada")).toBe(true);
  });

  it("entrega em produção não tem o que desfazer", () => {
    expect(submissionRevokesApproval("em_producao")).toBe(false);
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
    expect(shouldAutoReapprove("em_producao", 1, [{ piece_type: "video", required: true, reason: "sem_versao" }])).toBe(false);
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
