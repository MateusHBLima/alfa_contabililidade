-- Papel "Somente leitura" (15/10, pedido do Mateus).
--
-- Para o acesso do Claude conferir produção sem depender do login de admin: vê todas
-- as empresas, as notas, os relatórios, as regras e a trilha, e não altera nada. A
-- regra "em produção, só olhar" passa a valer pelo sistema, não só pela disciplina.
-- Também serve para quem só precisa consultar (auditoria, sócios).
--
-- Abrir uma nota com este papel não atualiza os palpites dos itens (ver
-- atualizarPalpitesDaNota): só quem pode editar CFOP dispara essa atualização.

INSERT OR IGNORE INTO papeis (id, tenant_id, nome, descricao, sistema)
SELECT 'papel-leitura', id, 'Somente leitura',
       'Vê todas as empresas, notas, relatórios, regras e a trilha. Não altera nada.', 0
  FROM tenants WHERE id = 'alfa';

INSERT OR IGNORE INTO papel_permissoes (papel_id, permissao)
SELECT 'papel-leitura', p.chave
  FROM permissoes p
 WHERE p.chave IN ('notas.visualizar', 'empresas.visualizar', 'empresas.todas', 'regras.visualizar', 'auditoria.visualizar')
   AND EXISTS (SELECT 1 FROM papeis WHERE id = 'papel-leitura');
