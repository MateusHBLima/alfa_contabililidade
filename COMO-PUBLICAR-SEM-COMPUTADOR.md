# Como o Planee Fiscal é publicado

Não depende de computador nenhum. A Cloudflare está ligada direto neste
repositório: **todo commit na branch `main` publica sozinho.**

## O que acontece a cada commit

1. A Cloudflare baixa o código deste repositório.
2. Roda `npx wrangler d1 migrations apply planee-fiscal --remote`
   (aplica as migrações pendentes no banco de produção).
3. Roda `npx wrangler deploy` (publica o Worker).

Acompanhe em **Workers & Pages → planee-fiscal → Deployments**.

## Endereço

https://planee-fiscal.planee.workers.dev

Para conferir se está no ar: https://planee-fiscal.planee.workers.dev/api/saude

## Se precisar publicar da sua máquina

Duplo clique em `PUBLICAR-NA-CLOUDFLARE.cmd`, na pasta
`C:\claude\Alfa_contabilidade_fiscal`. Faz a mesma coisa, pelo caminho manual.

## Testes

O GitHub Actions roda os 300 testes e o typecheck a cada commit
(aba **Actions**). A publicação em si é da Cloudflare.
