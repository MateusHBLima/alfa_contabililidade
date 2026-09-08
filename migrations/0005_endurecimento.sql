-- Endurecimento da autenticação, a partir de uma revisão adversarial do 0004.
--
-- Nenhum destes ajustes é teórico: cada um fecha um caminho concreto que a
-- revisão descreveu com o cenário de exploração junto.

-- Um desafio de MFA sem contador aceita tentativas ilimitadas durante os 5
-- minutos de validade. Seis dígitos são 1 milhão de combinações; 5 minutos de
-- requisições paralelas mordem um pedaço disso, e o único freio era um limite
-- por origem que falhava aberto quando o IP não vinha.
ALTER TABLE desafios_mfa ADD COLUMN tentativas INTEGER NOT NULL DEFAULT 0;

-- O login procurava o e-mail SEM o tenant, mas a unicidade no esquema é
-- (tenant_id, email). Com um tenant só isso nunca aparece; no segundo, dois
-- usuários com o mesmo e-mail em tenants diferentes fazem o login casar com uma
-- linha arbitrária — e as falhas de um bloqueiam a conta do outro. Enquanto não
-- existe seletor de tenant na tela, a unicidade global é o que torna a busca por
-- e-mail uma pergunta com uma resposta só.
CREATE UNIQUE INDEX idx_usuarios_email_global ON usuarios (lower(email));
