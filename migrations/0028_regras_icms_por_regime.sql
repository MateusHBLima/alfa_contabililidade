-- Regras de ICMS por CFOP passam a ser por regime (13/10, pedido da Taís).
--
-- Até aqui era uma regra por CFOP para o escritório inteiro. Em 13/10 a Taís
-- trocou regras pensando nas empresas do Simples ("no Simples vai tudo para
-- Outras") e mudou também as do Presumido, que mantêm a alíquota. Agora cada
-- CFOP tem uma regra por grupo de regime:
--   presumido    -> Lucro Presumido, Lucro Real e empresa sem regime informado
--   simples      -> Simples Integral, Simples Híbrido e Simples antigo (sem classificar)
--   simples_fora -> Simples por Fora
--
-- Valores iniciais:
--   presumido    = como estava ANTES de 13/10/2026: para cada CFOP mexido a partir
--                  desse dia, o valor de antes da primeira troca (a trilha de
--                  auditoria guarda). Quem mudou e quando também voltam aos de antes.
--   simples      = tudo em Outras (o que ela pediu).
--   simples_fora = igual ao presumido (ela confere e ajusta na tela).
-- O que ela fez em 13/10 continua na trilha; nada da auditoria é tocado.

CREATE TABLE regras_icms_novo (
  tenant_id      TEXT NOT NULL,
  grupo          TEXT NOT NULL CHECK (grupo IN ('presumido', 'simples', 'simples_fora')),
  cfop           TEXT NOT NULL,
  regra          TEXT NOT NULL CHECK (regra IN ('manter', 'outras')),
  atualizado_em  TEXT NOT NULL,
  atualizado_por TEXT,
  PRIMARY KEY (tenant_id, grupo, cfop)
);

INSERT INTO regras_icms_novo (tenant_id, grupo, cfop, regra, atualizado_em, atualizado_por)
SELECT r.tenant_id, 'presumido', r.cfop,
       COALESCE((SELECT a.valor_antes FROM auditoria a
                  WHERE a.tenant_id = r.tenant_id AND a.entidade = 'regra_icms' AND a.entidade_id = r.cfop
                    AND a.quando >= '2026-10-13'
                  ORDER BY a.id LIMIT 1), r.regra),
       CASE WHEN EXISTS (SELECT 1 FROM auditoria a
                          WHERE a.tenant_id = r.tenant_id AND a.entidade = 'regra_icms' AND a.entidade_id = r.cfop
                            AND a.quando >= '2026-10-13')
            THEN COALESCE((SELECT a.quando FROM auditoria a
                            WHERE a.tenant_id = r.tenant_id AND a.entidade = 'regra_icms' AND a.entidade_id = r.cfop
                              AND a.quando < '2026-10-13'
                            ORDER BY a.id DESC LIMIT 1), '2026-09-28T00:00:00.000Z')
            ELSE r.atualizado_em END,
       CASE WHEN EXISTS (SELECT 1 FROM auditoria a
                          WHERE a.tenant_id = r.tenant_id AND a.entidade = 'regra_icms' AND a.entidade_id = r.cfop
                            AND a.quando >= '2026-10-13')
            THEN (SELECT a.usuario_id FROM auditoria a
                   WHERE a.tenant_id = r.tenant_id AND a.entidade = 'regra_icms' AND a.entidade_id = r.cfop
                     AND a.quando < '2026-10-13'
                   ORDER BY a.id DESC LIMIT 1)
            ELSE r.atualizado_por END
  FROM regras_icms r;

INSERT INTO regras_icms_novo (tenant_id, grupo, cfop, regra, atualizado_em, atualizado_por)
SELECT tenant_id, 'simples', cfop, 'outras', '2026-10-13T00:00:00.000Z', NULL FROM regras_icms;

INSERT INTO regras_icms_novo (tenant_id, grupo, cfop, regra, atualizado_em, atualizado_por)
SELECT tenant_id, 'simples_fora', cfop, regra, atualizado_em, atualizado_por
  FROM regras_icms_novo WHERE grupo = 'presumido';

DROP TABLE regras_icms;
ALTER TABLE regras_icms_novo RENAME TO regras_icms;
