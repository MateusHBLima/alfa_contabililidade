-- Antecipação de ICMS e DIFAL, primeira parte (09/10/2026): a lista das notas
-- candidatas do mês e a marca da contadora em cada uma — fica ou não fica. O
-- cálculo da guia vem depois, validado com notas reais calculadas no ITC.
--
-- Uma linha por nota marcada; nota sem linha está "a conferir". Sem chave
-- estrangeira de propósito: apagar a nota ou a empresa apaga a marca no código
-- (ver DELETE /api/notas/:id e DELETE /api/empresas/:id).
CREATE TABLE apuracao_marcas (
  tenant_id    TEXT NOT NULL,
  empresa_id   TEXT NOT NULL,
  tipo         TEXT NOT NULL,          -- antecipacao | difal
  nota_id      TEXT NOT NULL,
  competencia  TEXT NOT NULL,
  situacao     TEXT NOT NULL,          -- fica | sai
  marcado_por  TEXT,
  marcado_em   TEXT NOT NULL,
  PRIMARY KEY (empresa_id, tipo, nota_id)
);
CREATE INDEX idx_apuracao_competencia ON apuracao_marcas (empresa_id, tipo, competencia);
