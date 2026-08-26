-- Planee Fiscal - esquema inicial
-- Convencoes:
--   * toda tabela de dominio carrega tenant_id (multi-tenancy nao usada agora, mas nao bloqueada)
--   * datas em ISO-8601 UTC (TEXT)
--   * nenhuma escrita de dominio acontece fora do repositorio (src/db/repo.ts),
--     porque e o repositorio que grava a trilha de auditoria

-- ---------------------------------------------------------------- tenants

CREATE TABLE tenants (
  id         TEXT PRIMARY KEY,
  nome       TEXT NOT NULL,
  criado_em  TEXT NOT NULL
);

-- ---------------------------------------------------------------- acesso

CREATE TABLE usuarios (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  email             TEXT NOT NULL,
  nome              TEXT NOT NULL,
  -- formato: pbkdf2$<iteracoes>$<salt_b64>$<hash_b64>
  senha_hash        TEXT NOT NULL,
  deve_trocar_senha INTEGER NOT NULL DEFAULT 0,
  ativo             INTEGER NOT NULL DEFAULT 1,
  tentativas_falhas INTEGER NOT NULL DEFAULT 0,
  bloqueado_ate     TEXT,
  ultimo_login      TEXT,
  criado_em         TEXT NOT NULL,
  criado_por        TEXT,
  UNIQUE (tenant_id, email)
);

CREATE TABLE papeis (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  nome      TEXT NOT NULL,
  descricao TEXT,
  -- papel de sistema nao pode ser apagado pelo admin (evita o escritorio se trancar para fora)
  sistema   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, nome)
);

