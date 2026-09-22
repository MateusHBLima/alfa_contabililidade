-- Padrao fixado ("e sempre assim") que a 0012 deixou sem chave nova (conferencia de 22/09).
--
-- A 0012 refez as regras de CFOP a partir dos itens decididos, e manteve a marca de
-- fixada quando a decisao mais recente era o mesmo valor. Na The Sailor, tres produtos
-- da OESA estavam fixados (touca 163010 -> 1556, luva 163000 -> 1556, canela
-- 93631 -> 1101), mas so tinham aparecido numa nota de ajuste 5949, lancada 1949.
-- Resultado: ficou so o "#5949 = 1949" e o padrao fixado dela nao valia mais para a
-- compra normal. O "e sempre assim" e a natureza do produto na compra: volta como
-- fixado em "#5102".
--
-- So cria o que falta (ON CONFLICT DO NOTHING): se ja existe regra "#5102" para o
-- produto, ela veio de uma decisao dela numa compra 5102 e vale mais. Itens nao sao
-- tocados; a regra antiga continua inativa, com uma nota do que foi feito.

INSERT INTO regras (id, tenant_id, empresa_id, nivel, chave, campo, valor, usos, acertos, erros,
                    erros_seguidos, confianca, ativa, suspeita, criada_em, criada_por, atualizada_em,
                    fixada, fixada_por, fixada_em, observacao)
SELECT lower(hex(randomblob(16))), r.tenant_id, r.empresa_id, r.nivel, r.chave || '#5102', 'cfop', r.valor,
       r.usos, r.acertos, r.erros, 0, r.confianca, 1, 0,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), r.criada_por, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       1, r.fixada_por, r.fixada_em,
       '[0014] padrão fixado pela contabilidade, recriado para a compra (5102)'
  FROM regras r
 WHERE r.campo = 'cfop' AND r.nivel IN (1, 2) AND r.fixada = 1 AND r.ativa = 0
   AND instr(r.chave, '#') = 0
ON CONFLICT (tenant_id, empresa_id, nivel, chave, campo) DO NOTHING;

UPDATE regras
   SET observacao = TRIM(COALESCE(observacao, '') || ' [0014] recriada em #5102'),
       atualizada_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE campo = 'cfop' AND nivel IN (1, 2) AND fixada = 1 AND ativa = 0 AND instr(chave, '#') = 0
   AND EXISTS (SELECT 1 FROM regras n
                WHERE n.tenant_id = regras.tenant_id AND n.empresa_id = regras.empresa_id
                  AND n.nivel = regras.nivel AND n.campo = 'cfop'
                  AND n.chave = regras.chave || '#5102'
                  AND n.observacao LIKE '[0014]%');
