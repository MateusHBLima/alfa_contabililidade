-- Complemento da natureza (16/11, pedido do Mateus, para o contábil).
--
-- No Questor a natureza é o CFOP mais um complemento de 3 dígitos (1.556.008 = uso e
-- consumo, despesa administrativa, a prazo), e é a natureza que liga a nota à conta
-- contábil. A lista de complementos NÃO é a mesma para todos: é de cada empresa. Por
-- isso a tabela é por empresa, e um complemento por CFOP pode ser o padrão dela.
--
-- No item, o complemento escolhido. Vazio = vale o padrão da empresa para o CFOP.
CREATE TABLE IF NOT EXISTS naturezas_empresa (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  empresa_id  TEXT NOT NULL,
  cfop        TEXT NOT NULL,   -- 4 dígitos: 1556
  complemento TEXT NOT NULL,   -- 3 dígitos: 008
  descricao   TEXT,
  padrao      INTEGER NOT NULL DEFAULT 0,
  criado_por  TEXT,
  criado_em   TEXT NOT NULL,
  UNIQUE (tenant_id, empresa_id, cfop, complemento)
);

CREATE INDEX IF NOT EXISTS idx_naturezas_empresa ON naturezas_empresa (tenant_id, empresa_id);

ALTER TABLE itens ADD COLUMN complemento TEXT;
ALTER TABLE itens ADD COLUMN complemento_origem TEXT;

-- Quem vê e escolhe o complemento é decidido por pessoa (Mateus: "essa função vou
-- precisar controlar nos acessos por conta"). Nasce só no papel Admin; para os outros,
-- é a exceção por usuário.
INSERT INTO permissoes (chave, grupo, descricao, ordem) VALUES
  ('notas.complemento', 'Notas', 'Ver e escolher o complemento da natureza (contábil)', 92);

INSERT INTO papel_permissoes (papel_id, permissao)
  SELECT id, 'notas.complemento' FROM papeis WHERE sistema = 1;
