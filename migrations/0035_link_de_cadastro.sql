-- "+ Novo usuário" por link de cadastro (pedido do Mateus, 23/10).
--
-- A gestora (Taís) escolhe o papel e as empresas e gera um link de uso único. A pessoa
-- abre, cria a conta dela (nome, e-mail e senha) e já entra, com o papel e as empresas
-- que a gestora escolheu. É o convite que já existia, agora levando também as empresas
-- e para quem é. Nada é apagado: cancelar um link grava revogado = 1.
ALTER TABLE convites ADD COLUMN empresas TEXT;   -- JSON com os ids das empresas; NULL = nenhuma
ALTER TABLE convites ADD COLUMN para TEXT;       -- lembrete de quem gerou ("Amanda")
ALTER TABLE convites ADD COLUMN usado_por TEXT;  -- conta criada pelo link (a última, se vários usos)
