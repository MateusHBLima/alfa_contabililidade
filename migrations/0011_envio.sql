-- Um envio da tela vai em lotes de 20 arquivos (retorno da Tais, 17/09). Para a
-- contadora, os 4 lotes de "78 arquivos que soltei as 16h03" sao UMA importacao.
-- envio_id amarra os lotes de um mesmo envio; lote antigo (sem envio) e um envio
-- sozinho.
ALTER TABLE lotes_importacao ADD COLUMN envio_id TEXT;
CREATE INDEX idx_lotes_envio ON lotes_importacao (tenant_id, empresa_id, envio_id);
