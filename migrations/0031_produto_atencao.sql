-- Produtos que a contadora pediu para sempre olhar (16/10, pedido da Taís pelo assistente).
--
-- "eu consigo ir colocando os produtos que eu quero que fique como precisa atenção":
-- o produto daquele fornecedor (código do fornecedor) sempre aparece para conferir,
-- mesmo quando o sistema já sabe o CFOP. Não muda CFOP nenhum: só acende um aviso
-- na linha e tira o item do "veio certo".
--
-- O contrário ("automático, não precisa olhar") não precisa de tabela: é a regra
-- fixa do produto, a mesma do botão "fixar".
--
-- Tirar a marca não apaga a linha: grava removido_em, para a trilha e para saber
-- quando ela desistiu.
CREATE TABLE IF NOT EXISTS produto_atencao (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  empresa_id  TEXT NOT NULL,
  emit_cnpj   TEXT NOT NULL,
  c_prod      TEXT NOT NULL,
  descricao   TEXT,
  observacao  TEXT,
  criado_por  TEXT,
  criado_em   TEXT NOT NULL,
  removido_em TEXT,
  UNIQUE (tenant_id, empresa_id, emit_cnpj, c_prod)
);

CREATE INDEX IF NOT EXISTS idx_produto_atencao_forn ON produto_atencao (tenant_id, empresa_id, emit_cnpj);
