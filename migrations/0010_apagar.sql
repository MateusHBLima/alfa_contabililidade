-- Apagar nota e apagar empresa.
--
-- Faltava. E a falta apareceu do jeito mais bobo possivel: os dados de teste da
-- primeira nota real ficaram presos em producao, sem tela nenhuma para tira-los.
-- Todo sistema que deixa alguem importar precisa deixar alguem desfazer.
--
-- Sao permissoes proprias, e so o Admin recebe. Apagar nota nao e "editar nota
-- com forca": e destruicao, e quem trata nota o dia inteiro nao precisa disso.
-- Desativar empresa (que ja existia) continua sendo o caminho normal; apagar e
-- para engano de cadastro e dado de teste.

INSERT INTO permissoes (chave, grupo, descricao, ordem) VALUES
  ('notas.apagar',    'Notas',    'Apagar uma nota importada e tudo que veio com ela', 95),
  ('empresas.apagar', 'Empresas', 'Apagar um cliente e todas as notas dele',           235);

-- Só quem já é administrador. Papel de sistema = o Admin semeado.
INSERT INTO papel_permissoes (papel_id, permissao)
  SELECT id, 'notas.apagar' FROM papeis WHERE sistema = 1;
INSERT INTO papel_permissoes (papel_id, permissao)
  SELECT id, 'empresas.apagar' FROM papeis WHERE sistema = 1;
