-- Valores fiscais por item, copiados do XML (retorno da Tais, 22/09).
--
-- O relatorio por CFOP somava so o valor dos produtos. O livro de entradas - que e
-- contra o que ela confere - soma o VALOR CONTABIL (produto - desconto + frete +
-- seguro + outras + ST + FCP-ST + IPI) e mostra base de calculo e ICMS por CFOP.
-- Na Sailor a diferenca foi de R$ 42,43, frete e outras despesas de duas notas.
--
-- Copia do XML, como o resto do item: so leitura e relatorio, nunca entra no XML
-- corrigido (invariante 3). valores_lidos = 0 marca item importado antes desta
-- migracao: o sistema le o XML original guardado e preenche, sem tocar no original.
ALTER TABLE itens ADD COLUMN v_desc REAL;
ALTER TABLE itens ADD COLUMN v_frete REAL;
ALTER TABLE itens ADD COLUMN v_seg REAL;
ALTER TABLE itens ADD COLUMN v_outro REAL;
ALTER TABLE itens ADD COLUMN v_bc_icms REAL;
ALTER TABLE itens ADD COLUMN v_icms REAL;
ALTER TABLE itens ADD COLUMN v_bc_st REAL;
ALTER TABLE itens ADD COLUMN v_st REAL;
ALTER TABLE itens ADD COLUMN v_fcp_st REAL;
ALTER TABLE itens ADD COLUMN v_ipi REAL;
ALTER TABLE itens ADD COLUMN valor_contabil REAL;
ALTER TABLE itens ADD COLUMN valores_lidos INTEGER NOT NULL DEFAULT 0;
