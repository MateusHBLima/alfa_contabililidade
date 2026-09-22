-- Regra de CFOP passa a considerar o CFOP de SAIDA do fornecedor (retorno da Tais, 22/09).
--
-- O mesmo pudim da OESA vem em 5102 (compra -> 1101) e em nota de ajuste 5949 (-> 1949).
-- A chave antiga era so o produto (fornecedor+codigo, NCM...), e lancar o ajuste
-- reescrevia a regra: o proximo pudim em 5102 chegava 1949 - e pelo nivel 6 (NCM,
-- qualquer fornecedor) ate produto de outro fornecedor. A chave nova e
-- "<chave antiga>#<CFOP de saida>". Ver src/rules/engine.ts, chaveDoNivel.
--
-- 1) As regras de CFOP no formato antigo ficam INATIVAS (nao apagadas: a historia
--    fica, e a tela de padroes continua podendo mostra-las).
-- 2) As regras novas sao refeitas a partir do que a CONTABILIDADE decidiu: itens
--    conferidos ou digitados a mao. Palpite que ninguem olhou nao ensina nada.
--    O trabalho dela - os itens - nao e tocado.
--    Mesma chave com decisoes diferentes: vale a mais recente, que e o que o motor
--    ja fazia ("cada gravacao sobrescreve a anterior"). usos/acertos contam os itens.
-- 3) Regra fixada ("e sempre assim", niveis 1 e 2) continua fixada na chave nova
--    quando a decisao mais recente e o mesmo valor que ela fixou.
--    Medido em producao em 22/09: 483 regras de CFOP, 3 fixadas (nivel 1), nenhuma
--    de nivel 5 (padrao do fornecedor). Por isso o nivel 5 nao e refeito aqui.

UPDATE regras
   SET ativa = 0,
       atualizada_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       observacao = TRIM(COALESCE(observacao, '') || ' [0012] formato antigo: chave sem o CFOP de saída')
 WHERE campo = 'cfop' AND nivel BETWEEN 1 AND 6 AND instr(chave, '#') = 0;

WITH decididos AS (
  SELECT i.tenant_id, n.empresa_id, n.emit_cnpj AS cnpj,
         UPPER(TRIM(COALESCE(i.c_prod, ''))) AS cprod,
         TRIM(COALESCE(i.c_ean, '')) AS ean,
         TRIM(COALESCE(i.ncm, '')) AS ncm,
         TRIM(i.cfop_original) AS saida,
         TRIM(i.cfop_novo) AS valor,
         COALESCE(i.revisado_em, n.criado_em) AS quando,
         i.revisado_por AS quem
    FROM itens i JOIN notas n ON n.id = i.nota_id
   WHERE TRIM(COALESCE(i.cfop_novo, '')) <> ''
     AND TRIM(COALESCE(i.cfop_original, '')) <> ''
     AND (i.revisado = 1 OR i.cfop_origem LIKE 'manual%')
),
chaves AS (
  SELECT tenant_id, empresa_id, 1 AS nivel, cnpj || '|' || cprod || '#' || saida AS chave, cnpj || '|' || cprod AS base, valor, quando, quem
    FROM decididos WHERE cprod <> ''
  UNION ALL
  SELECT tenant_id, empresa_id, 2, cnpj || '|' || ean || '#' || saida, cnpj || '|' || ean, valor, quando, quem
    FROM decididos WHERE ean <> '' AND UPPER(ean) <> 'SEM GTIN'
  UNION ALL
  SELECT tenant_id, empresa_id, 3, ean || '#' || saida, ean, valor, quando, quem
    FROM decididos WHERE ean <> '' AND UPPER(ean) <> 'SEM GTIN'
  UNION ALL
  SELECT tenant_id, empresa_id, 4, cnpj || '|' || ncm || '#' || saida, cnpj || '|' || ncm, valor, quando, quem
    FROM decididos WHERE ncm <> ''
  UNION ALL
  SELECT tenant_id, empresa_id, 6, ncm || '#' || saida, ncm, valor, quando, quem
    FROM decididos WHERE ncm <> ''
),
ordenadas AS (
  SELECT c.*,
         ROW_NUMBER() OVER (PARTITION BY tenant_id, empresa_id, nivel, chave ORDER BY quando DESC) AS ordem,
         COUNT(*) OVER (PARTITION BY tenant_id, empresa_id, nivel, chave) AS total
    FROM chaves c
),
escolhidas AS (
  SELECT o.*,
         (SELECT COUNT(*) FROM chaves x
           WHERE x.tenant_id = o.tenant_id AND x.empresa_id = o.empresa_id
             AND x.nivel = o.nivel AND x.chave = o.chave AND x.valor = o.valor) AS acertos,
         (SELECT r.fixada_em FROM regras r
           WHERE r.tenant_id = o.tenant_id AND r.empresa_id = o.empresa_id AND r.campo = 'cfop'
             AND r.nivel = o.nivel AND r.nivel IN (1, 2) AND r.chave = o.base
             AND r.fixada = 1 AND r.valor = o.valor
           LIMIT 1) AS fixada_em_antiga,
         (SELECT COUNT(*) FROM regras r
           WHERE r.tenant_id = o.tenant_id AND r.empresa_id = o.empresa_id AND r.campo = 'cfop'
             AND r.nivel = o.nivel AND r.nivel IN (1, 2) AND r.chave = o.base
             AND r.fixada = 1 AND r.valor = o.valor) AS era_fixada
    FROM ordenadas o
   WHERE o.ordem = 1
)
INSERT INTO regras (id, tenant_id, empresa_id, nivel, chave, campo, valor, usos, acertos, erros,
                    erros_seguidos, confianca, ativa, suspeita, criada_em, criada_por, atualizada_em,
                    fixada, fixada_em, observacao)
SELECT lower(hex(randomblob(16))), tenant_id, empresa_id, nivel, chave, 'cfop', valor,
       total, acertos, total - acertos, 0,
       (acertos + 1.0) / (total + 2.0), 1, 0,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), quem, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       CASE WHEN era_fixada > 0 THEN 1 ELSE 0 END,
       CASE WHEN era_fixada > 0 THEN fixada_em_antiga ELSE NULL END,
       '[0012] refeita a partir dos itens decididos pela contabilidade'
  FROM escolhidas
 WHERE 1
ON CONFLICT (tenant_id, empresa_id, nivel, chave, campo) DO NOTHING;
