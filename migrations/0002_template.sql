-- 0002 — Template de escrituração, cadastro de empresa e fornecedores
--
-- Decisões de 24/08 que motivaram esta migração:
--   * o cadastro de empresa pré-popula a primeira execução (CNAE -> perfil -> CFOP padrão)
--   * o template guarda mais que CFOP e descrição: CST de entrada, conta contábil, créditos
--   * "REGISTRA, NÃO REESCREVE" — os campos novos NÃO vão para o XML corrigido (ver src/rules/campos.ts)
--   * regra por FORNECEDOR passa a existir como nível próprio (nível 5)

-- ---------------------------------------------------------------- empresas

ALTER TABLE empresas ADD COLUMN cnae_principal TEXT;
ALTER TABLE empresas ADD COLUMN cnaes_secundarios TEXT;      -- JSON array
ALTER TABLE empresas ADD COLUMN cfop_padrao_dentro_uf TEXT;
ALTER TABLE empresas ADD COLUMN cfop_padrao_fora_uf TEXT;
ALTER TABLE empresas ADD COLUMN cst_entrada_padrao TEXT;
ALTER TABLE empresas ADD COLUMN credito_icms_padrao TEXT;    -- S | N | null
ALTER TABLE empresas ADD COLUMN credito_pis_padrao TEXT;
ALTER TABLE empresas ADD COLUMN credito_cofins_padrao TEXT;
ALTER TABLE empresas ADD COLUMN observacoes TEXT;
ALTER TABLE empresas ADD COLUMN atualizado_em TEXT;

-- ---------------------------------------------------------------- fornecedores
--
-- "temos que ver isso do fornecedor também".
-- Um fornecedor recorrente ganha ficha própria por empresa: apelido, se é distribuidor
-- de ST, e o padrão que a contabilidade fixou para ele. As regras de nível 5 apontam
-- para cá conceitualmente, mas vivem na tabela `regras` como qualquer outra — esta
-- tabela é cadastro e memória, não motor.

CREATE TABLE fornecedores (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  empresa_id     TEXT NOT NULL REFERENCES empresas(id),
  cnpj           TEXT NOT NULL,
  nome           TEXT,
  apelido        TEXT,
  uf             TEXT,
  -- notas recebidas deste fornecedor: alimenta a tela e prioriza quem vale fixar padrão
  notas_recebidas INTEGER NOT NULL DEFAULT 0,
  ultima_nota_em TEXT,
  -- a contabilidade marcou este fornecedor como resolvido (padrão fixado)
  padrao_fixado  INTEGER NOT NULL DEFAULT 0,
  observacoes    TEXT,
  criado_em      TEXT NOT NULL,
  UNIQUE (tenant_id, empresa_id, cnpj)
);
CREATE INDEX idx_fornecedores_empresa ON fornecedores (tenant_id, empresa_id);

-- ---------------------------------------------------------------- itens: campos do template
--
-- Um par (valor, origem) por campo. `origem` é o que a auditoria usa para distinguir
-- "o humano digitou" de "a regra preencheu e o humano confirmou".

-- CST/CSOSN que o FORNECEDOR usou na saída. Guardado para comparação histórica:
-- é o que permite detectar "este produto entrou em substituição tributária".
ALTER TABLE itens ADD COLUMN cst_origem            TEXT;

ALTER TABLE itens ADD COLUMN cst_entrada           TEXT;
ALTER TABLE itens ADD COLUMN cst_entrada_origem    TEXT;
ALTER TABLE itens ADD COLUMN conta_contabil        TEXT;
ALTER TABLE itens ADD COLUMN conta_contabil_origem TEXT;
ALTER TABLE itens ADD COLUMN credito_icms          TEXT;
ALTER TABLE itens ADD COLUMN credito_icms_origem   TEXT;
ALTER TABLE itens ADD COLUMN credito_pis           TEXT;
ALTER TABLE itens ADD COLUMN credito_pis_origem    TEXT;
ALTER TABLE itens ADD COLUMN credito_cofins        TEXT;
ALTER TABLE itens ADD COLUMN credito_cofins_origem TEXT;

-- ---------------------------------------------------------------- regras
--
-- `fixada` = a contabilidade disse "para esta empresa e este fornecedor é assim, ponto".
-- Nasce verde e não é rebaixada por divergência: ali não houve palpite, houve decisão.

ALTER TABLE regras ADD COLUMN fixada       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE regras ADD COLUMN fixada_por   TEXT;
ALTER TABLE regras ADD COLUMN fixada_em    TEXT;
ALTER TABLE regras ADD COLUMN observacao   TEXT;

-- ---------------------------------------------------------------- lotes de importação
--
-- Hoje a entrada é upload manual. Amanhã pode ser um arquivo vindo de outro lugar
-- (o cliente ainda vai confirmar de onde). Esta tabela existe para que a origem
-- da nota seja rastreável desde já, sem precisar de migração quando isso mudar.

CREATE TABLE lotes_importacao (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  empresa_id   TEXT NOT NULL REFERENCES empresas(id),
  -- upload | email | sefaz | integracao
  origem       TEXT NOT NULL DEFAULT 'upload',
  nome_arquivo TEXT,
  bytes        INTEGER,
  total_arquivos INTEGER NOT NULL DEFAULT 0,
  importadas   INTEGER NOT NULL DEFAULT 0,
  duplicadas   INTEGER NOT NULL DEFAULT 0,
  recusadas    INTEGER NOT NULL DEFAULT 0,
  detalhe      TEXT,                       -- JSON com o resultado por arquivo
  criado_em    TEXT NOT NULL,
  criado_por   TEXT
);
CREATE INDEX idx_lotes_empresa ON lotes_importacao (tenant_id, empresa_id, criado_em);

ALTER TABLE notas ADD COLUMN lote_id TEXT;
ALTER TABLE notas ADD COLUMN origem  TEXT NOT NULL DEFAULT 'upload';

-- Busca do histórico de um produto: (empresa, fornecedor, código do produto).
-- É o que alimenta os alertas de divergência — ver src/rules/alertas.ts.
CREATE INDEX idx_itens_historico ON itens (tenant_id, c_prod);
