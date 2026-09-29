-- Nota de estorno (29/09/2026, pedido da Taís, L'Italiana Empório): NF-e com tipo de
-- operação ENTRADA (tpNF = 0) emitida por terceiro, com a empresa como destinatária.
-- Para a empresa ela é uma SAÍDA: não soma nas entradas, nos relatórios nem na
-- exportação, e aparece em destaque para ser lançada à mão nas saídas.
-- Notas antigas ficam com tp_nf NULL e estorno 0 (seguem como estavam).
ALTER TABLE notas ADD COLUMN tp_nf TEXT;
ALTER TABLE notas ADD COLUMN estorno INTEGER NOT NULL DEFAULT 0;
