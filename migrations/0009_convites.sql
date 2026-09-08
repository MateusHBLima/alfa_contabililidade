-- Convite: entra já liberado, com o papel que o convite carrega.
--
-- O pedido foi "os 3 primeiros que entrarem já entram como admin, para não
-- termos trabalho". O objetivo — ninguém precisar aprovar ninguém — está certo.
-- O critério "os 3 primeiros" é que não dá: o endereço é público, então os três
-- primeiros podem ser três desconhecidos que acharam a URL antes dos seus
-- colegas. E seriam administradores de um sistema com nota fiscal de clientes.
--
-- O convite resolve o mesmo problema sem essa aposta: você gera um link, manda
-- no grupo do escritório, e quem abrir entra direto como Admin. A diferença é
-- que o poder segue quem RECEBEU o link, não quem chegou primeiro.
CREATE TABLE convites (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  -- Só o hash. Quem lê o banco não consegue usar o convite de ninguém, pela
  -- mesma razão que não guardamos senha em texto.
  codigo_hash TEXT NOT NULL,
  papel_id    TEXT NOT NULL REFERENCES papeis(id),
  usos_max    INTEGER NOT NULL DEFAULT 1,
  usos        INTEGER NOT NULL DEFAULT 0,
  expira_em   TEXT NOT NULL,
  criado_por  TEXT REFERENCES usuarios(id),
  criado_em   TEXT NOT NULL,
  revogado    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_convites_tenant ON convites (tenant_id, revogado);

-- De onde veio cada conta: convite, cadastro aprovado, ou criada pelo admin.
-- Sem isso, daqui a seis meses ninguém sabe dizer por que fulano é Admin.
ALTER TABLE usuarios ADD COLUMN convite_id TEXT REFERENCES convites(id);

INSERT INTO permissoes (chave, grupo, descricao, ordem) VALUES
  ('usuarios.convidar', 'Usuários', 'Gerar links de convite', 315);

INSERT OR IGNORE INTO papel_permissoes (papel_id, permissao)
  SELECT p.id, 'usuarios.convidar' FROM papeis p WHERE p.sistema = 1;
INSERT OR IGNORE INTO papel_permissoes (papel_id, permissao)
  SELECT papel_id, 'usuarios.convidar' FROM papel_permissoes WHERE permissao = 'usuarios.criar';
