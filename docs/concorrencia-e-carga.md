# Concorrência, validação e carga

Detalhes que saíram do [README](../README.md): como a entrada é validada, como a concorrência é tratada e testada, por que sqlite basta nesta escala e o resultado do teste de carga.

## Validação e limites

Corpo, params e query passam por schemas zod em `src/schemas.ts`, com um único hook que converte o erro no formato `{ "error": { "code", "message", "details" } }` descrito no README. JSON malformado, `null`, array ou valor solto no lugar de objeto, tipo errado, string vazia ou só espaços, número negativo ou não finito e id fora do formato `[A-Za-z0-9-]{1,64}` dão 400. Campo desconhecido no corpo, inclusive `__proto__`, dá 400 com o nome do campo em `details.issues` (os schemas de corpo são `strict`). `at_second` negativo é erro de formato (400); passar da duração da versão é regra de negócio (422 `segundo_fora_da_duracao`). Rota com corpo exige `Content-Type: application/json` e responde 415 `content_type_invalido` se ele faltar ou for outro; a exceção é `request-changes`, cujo corpo é opcional e aceita POST sem corpo nenhum. Limites: corpo de 64 KB (413), `required_pieces` com até 20 itens, `duration_seconds` até 21600, textos com teto de tamanho, `limit` de 1 a 500 (padrão 100) e `offset` inteiro não negativo nas listagens. Os casos estão em `test/integration/payloads-invalidos.test.ts`, que também confere que nenhum deles grava nada no banco. Erro inesperado vira 500 com corpo genérico (`erro_interno`), sem stack trace; o mesmo arquivo tem um teste que força esse caso fechando o banco.

## Concorrência e idempotência

Toda escrita roda numa função síncrona dentro de `BEGIN IMMEDIATE ... COMMIT` (`transaction` em `src/db.ts`). O lock de escrita é pego antes da primeira leitura e não há `await` entre ler e gravar, então a checagem e a gravação enxergam o mesmo estado. Os casos que me preocupavam:

- Aprovar a v2 enquanto chega a v3 na mesma peça. Se o envio entra primeiro, a aprovação vê que a atual é v3 e devolve 409 `versao_desatualizada`. Se a aprovação entra primeiro, v2 fica aprovada e v3 vira a atual em revisão. O id da versão no path funciona como `expected_version`: o revisor aprova exatamente o que viu.
- Aprovar a entrega enquanto chega versão nova numa peça exigida. Ou a checagem vê a versão em revisão e devolve 422, ou a aprovação entra e o envio a desfaz logo depois, com `delivery.approval_revoked`. Nos dois casos a entrega termina em produção.
- Várias aprovações simultâneas da mesma entrega, ou da versão que encerra a última pendência. A primeira aprova e as demais encontram a entrega já aprovada, sem evento novo. Um índice único parcial em `delivery_events (delivery_id, round) WHERE type = 'delivery.approved'` impede uma segunda emissão na mesma rodada, mesmo que algum caminho do código erre.
- Envios simultâneos na mesma peça. Cada transação calcula `max+1`, e `UNIQUE(delivery_id, piece_type, number)` garante que não se repete.
- Criar a entrega do mesmo criador duas vezes devolve a mesma (`ON CONFLICT DO NOTHING`).

Esses casos têm três camadas de teste:

- `test/integration/concurrency.test.ts` dispara requisições com `Promise.all` numa só conexão.
- `test/integration/multi-conexao.test.ts` sobe seis `worker_threads`, cada uma com a própria conexão ao mesmo arquivo sqlite em disco (WAL, `busy_timeout`). Elas saem juntas por uma barreira em `SharedArrayBuffer` com `Atomics.wait`, enviam versões e aprovam em paralelo, e no fim o teste roda `checkInvariants` (`src/invariants.ts`) no banco. Conferi que ele pega erro de verdade: trocando `BEGIN IMMEDIATE` por `BEGIN`, falha com `database is locked`.
- `test/integration/modelo.test.ts` usa fast-check para gerar sequências aleatórias de envio, revisão, aprovação de versão desatualizada e aprovação da entrega. Ele roda cada sequência na API e num modelo de referência escrito a partir do enunciado, comparando status, rodada, pendências e versão atual de cada peça a cada passo. Numa execução com a revogação valendo para qualquer peça, ele falhou e reduziu o contraexemplo a cinco passos: campanha que exige só roteiro, envia e aprova o roteiro, aprova a entrega, chega uma legenda e a API desfaz a aprovação que o modelo mantém. `test/unit/propriedades.test.ts` cobre as propriedades das funções puras.

