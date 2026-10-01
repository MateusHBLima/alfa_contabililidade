-- O que a busca automática faz aparece como "Busca automática" no histórico, e não
-- com o nome de quem a ligou (01/10/2026, pedido do Mateus). usuario_id continua
-- sendo quem ligou: é em nome dela que o cron age, e o rastro não se perde.
ALTER TABLE captura_buscas ADD COLUMN automatica INTEGER NOT NULL DEFAULT 0;
