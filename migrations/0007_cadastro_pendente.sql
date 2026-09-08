-- Cadastro público com aprovação.
--
-- A tela de criar conta é conveniência para o escritório: a pessoa se cadastra
-- sozinha, escolhe a própria senha, e um administrador libera. O que ela NÃO
-- pode ser é porta aberta — por isso a conta nasce sem papel nenhum e inerte.
--
-- `pendente` é separado de `ativo` de propósito. Conta pendente nunca foi
-- liberada; conta inativa foi liberada e depois desligada. Misturar as duas num
-- campo só faria a lista de "esperando aprovação" trazer gente que já foi
-- demitida — e alguém acabaria reativando sem querer.
ALTER TABLE usuarios ADD COLUMN pendente INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usuarios ADD COLUMN solicitado_em TEXT;
ALTER TABLE usuarios ADD COLUMN aprovado_em TEXT;
ALTER TABLE usuarios ADD COLUMN aprovado_por TEXT;

CREATE INDEX idx_usuarios_pendentes ON usuarios (tenant_id, pendente);

INSERT INTO permissoes (chave, grupo, descricao, ordem) VALUES
  ('usuarios.aprovar', 'Usuários', 'Liberar contas que se cadastraram e estão esperando', 305);

INSERT OR IGNORE INTO papel_permissoes (papel_id, permissao)
  SELECT p.id, 'usuarios.aprovar' FROM papeis p WHERE p.sistema = 1;

-- Quem já podia criar usuário também pode aprovar: é a mesma decisão, tomada
-- por outro caminho.
INSERT OR IGNORE INTO papel_permissoes (papel_id, permissao)
  SELECT papel_id, 'usuarios.aprovar' FROM papel_permissoes WHERE permissao = 'usuarios.criar';
