-- Segundo fator, limite por origem e redefinição de senha pelo admin.
--
-- Entra agora, não "antes da fase 2". Autenticação é a parte do sistema que não
-- se troca depois sem mexer em tudo: fluxo de login, sessão, telas e o modelo de
-- usuário. Feito no começo é uma tarde; retrofitado é um mês e nunca fica bom.

-- ---------------------------------------------------------------- segundo fator
CREATE TABLE usuario_mfa (
  usuario_id      TEXT PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  segredo         TEXT NOT NULL,
  ativo           INTEGER NOT NULL DEFAULT 0,
  -- O contador do último código aceito. Sem isso, quem espiar o código por cima
  -- do ombro pode usá-lo de novo dentro dos mesmos 30 segundos.
  ultimo_contador INTEGER,
  confirmado_em   TEXT,
  criado_em       TEXT NOT NULL
);

-- Códigos de recuperação: a saída para celular perdido. Guardados como hash,
-- porque quem lê o banco não pode entrar na conta de ninguém.
CREATE TABLE mfa_recuperacao (
  id          TEXT PRIMARY KEY,
  usuario_id  TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  codigo_hash TEXT NOT NULL,
  usado_em    TEXT,
  criado_em   TEXT NOT NULL
);
CREATE INDEX idx_mfa_rec_usuario ON mfa_recuperacao (usuario_id, usado_em);

-- Entre a senha e o código há um estado intermediário: senha aceita, segundo
-- fator pendente. Ele NÃO pode ser uma sessão — sessão é o que se ganha depois.
CREATE TABLE desafios_mfa (
  id         TEXT PRIMARY KEY,
  usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  expira_em  TEXT NOT NULL,
  usado      INTEGER NOT NULL DEFAULT 0,
  ip         TEXT,
  criado_em  TEXT NOT NULL
);
CREATE INDEX idx_desafios_usuario ON desafios_mfa (usuario_id, usado);

-- ---------------------------------------------------------------- limite por origem
-- O bloqueio de 5 tentativas é POR CONTA: trava quem insiste numa conta e não
-- faz nada contra quem tenta uma senha em cem contas. Este registro é por
-- ORIGEM, e fecha esse buraco.
CREATE TABLE tentativas_login (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ip      TEXT NOT NULL,
  quando  TEXT NOT NULL,
  sucesso INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_tentativas_ip ON tentativas_login (ip, quando);

-- ---------------------------------------------------------------- permissões novas
INSERT INTO permissoes (chave, grupo, descricao, ordem) VALUES
  ('usuarios.redefinir_senha', 'Administração', 'Redefinir a senha de outro usuário',        95),
  ('usuarios.desativar_mfa',   'Administração', 'Desligar o segundo fator de outro usuário', 96);

INSERT INTO papel_permissoes (papel_id, permissao) VALUES
  ('papel-admin', 'usuarios.redefinir_senha'),
  ('papel-admin', 'usuarios.desativar_mfa');
