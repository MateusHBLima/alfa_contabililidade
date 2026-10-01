-- Busca automática na SEF por empresa (01/10/2026, ideia da Taís).
--
-- Com a busca automática ligada, o cron consulta a SEF da empresa sempre que ela
-- libera (12 h depois da última consulta completa) e importa sozinho as notas
-- emitidas a partir de `auto_desde`. O que a SEF mandar de antes disso fica na caixa,
-- para importar à mão. A importação é feita em nome de quem ligou (auto_ligada_por).
ALTER TABLE captura_empresas ADD COLUMN auto_ligada INTEGER NOT NULL DEFAULT 0;
ALTER TABLE captura_empresas ADD COLUMN auto_desde TEXT;
ALTER TABLE captura_empresas ADD COLUMN auto_ligada_por TEXT;
ALTER TABLE captura_empresas ADD COLUMN auto_ligada_em TEXT;
ALTER TABLE captura_empresas ADD COLUMN auto_ultima TEXT;
ALTER TABLE captura_empresas ADD COLUMN auto_ultimo_resultado TEXT;
CREATE INDEX idx_captura_auto ON captura_empresas (auto_ligada, proxima_consulta);

-- Nota da caixa que a busca automática decidiu não importar, e por quê: emitida pela
-- própria empresa, cancelada, ou recusada pelo importador. Sem isto ela seria tentada
-- de novo a cada rodada. Continua na caixa e pode ser importada à mão.
ALTER TABLE captura_caixa ADD COLUMN auto_recusada TEXT;
