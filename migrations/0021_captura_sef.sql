-- Busca de notas na SEF/SC, manual e por período (30/09/2026). Ver src/captura/.
--
-- A SEF não filtra por data: entrega tudo o que tem da empresa (mês atual e os dois
-- anteriores), em ordem de NSU, e depois de entregar tudo exige 12 horas até a
-- próxima consulta. Por isso o que vem da SEF fica numa CAIXA, fora da lista de
-- notas, e só entra no sistema o que a contadora escolher (período + confirmação).

-- Uma linha por empresa: até onde já baixou (NSU) e quando a SEF libera de novo.
CREATE TABLE captura_empresas (
  empresa_id       TEXT PRIMARY KEY REFERENCES empresas(id),
  tenant_id        TEXT NOT NULL,
  certificado_id   TEXT,
  ult_nsu          TEXT NOT NULL DEFAULT '0',
  proxima_consulta TEXT,
  ultima_consulta  TEXT,
  ultimo_cstat     TEXT,
  ultimo_motivo    TEXT,
  ultimo_erro      TEXT,
  atualizado_em    TEXT
);

-- O que a SEF mandou. O XML fica no R2 de trabalho; aqui só o índice para filtrar
-- por data e mostrar a lista antes de importar.
CREATE TABLE captura_caixa (
  tenant_id   TEXT NOT NULL,
  empresa_id  TEXT NOT NULL,
  nsu         TEXT NOT NULL,
  chave       TEXT,
  tipo        TEXT NOT NULL,          -- nota | evento | outro
  tp_evento   TEXT,
  dh_emi      TEXT,                   -- da nota, ou do evento
  emit_cnpj   TEXT,
  emit_nome   TEXT,
  numero      TEXT,
  valor       REAL,
  r2_chave    TEXT NOT NULL,
  recebido_em TEXT NOT NULL,
  aplicado_em TEXT,                   -- evento já aplicado na nota do sistema
  PRIMARY KEY (empresa_id, nsu)
);
CREATE INDEX idx_caixa_data ON captura_caixa (empresa_id, tipo, dh_emi);
CREATE INDEX idx_caixa_chave ON captura_caixa (empresa_id, chave);

-- Cada consulta feita à SEF, com o resultado e quem pediu.
CREATE TABLE captura_buscas (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  empresa_id  TEXT NOT NULL,
  usuario_id  TEXT,
  quando      TEXT NOT NULL,
  cstat       TEXT,
  motivo      TEXT,
  nsu_de      TEXT,
  nsu_ate     TEXT,
  documentos  INTEGER NOT NULL DEFAULT 0,
  erro        TEXT
);
CREATE INDEX idx_captura_buscas ON captura_buscas (tenant_id, quando);

-- Testar a conexão e ver o histórico: só o administrador. Buscar as notas de uma
-- empresa usa a permissão de importar, que a contadora já tem.
INSERT INTO permissoes (chave, grupo, descricao, ordem) VALUES
  ('captura.gerenciar', 'Administração', 'Testar a conexão com a SEF e ver o histórico das buscas', 121);

INSERT INTO papel_permissoes (papel_id, permissao)
  SELECT id, 'captura.gerenciar' FROM papeis WHERE sistema = 1;
