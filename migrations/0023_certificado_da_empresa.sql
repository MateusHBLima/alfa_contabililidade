-- Qual certificado a SEF aceitou para cada empresa (01/10/2026).
--
-- A SEF só entrega as notas de uma empresa para o contabilista vinculado a ela
-- (rejeição 8002 para os outros). Com dois certificados (Isa e Alfa), o sistema tenta
-- um e, se a SEF recusar por vínculo, tenta o outro; o que funcionou fica gravado aqui
-- e é usado primeiro nas próximas buscas daquela empresa.
ALTER TABLE captura_empresas ADD COLUMN certificado_confirmado_em TEXT;
