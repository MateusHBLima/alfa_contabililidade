-- 0003 — Semente: tenant, catálogo de permissões e papéis.
--
-- Determinístico e sem dados de pessoa: pode rodar em qualquer ambiente.
-- O primeiro usuário NÃO nasce aqui — senha em migração viraria senha em repositório.
-- Use `npm run semear:usuario` para gerar o INSERT do primeiro admin.

INSERT INTO tenants (id, nome, criado_em) VALUES
  ('alfa', 'ALFA CONTABILIDADE', '2026-08-26T00:00:00.000Z');

INSERT INTO permissoes (chave, grupo, descricao, ordem) VALUES
  ('notas.visualizar',       'Notas',          'Ver a lista de notas e abrir uma nota',        10),
  ('notas.importar',         'Notas',          'Subir arquivos XML',                          20),
  ('notas.editar_cfop',      'Notas',          'Alterar CFOP (item, lote ou nota inteira)',   30),
  ('notas.editar_descricao', 'Notas',          'Alterar a descrição do produto',              40),
  ('notas.editar_escrituracao','Notas',        'Alterar CST de entrada, conta contábil e créditos', 50),
  ('regras.visualizar',      'Regras',         'Ver os padrões aprendidos',                   60),
  ('regras.aprovar',         'Regras',         'Fixar, rebaixar ou apagar padrão',            70),
  ('export.gerar',           'Exportação',     'Gerar e baixar o XML corrigido',              80),
  ('empresas.gerenciar',     'Administração',  'Cadastrar clientes e perfis fiscais',         90),
  ('usuarios.gerenciar',     'Administração',  'Criar usuários e atribuir papéis',           100),
  ('auditoria.visualizar',   'Administração',  'Consultar a trilha de alterações',           110);

INSERT INTO papeis (id, tenant_id, nome, descricao, sistema) VALUES
  ('papel-operador',   'alfa', 'Operador',   'Trata notas: importa, corrige CFOP e descrição.', 0),
  ('papel-supervisor', 'alfa', 'Supervisor', 'Tudo do operador, mais aprovar padrões, exportar e ver a trilha.', 0),
  -- Admin é papel de sistema: não pode ser apagado, senão o escritório se tranca para fora.
  ('papel-admin',      'alfa', 'Admin',      'Acesso total, incluindo usuários e empresas.', 1);

INSERT INTO papel_permissoes (papel_id, permissao) VALUES
  ('papel-operador', 'notas.visualizar'),
  ('papel-operador', 'notas.importar'),
  ('papel-operador', 'notas.editar_cfop'),
  ('papel-operador', 'notas.editar_descricao'),
  ('papel-operador', 'regras.visualizar'),

  ('papel-supervisor', 'notas.visualizar'),
  ('papel-supervisor', 'notas.importar'),
  ('papel-supervisor', 'notas.editar_cfop'),
  ('papel-supervisor', 'notas.editar_descricao'),
  ('papel-supervisor', 'notas.editar_escrituracao'),
  ('papel-supervisor', 'regras.visualizar'),
  ('papel-supervisor', 'regras.aprovar'),
  ('papel-supervisor', 'export.gerar'),
  ('papel-supervisor', 'auditoria.visualizar'),

  ('papel-admin', 'notas.visualizar'),
  ('papel-admin', 'notas.importar'),
  ('papel-admin', 'notas.editar_cfop'),
  ('papel-admin', 'notas.editar_descricao'),
  ('papel-admin', 'notas.editar_escrituracao'),
  ('papel-admin', 'regras.visualizar'),
  ('papel-admin', 'regras.aprovar'),
  ('papel-admin', 'export.gerar'),
  ('papel-admin', 'empresas.gerenciar'),
  ('papel-admin', 'usuarios.gerenciar'),
  ('papel-admin', 'auditoria.visualizar');

-- Dicionário de abreviações — semente. Cresce por aprendizado.
INSERT INTO abreviacoes (id, tenant_id, de, para) VALUES
  ('ab01','alfa','CHOC','CHOCOLATE'),   ('ab02','alfa','PT','POTE'),
  ('ab03','alfa','PCT','PACOTE'),       ('ab04','alfa','CX','CAIXA'),
  ('ab05','alfa','REFRIG','REFRIGERANTE'), ('ab06','alfa','ACHOC','ACHOCOLATADO'),
  ('ab07','alfa','BISC','BISCOITO'),    ('ab08','alfa','DET','DETERGENTE'),
  ('ab09','alfa','AMAC','AMACIANTE'),   ('ab10','alfa','MARG','MARGARINA'),
  ('ab11','alfa','INT','INTEGRAL'),     ('ab12','alfa','DESN','DESNATADO'),
  ('ab13','alfa','CONG','CONGELADO'),   ('ab14','alfa','TRAD','TRADICIONAL');