## Por que essa solução

Um processo Node com sqlite serializa as escritas. Para revisão de peças (pense em centenas ou milhares de entregas ativas, cada uma recebendo poucas versões por dia) isso sobra: a carga descrita abaixo passou de 2.800 req/s nesta máquina, com p95 abaixo de 30 ms. Lock distribuído ou Redis não resolveriam nada que a transação e as restrições `UNIQUE` já não resolvem, então não usei.

Com várias instâncias da API eu trocaria o sqlite por Postgres e manteria o desenho: transação com `SELECT ... FOR UPDATE` na linha da entrega (que serializa envio, revisão e aprovação da mesma entrega), as mesmas restrições únicas e o mesmo índice parcial por rodada. O `delivery.approved` sairia por uma tabela outbox lida por um worker, e o consumidor de pagamento usaria `(delivery_id, round)` como chave de idempotência. Lock distribuído só entraria se aparecesse um efeito externo que não cabe na transação.

## Teste de carga

`npm run load` (`scripts/load.sh`) sobe a API na porta 3106 com banco num diretório temporário e roda `load/review.js` no k6 (Docker, `grafana/k6:0.54.0`). São 24 entregas (campanhas com as quatro peças, só vídeo, e vídeo com capa) e até 50 VUs por 45 s. Cada iteração sorteia uma ação: enviar versão de qualquer peça, revisar a versão atual (aprovar ou pedir alteração), aprovar a entrega, comentar no vídeo ou, em 10% das vezes, mandar um payload inválido (JSON quebrado, tipos errados, ids com unicode, query fora do limite, com e sem Content-Type). Poucas entregas para muitos clientes força disputa na mesma peça. 409 e 422 contam como respostas esperadas, desde que tragam o código certo, e o payload inválido precisa voltar 4xx no formato de erro padrão.

No fim, `scripts/verify-load.ts` roda `checkInvariants` no banco e sai com código 1 se encontrar entrega aprovada com peça exigida sem versão atual aprovada, entrega desfeita sem pendência que não voltou a aprovada, `delivery.approved` repetido na mesma rodada, aprovações menos revogações diferente do status atual, numeração de versão com buraco ou repetição, ou comentário fora da duração. Também falha se a carga não chegou a aprovar, desfazer e reaprovar automaticamente.

Resultado de uma execução real, nesta máquina (2026-10-10, com o log em pino e load average perto de 10):

```
     ✓ envio de versão: 201
     ✓ GET entrega: 200
     ✓ payload inválido: nunca 5xx
     ✓ payload inválido: erro no formato padrão
     ✓ aprovação da entrega: 200 ou 422 pecas_pendentes
     ✓ revisão de versão: 200 ou 409 conhecido
     ✓ comentário: 201

     approvals_revoked..............: 4038
     blocked_delivery_approvals.....: 13418
   ✓ checks.........................: 100.00% 133291 out of 133291
     deliveries_approved............: 24
   ✓ http_req_duration..............: avg=14.47ms min=164.95µs med=14.76ms max=266.32ms p(90)=24.13ms p(95)=28.27ms
   ✓ http_req_failed................: 0.00%   0 out of 130368
     http_reqs......................: 130368  2894.440265/s
     invalid_payloads_sent..........: 9804
     stale_version_approvals........: 1967

resumo do banco após a carga: {
  entregas: 24,
  entregas_aprovadas_agora: 9,
  versoes: 26623,
  versoes_aprovadas: 15360,
  comentarios: 6802,
  eventos_delivery_approved: 4047,
  eventos_approval_revoked: 4038,
  reaprovacoes_automaticas: 4023
}
OK: invariantes I1 a I5 e I8 valem em todas as entregas.
```

No banco, 4047 eventos `delivery.approved` (4023 deles automáticos) menos 4038 revogações dá 9, que é o número de entregas aprovadas no fim. O contador `deliveries_approved` do k6 só conta as aprovações explícitas que ele mesmo viu responder com `already_approved: false`. 1967 tentativas de aprovar versão desatualizada foram recusadas com 409, e 9804 payloads inválidos voltaram 4xx sem nenhum 5xx.

Os thresholds do k6 são `http_req_failed < 1%`, `checks > 99%` e p95 abaixo de 500 ms. O teto de latência é folgado para a carga passar em máquinas mais lentas; quem reprova a rodada de verdade são os checks, a taxa de erro e a verificação de invariantes.
