-- Certificados digitais A1 da captura no SAT (29/09/2026).
-- Só metadados: a chave privada vai direto para o cofre de certificados mTLS da
-- conta Cloudflare e nunca é gravada aqui. Ver src/captura/certificado.ts.
CREATE TABLE certificados (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  nome          TEXT NOT NULL,
  titular       TEXT NOT NULL,
  documento     TEXT,
  tipo          TEXT NOT NULL,
  emissor       TEXT,
  serial        TEXT,
  valido_de     TEXT NOT NULL,
  valido_ate    TEXT NOT NULL,
  cloudflare_id TEXT NOT NULL,
  enviado_em    TEXT NOT NULL,
  enviado_por   TEXT NOT NULL,
  removido_em   TEXT,
  removido_por  TEXT
);
CREATE INDEX idx_certificados_tenant ON certificados (tenant_id, removido_em);

INSERT INTO permissoes (chave, grupo, descricao, ordem) VALUES
  ('certificados.gerenciar', 'Administração', 'Enviar e remover os certificados digitais da captura no SAT', 120);

-- Só o administrador. Quem manda o certificado entrega o acesso do escritório à SEF.
INSERT INTO papel_permissoes (papel_id, permissao)
  SELECT id, 'certificados.gerenciar' FROM papeis WHERE sistema = 1;
