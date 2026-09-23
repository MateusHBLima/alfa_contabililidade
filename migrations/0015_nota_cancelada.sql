-- Nota cancelada (pedido da Taís, 23/09, NF 419887 da Rescaroli): a nota continua no
-- sistema com a chave, mas vale ZERO - fora das somas, dos relatórios e da exportação.
--
-- Colunas próprias em vez de reaproveitar `status`: cancelar é reversível (erro de
-- quem marcou, evento importado por engano) e precisa dizer quem, quando e por quê.
-- O XML original não muda (invariante 1): o que muda é como a nota conta.
ALTER TABLE notas ADD COLUMN cancelada_em TEXT;
ALTER TABLE notas ADD COLUMN cancelada_por TEXT;
ALTER TABLE notas ADD COLUMN cancelada_motivo TEXT;
