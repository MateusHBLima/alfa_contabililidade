-- Conversas do assistente gravadas (19/10, pedido do Mateus).
--
-- "isso tem que ficar gravado, para que possamos usar para ajustar a IA, ver o que ela
--  esta falando e sugerindo. Ela deve tambem poder falar o que deve ser ajustado, e
--  conseguir referenciar o que."
--
-- assistente_conversa: uma por painel aberto (por pessoa e empresa).
-- assistente_mensagem: o que ela escreveu e o que a IA respondeu, em ordem. Na resposta
--   da IA ficam também as buscas que ela fez e o que viu (passos), as propostas, os
--   tokens gastos (uso), o tempo e o erro, se deu erro.
-- assistente_evento: o que aconteceu DEPOIS com uma resposta, sempre apontando para ela:
--   confirmou / deixou de lado uma proposta, ou um ajuste (o que deve mudar), escrito por
--   ela no botão "Ajustar" ou anotado pela própria IA quando ela corrigiu.
--
-- Nada aqui muda nota, regra ou marca: é só registro. Nada é apagado.
CREATE TABLE IF NOT EXISTS assistente_conversa (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  empresa_id    TEXT NOT NULL,
  usuario_id    TEXT NOT NULL,
  usuario_nome  TEXT,
  iniciada_em   TEXT NOT NULL,
  atualizada_em TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assistente_conversa_data ON assistente_conversa (tenant_id, atualizada_em);

CREATE TABLE IF NOT EXISTS assistente_mensagem (
  id          TEXT PRIMARY KEY,
  conversa_id TEXT NOT NULL REFERENCES assistente_conversa (id),
  ordem       INTEGER NOT NULL,
  papel       TEXT NOT NULL CHECK (papel IN ('ela', 'assistente')),
  texto       TEXT NOT NULL,
  passos      TEXT,
  propostas   TEXT,
  uso         TEXT,
  modelo      TEXT,
  ms          INTEGER,
  erro        TEXT,
  criada_em   TEXT NOT NULL,
  UNIQUE (conversa_id, ordem)
);

CREATE TABLE IF NOT EXISTS assistente_evento (
  id           TEXT PRIMARY KEY,
  conversa_id  TEXT NOT NULL REFERENCES assistente_conversa (id),
  mensagem_id  TEXT NOT NULL REFERENCES assistente_mensagem (id),
  tipo         TEXT NOT NULL CHECK (tipo IN ('confirmou', 'descartou', 'ajuste')),
  origem       TEXT NOT NULL CHECK (origem IN ('tela', 'ia')),
  proposta     TEXT,
  texto        TEXT,
  sobre        TEXT,
  usuario_id   TEXT,
  usuario_nome TEXT,
  criado_em    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assistente_evento_conversa ON assistente_evento (conversa_id);
