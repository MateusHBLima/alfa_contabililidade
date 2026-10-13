-- Até quando a SEF já entregou tudo de uma empresa (13/10/2026, pedido da Taís:
-- "se não teve movimento no mês, que ele me avise"; "preciso que fique o mês inteiro").
--
-- sef_completo_em: a última consulta que terminou sem ter mais nada na SEF (117, ou
-- 118 com menos de 50). Como a SEF entrega cada nota 24 h depois da autorização, o
-- que foi emitido até 2 dias antes dessa hora já está todo na caixa.
ALTER TABLE captura_empresas ADD COLUMN sef_completo_em TEXT;

-- As consultas de antes desta migração: a última que fechou sem ter mais.
UPDATE captura_empresas SET sef_completo_em = (
  SELECT MAX(b.quando) FROM captura_buscas b
   WHERE b.empresa_id = captura_empresas.empresa_id AND b.erro IS NULL
     AND (b.cstat = '117' OR (b.cstat = '118' AND b.documentos < 50))
);
