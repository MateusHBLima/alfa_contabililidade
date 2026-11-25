-- Questor SYN (25/11, Mateus: "o Questor tem que aceitar como a gente mandar").
--
-- O XML só leva o CFOP de 4 dígitos; pelo SYN a nota vai com a natureza inteira
-- (1556008), item por item. Esta tabela guarda cada envio: o que foi, quem mandou,
-- o id que o Questor devolveu e a situação, para a tela dizer o que já foi e o que deu
-- erro. Nada é apagado: reenviar a mesma nota cria outra linha.
CREATE TABLE IF NOT EXISTS questor_envios (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  empresa_id     TEXT NOT NULL,
  nota_id        TEXT NOT NULL,
  data_documentos TEXT NOT NULL,   -- DD/MM/AAAA, como foi ao Questor
  dado_id        TEXT,             -- id devolvido pelo Questor
  situacao       TEXT NOT NULL,    -- enviado | erro | <o que o Questor disser depois>
  resposta       TEXT,             -- resumo da resposta (sem segredo)
  arquivo_sha256 TEXT,
  criado_por     TEXT,
  criado_em      TEXT NOT NULL,
  atualizado_em  TEXT
);

CREATE INDEX IF NOT EXISTS idx_questor_envios_nota ON questor_envios (tenant_id, nota_id);
CREATE INDEX IF NOT EXISTS idx_questor_envios_empresa ON questor_envios (tenant_id, empresa_id, criado_em);

-- Mandar ao Questor é decisão de escrituração: nasce só no Admin.
INSERT INTO permissoes (chave, grupo, descricao, ordem) VALUES
  ('questor.enviar', 'Notas', 'Mandar notas ao Questor pelo SYN (com a natureza completa)', 93);

INSERT INTO papel_permissoes (papel_id, permissao)
  SELECT id, 'questor.enviar' FROM papeis WHERE sistema = 1;
