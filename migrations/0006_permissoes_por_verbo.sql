-- Permissões por verbo, e exceções por pessoa.
--
-- Pedido do cliente, com o exemplo dele: "não pode modificar empresas, não pode
-- criar empresas, pode X ação". Hoje `empresas.gerenciar` libera ver, criar e
-- editar de uma vez — não existe como dizer "pode editar, não pode criar".
--
-- A granularidade segue o VERBO, não a tabela: o que muda de responsabilidade
-- num escritório é criar um cliente novo, alterar o perfil fiscal dele, apagar
-- uma regra. São decisões diferentes, com donos diferentes.

-- ---------------------------------------------------------------- catálogo novo
INSERT INTO permissoes (chave, grupo, descricao, ordem) VALUES
  ('empresas.visualizar', 'Empresas', 'Ver a lista de clientes e os dados de cada um', 200),
  ('empresas.criar',      'Empresas', 'Cadastrar um cliente novo',                     210),
  ('empresas.editar',     'Empresas', 'Alterar dados e perfil fiscal de um cliente',   220),
  ('empresas.desativar',  'Empresas', 'Desativar um cliente',                          230),
  ('empresas.todas',      'Empresas', 'Ver TODOS os clientes, sem precisar de vínculo', 240),

  ('regras.fixar',  'Regras', 'Fixar o padrão de um fornecedor para a empresa', 130),
  ('regras.apagar', 'Regras', 'Apagar uma regra aprendida',                     140),

  ('notas.exportar', 'Notas', 'Gerar e baixar o XML corrigido e a escrituração', 90),

  ('usuarios.visualizar', 'Usuários', 'Ver a lista de usuários e o que cada um pode', 300),
  ('usuarios.criar',      'Usuários', 'Criar usuário e definir papel e empresas',      310),
  ('usuarios.editar',     'Usuários', 'Alterar papel, empresas e exceções de alguém',  320),
  ('usuarios.desativar',  'Usuários', 'Desativar um usuário',                          330),
  ('papeis.gerenciar',    'Usuários', 'Criar e editar papéis (conjuntos de permissões)', 340);

-- ---------------------------------------------------------------- conversão
-- Quem tinha a permissão grossa ganha todas as finas equivalentes. Ninguém perde
-- acesso na migração: mudar o modelo de permissão não pode trancar o escritório
-- para fora no meio de um dia de trabalho.
INSERT INTO papel_permissoes (papel_id, permissao)
  SELECT papel_id, 'empresas.visualizar' FROM papel_permissoes WHERE permissao = 'empresas.gerenciar';
INSERT INTO papel_permissoes (papel_id, permissao)
  SELECT papel_id, 'empresas.criar' FROM papel_permissoes WHERE permissao = 'empresas.gerenciar';
INSERT INTO papel_permissoes (papel_id, permissao)
  SELECT papel_id, 'empresas.editar' FROM papel_permissoes WHERE permissao = 'empresas.gerenciar';
INSERT INTO papel_permissoes (papel_id, permissao)
  SELECT papel_id, 'empresas.desativar' FROM papel_permissoes WHERE permissao = 'empresas.gerenciar';

INSERT INTO papel_permissoes (papel_id, permissao)
  SELECT papel_id, 'empresas.todas' FROM papel_permissoes WHERE permissao = 'empresas.gerenciar';

INSERT INTO papel_permissoes (papel_id, permissao)
  SELECT papel_id, 'notas.exportar' FROM papel_permissoes WHERE permissao = 'export.gerar';

INSERT INTO papel_permissoes (papel_id, permissao)
  SELECT papel_id, 'usuarios.visualizar' FROM papel_permissoes WHERE permissao = 'usuarios.gerenciar';
INSERT INTO papel_permissoes (papel_id, permissao)
  SELECT papel_id, 'usuarios.criar' FROM papel_permissoes WHERE permissao = 'usuarios.gerenciar';
INSERT INTO papel_permissoes (papel_id, permissao)
  SELECT papel_id, 'usuarios.editar' FROM papel_permissoes WHERE permissao = 'usuarios.gerenciar';
INSERT INTO papel_permissoes (papel_id, permissao)
  SELECT papel_id, 'usuarios.desativar' FROM papel_permissoes WHERE permissao = 'usuarios.gerenciar';
INSERT INTO papel_permissoes (papel_id, permissao)
  SELECT papel_id, 'papeis.gerenciar' FROM papel_permissoes WHERE permissao = 'usuarios.gerenciar';

-- Quem aprovava regra passa a poder fixar padrão do fornecedor: era parte do
-- mesmo poder, só não tinha nome próprio.
--
-- `regras.apagar` NÃO vem junto de propósito. Promover e rebaixar são
-- reversíveis; apagar uma regra aprendida joga fora conhecimento que custou
-- competências de trabalho manual. Fica com quem administra, e quem precisar
-- pode receber por exceção.
INSERT INTO papel_permissoes (papel_id, permissao)
  SELECT papel_id, 'regras.fixar' FROM papel_permissoes WHERE permissao = 'regras.aprovar';

-- O Supervisor ganha `empresas.editar`: ajustar o perfil fiscal de um cliente é
-- decisão de contador, não de administrador de sistema. Criar e desativar
-- cliente continuam fora.
INSERT OR IGNORE INTO papel_permissoes (papel_id, permissao)
  SELECT id, 'empresas.editar' FROM papeis WHERE nome = 'Supervisor';

-- Ver notas implica ver a empresa a que elas pertencem; sem isso o operador
-- ficaria com o seletor de empresa vazio.
INSERT OR IGNORE INTO papel_permissoes (papel_id, permissao)
  SELECT papel_id, 'empresas.visualizar' FROM papel_permissoes WHERE permissao = 'notas.visualizar';

-- O papel Admin recebe TUDO que existir no catálogo, sempre.
-- Derivar as permissões do Admin de conversões, uma a uma, é como ele terminaria
-- faltando exatamente a que ninguém lembrou — e "acesso irrestrito" com um
-- buraco não é acesso irrestrito. A regra fica escrita como regra.
INSERT OR IGNORE INTO papel_permissoes (papel_id, permissao)
  SELECT p.id, x.chave FROM papeis p, permissoes x WHERE p.sistema = 1;

-- Agora as grossas saem. Primeiro as concessões, depois o catálogo: a chave
-- estrangeira exige essa ordem.
DELETE FROM papel_permissoes
 WHERE permissao IN ('empresas.gerenciar', 'export.gerar', 'usuarios.gerenciar');
DELETE FROM permissoes
 WHERE chave IN ('empresas.gerenciar', 'export.gerar', 'usuarios.gerenciar');

-- ---------------------------------------------------------------- exceções por pessoa
-- O papel resolve 90% dos casos; o resto é gente. `concedida = 0` tira algo que
-- o papel dá, `concedida = 1` acrescenta algo que ele não dá — sem obrigar a
-- criar um papel novo para cada exceção, que é como matriz de permissão vira
-- sopa de letrinhas que ninguém audita.
CREATE TABLE usuario_permissoes (
  usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  permissao  TEXT NOT NULL REFERENCES permissoes(chave),
  concedida  INTEGER NOT NULL,
  definida_em   TEXT NOT NULL,
  definida_por  TEXT,
  PRIMARY KEY (usuario_id, permissao)
);

-- Quem criou quem, e quando. A trilha de auditoria registra o ato; isto responde
-- a pergunta simples "de onde saiu esta conta?" sem varrer a trilha inteira.
ALTER TABLE usuarios ADD COLUMN desativado_em TEXT;
