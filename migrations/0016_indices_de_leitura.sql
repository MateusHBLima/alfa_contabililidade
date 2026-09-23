-- Indices para o banco parar de ler tabelas inteiras (23/09: a conta estourou o limite
-- gratuito do D1 de 5 milhoes de LINHAS LIDAS por dia e o sistema ficou fora do ar).
--
-- O D1 cobra por linha percorrida, nao por linha devolvida. Medido com EXPLAIN QUERY
-- PLAN no esquema real:
--   * ultimo elo da trilha: a cada gravacao de auditoria (toda alteracao, conferencia,
--     login, importacao) o banco ordenava a trilha INTEIRA para achar a ultima linha.
--     Com (tenant_id, id) le 1 linha.
--   * historico do produto ao abrir nota: percorria os itens de TODAS as empresas.
--     Com (tenant_id, empresa_id, emit_cnpj) em notas, le so as notas do fornecedor.
--   * importacoes: contava notas por lote varrendo a tabela de notas uma vez por lote.
--   * faxina das tentativas de login: varria a tabela a cada login.
-- So cria indice: nenhum dado muda.
CREATE INDEX IF NOT EXISTS idx_auditoria_tenant_id ON auditoria (tenant_id, id);
CREATE INDEX IF NOT EXISTS idx_notas_empresa_emit ON notas (tenant_id, empresa_id, emit_cnpj);
CREATE INDEX IF NOT EXISTS idx_notas_lote ON notas (lote_id);
CREATE INDEX IF NOT EXISTS idx_tentativas_quando ON tentativas_login (quando);
