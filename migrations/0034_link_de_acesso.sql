-- Link de acesso (23/10).
--
-- O caso que levou a isto: a Taís criou o usuário da Amanda, a Amanda não recebeu
-- e-mail nenhum (o sistema não manda e-mail; a senha provisória aparecia só na tela de
-- quem criou), a Taís gerou um convite, a Amanda se cadastrou pelo convite com o mesmo
-- e-mail e a tela respondeu "precisa liberar" sem criar nada. Ninguém conseguia saber
-- o que estava acontecendo.
--
-- Agora: criar usuário (e o botão "Link de acesso" na lista) gera um link de uso único.
-- Quem administra manda o link pelo WhatsApp; a pessoa abre, cria a senha dela e entra.
-- Sem senha provisória passando de mão em mão e sem depender de e-mail.
--
-- O código do link fica só como hash (igual ao convite): quem lê o banco não usa o link
-- de ninguém. Gerar um link novo revoga os anteriores da mesma pessoa. Nada é apagado.
CREATE TABLE IF NOT EXISTS links_acesso (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  usuario_id   TEXT NOT NULL,
  codigo_hash  TEXT NOT NULL,
  motivo       TEXT NOT NULL,   -- 'primeiro' (conta nova) | 'senha' (senha nova)
  criado_por   TEXT,
  criado_em    TEXT NOT NULL,
  expira_em    TEXT NOT NULL,
  usado_em     TEXT,
  revogado_em  TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_links_acesso_codigo ON links_acesso (codigo_hash);
CREATE INDEX IF NOT EXISTS idx_links_acesso_usuario ON links_acesso (usuario_id);

-- 1 = a conta foi criada e a pessoa ainda não criou a senha dela pelo link.
-- Contas antigas ficam 0 (já têm senha).
ALTER TABLE usuarios ADD COLUMN aguardando_senha INTEGER NOT NULL DEFAULT 0;
