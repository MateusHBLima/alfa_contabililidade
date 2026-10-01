-- Onde o certificado A1 está guardado (01/10/2026).
--
-- 'cloudflare': cofre mTLS da Cloudflare (29/09). Não serve para a SEF/SC: o servidor
--   dela pede o certificado por renegociação TLS, que o fetch da Cloudflare não faz.
-- 'ponte': intermediário em Node na VPS da Planee (relay/relay.mjs), que renegocia.
--   A chave fica cifrada lá; aqui continua só o que se pode mostrar.
ALTER TABLE certificados ADD COLUMN guardado_em TEXT NOT NULL DEFAULT 'cloudflare';
