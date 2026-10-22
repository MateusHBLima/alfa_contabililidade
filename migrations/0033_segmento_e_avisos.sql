-- Pacote 2 da reunião de 15/10 (22/10).
--
-- 1) Segmento da empresa (restaurante, imobiliária, indústria...) e as regras que a
--    contadora escreve por segmento: "imobiliária não tem compra de mercadoria, então
--    não pode ter nada no 1102". Quando a linha da nota cai num CFOP que ela disse que
--    não combina com o segmento da empresa, a linha avisa, e o relatório por CFOP também.
--    O segmento é texto livre (ela cria os que quiser); a comparação ignora maiúsculas.
--    Tirar uma regra não apaga: grava removido_em.
ALTER TABLE empresas ADD COLUMN segmento TEXT;

CREATE TABLE IF NOT EXISTS segmento_regras (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  segmento     TEXT NOT NULL,
  cfop         TEXT NOT NULL,
  observacao   TEXT,
  criado_por   TEXT,
  criado_em    TEXT NOT NULL,
  removido_em  TEXT,
  removido_por TEXT
);

CREATE INDEX IF NOT EXISTS idx_segmento_regras ON segmento_regras (tenant_id, segmento);

-- 2) Aviso na linha da nota: "isso aqui tinha que ser 1910", escrito por ela na própria
--    linha, para o Mateus (substitui o áudio). Guarda a foto do momento (produto, CFOP que
--    veio e o que estava na linha) porque a linha pode mudar depois. Nada é apagado.
CREATE TABLE IF NOT EXISTS aviso_item (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  empresa_id    TEXT NOT NULL,
  nota_id       TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  texto         TEXT NOT NULL,
  produto       TEXT,
  cfop_original TEXT,
  cfop_linha    TEXT,
  usuario_id    TEXT,
  usuario_nome  TEXT,
  criado_em     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_aviso_item_data ON aviso_item (tenant_id, criado_em);
CREATE INDEX IF NOT EXISTS idx_aviso_item_item ON aviso_item (item_id);