-- Catalogo fixo, versionado por migracao. O admin NAO cria permissao nova pela tela:
-- permissao nova exige codigo que a respeite, entao nasce aqui.
CREATE TABLE permissoes (
  chave     TEXT PRIMARY KEY,
  grupo     TEXT NOT NULL,
  descricao TEXT NOT NULL,
  ordem     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE papel_permissoes (
  papel_id  TEXT NOT NULL REFERENCES papeis(id) ON DELETE CASCADE,
  permissao TEXT NOT NULL REFERENCES permissoes(chave),
  PRIMARY KEY (papel_id, permissao)
);

CREATE TABLE usuario_papeis (
  usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  papel_id   TEXT NOT NULL REFERENCES papeis(id) ON DELETE CASCADE,
  PRIMARY KEY (usuario_id, papel_id)
);

-- Recorte de linha: quais clientes esse usuario enxerga.
-- Usuario sem nenhuma linha aqui e tratado como "todas as empresas do tenant"
-- SOMENTE se tiver a permissao empresas.gerenciar; caso contrario, nenhuma.
CREATE TABLE usuario_empresas (
  usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  empresa_id TEXT NOT NULL,
  PRIMARY KEY (usuario_id, empresa_id)
);

CREATE TABLE sessoes (
  id          TEXT PRIMARY KEY,
  usuario_id  TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  criada_em   TEXT NOT NULL,
  expira_em   TEXT NOT NULL,
  ultimo_uso  TEXT,
  ip          TEXT,
  user_agent  TEXT,
  revogada    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sessoes_usuario ON sessoes (usuario_id);

CREATE TABLE reset_senha (
  token_hash TEXT PRIMARY KEY,
  usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  criado_em  TEXT NOT NULL,
  expira_em  TEXT NOT NULL,
  usado_em   TEXT
);

-- ---------------------------------------------------------------- dominio

CREATE TABLE empresas (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  cnpj         TEXT NOT NULL,
  razao_social TEXT NOT NULL,
  nome_fantasia TEXT,
  uf           TEXT,
  -- dirige o CFOP de entrada sugerido no nivel 6 do motor de regras
  perfil       TEXT NOT NULL DEFAULT 'revenda',
  regime       TEXT,
  ativo        INTEGER NOT NULL DEFAULT 1,
  criado_em    TEXT NOT NULL,
  UNIQUE (tenant_id, cnpj)
);

CREATE TABLE notas (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  empresa_id    TEXT NOT NULL REFERENCES empresas(id),
  chave         TEXT NOT NULL,
  numero        TEXT,
  serie         TEXT,
  modelo        TEXT,
  emit_cnpj     TEXT NOT NULL,
  emit_nome     TEXT,
  emit_uf       TEXT,
  dest_cnpj     TEXT,
  dh_emi        TEXT,
  competencia   TEXT,              -- AAAA-MM
  valor_total   REAL,
  protocolo     TEXT,
  status        TEXT NOT NULL DEFAULT 'importada',
  r2_original   TEXT,
  r2_corrigido  TEXT,
  -- SHA-256 do XML original: prova de que o arquivo guardado e o que chegou
  hash_original TEXT,
  criado_em     TEXT NOT NULL,
  criado_por    TEXT,
  UNIQUE (tenant_id, chave)
);
CREATE INDEX idx_notas_empresa_comp ON notas (tenant_id, empresa_id, competencia);
CREATE INDEX idx_notas_emit        ON notas (tenant_id, emit_cnpj);

CREATE TABLE itens (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  nota_id          TEXT NOT NULL REFERENCES notas(id) ON DELETE CASCADE,
  n_item           INTEGER NOT NULL,

  -- o que veio do fornecedor: nunca sofre UPDATE
  c_prod           TEXT,
  c_ean            TEXT,
  x_prod_original  TEXT NOT NULL,
  ncm              TEXT,
  cest             TEXT,
  cfop_original    TEXT NOT NULL,
  unidade          TEXT,
  quantidade       REAL,
  valor_unitario   REAL,
  valor_total      REAL,

  -- o que a escrituracao vai usar
  cfop_novo        TEXT,
  x_prod_novo      TEXT,

  -- proveniencia: manual | regra:<id> | lote | perfil | importacao
  cfop_origem      TEXT,
  x_prod_origem    TEXT,
  regra_cfop_id    TEXT,
  regra_desc_id    TEXT,
  -- alta (verde) | media (amarelo) | nenhuma (vermelho)
  confianca        TEXT NOT NULL DEFAULT 'nenhuma',
  -- 1 = um humano olhou para este item e disse que esta certo
  revisado         INTEGER NOT NULL DEFAULT 0,
  revisado_por     TEXT,
  revisado_em      TEXT,

  UNIQUE (nota_id, n_item)
);
CREATE INDEX idx_itens_nota ON itens (nota_id);

-- ---------------------------------------------------------------- motor de regras

CREATE TABLE regras (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  empresa_id     TEXT NOT NULL REFERENCES empresas(id),
  -- 1 fornecedor+cProd | 2 fornecedor+EAN | 3 EAN | 4 fornecedor+NCM | 5 NCM | 6 perfil
  nivel          INTEGER NOT NULL,
  chave          TEXT NOT NULL,
  campo          TEXT NOT NULL,          -- cfop | descricao
  valor          TEXT NOT NULL,
  usos           INTEGER NOT NULL DEFAULT 0,
  acertos        INTEGER NOT NULL DEFAULT 0,
  erros          INTEGER NOT NULL DEFAULT 0,
  erros_seguidos INTEGER NOT NULL DEFAULT 0,
  confianca      REAL    NOT NULL DEFAULT 0.5,
  ativa          INTEGER NOT NULL DEFAULT 1,
  -- 1 = errou demais, precisa de olho humano antes de voltar a sugerir
  suspeita       INTEGER NOT NULL DEFAULT 0,
  criada_em      TEXT NOT NULL,
  criada_por     TEXT,
  atualizada_em  TEXT,
  UNIQUE (tenant_id, empresa_id, nivel, chave, campo)
);
CREATE INDEX idx_regras_busca ON regras (tenant_id, empresa_id, campo, nivel, chave);

CREATE TABLE abreviacoes (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  de        TEXT NOT NULL,
  para      TEXT NOT NULL,
  usos      INTEGER NOT NULL DEFAULT 0,
  ativa     INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, de)
);

-- ---------------------------------------------------------------- auditoria

-- Append-only. Nunca sofre UPDATE nem DELETE.
-- hash = SHA-256(hash_anterior + payload canonico) -> adulteracao quebra a cadeia.
CREATE TABLE auditoria (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id      TEXT NOT NULL,
  quando         TEXT NOT NULL,
  usuario_id     TEXT,
  usuario_email  TEXT,          -- desnormalizado de proposito: sobrevive a exclusao do usuario
  acao           TEXT NOT NULL, -- criar | alterar | excluir | exportar | login | login_falha
  entidade       TEXT NOT NULL,
  entidade_id    TEXT,
  campo          TEXT,
  valor_antes    TEXT,
  valor_depois   TEXT,
  -- o campo mais importante da tabela: distingue "o humano digitou"
  -- de "a regra preencheu e o humano confirmou" de "a regra preencheu e ninguem olhou"
  origem         TEXT,
  ip             TEXT,
  request_id     TEXT,
  hash_anterior  TEXT,
  hash           TEXT NOT NULL
);
CREATE INDEX idx_auditoria_entidade ON auditoria (tenant_id, entidade, entidade_id);
CREATE INDEX idx_auditoria_usuario  ON auditoria (tenant_id, usuario_id, quando);
CREATE INDEX idx_auditoria_quando   ON auditoria (tenant_id, quando);
