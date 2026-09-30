-- Captura automática de NF-e na SEF/SC (30/09/2026). Ver src/captura/.
--
-- Uma linha por empresa: se a busca está ligada, com qual certificado, até onde já
-- buscou (NSU) e quando pode buscar de novo. A espera é regra da SEF (12 horas depois
-- de receber tudo); desligar e ligar de novo não zera a espera.
CREATE TABLE captura_empresas (
  empresa_id      TEXT PRIMARY KEY REFERENCES empresas(id),
  tenant_id       TEXT NOT NULL,
  ligada          INTEGER NOT NULL DEFAULT 0,
  certificado_id  TEXT,
  ult_nsu         TEXT NOT NULL DEFAULT '0',
  proxima_busca   TEXT,
  ultima_busca    TEXT,
  ultimo_cstat    TEXT,
  ultimo_motivo   TEXT,
  ultimo_erro     TEXT,
  erros_seguidos  INTEGER NOT NULL DEFAULT 0,
  notas_recebidas INTEGER NOT NULL DEFAULT 0,
  ligada_por      TEXT,
  ligada_em       TEXT,
  atualizado_em   TEXT
);
CREATE INDEX idx_captura_vencidas ON captura_empresas (ligada, proxima_busca);

-- Cada consulta feita à SEF, com o resultado. É o histórico da tela.
CREATE TABLE captura_buscas (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  empresa_id  TEXT NOT NULL,
  quando      TEXT NOT NULL,
  cstat       TEXT,
  motivo      TEXT,
  nsu_de      TEXT,
  nsu_ate     TEXT,
  documentos  INTEGER NOT NULL DEFAULT 0,
  importadas  INTEGER NOT NULL DEFAULT 0,
  duplicadas  INTEGER NOT NULL DEFAULT 0,
  eventos     INTEGER NOT NULL DEFAULT 0,
  ignorados   INTEGER NOT NULL DEFAULT 0,
  recusadas   INTEGER NOT NULL DEFAULT 0,
  lote_id     TEXT,
  erro        TEXT
);
CREATE INDEX idx_captura_buscas ON captura_buscas (tenant_id, quando);

INSERT INTO permissoes (chave, grupo, descricao, ordem) VALUES
  ('captura.gerenciar', 'Administração', 'Ligar e desligar a busca automática de notas na SEF', 121);

INSERT INTO papel_permissoes (papel_id, permissao)
  SELECT id, 'captura.gerenciar' FROM papeis WHERE sistema = 1;
