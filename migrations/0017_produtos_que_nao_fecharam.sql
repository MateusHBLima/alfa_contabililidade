-- Marca "não fechou" no relatório por produto (28/09, pedido da Taís).
-- Ela confere o relatório com a auxiliar que usa o Questor e vai marcando o que
-- não bate, para voltar só nesses depois. Fica no banco (não no navegador):
-- é a lista de pendências do mês e não pode sumir ao trocar de computador.
-- A chave é a mesma linha do relatório: descrição + unidade, sem diferença de
-- maiúscula e espaço.
CREATE TABLE IF NOT EXISTS produtos_nao_fecharam (
  tenant_id   TEXT NOT NULL,
  empresa_id  TEXT NOT NULL,
  competencia TEXT NOT NULL,
  chave       TEXT NOT NULL,
  descricao   TEXT NOT NULL,
  unidade     TEXT NOT NULL,
  marcado_por TEXT,
  marcado_em  TEXT NOT NULL,
  PRIMARY KEY (tenant_id, empresa_id, competencia, chave)
);
