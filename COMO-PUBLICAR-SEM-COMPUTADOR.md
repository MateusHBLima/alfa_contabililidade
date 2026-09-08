# Publicar o Planee Fiscal usando SÓ o navegador

Nada aqui depende do computador onde está a pasta `C:\claude\...`.
Tudo é feito no navegador do computador em que você está agora.

## Passo 1 — deixar o Claude enviar o código

No app do Claude (este mesmo, na máquina em que você está):
autorize o repositório `MateusHBLima/alfa_contabililidade` nas fontes/sources
desta sessão. Depois é só me avisar: eu envio os 25 commits sozinho.

Se não achar essa opção, use o Plano B no fim deste arquivo.

## Passo 2 — criar o token da Cloudflare (navegador)

1. https://dash.cloudflare.com/profile/api-tokens
2. **Create Token** → **Edit Cloudflare Workers** → Use template
3. Account Resources: sua conta. Zone Resources: All zones (ou nenhuma).
4. Continue → Create Token → **copie o token** (só aparece uma vez).

## Passo 3 — guardar o token no GitHub (navegador)

1. https://github.com/MateusHBLima/alfa_contabililidade/settings/secrets/actions
2. **New repository secret**, duas vezes:

   | Name | Secret |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | o token do passo 2 |
   | `CLOUDFLARE_ACCOUNT_ID` | `18d266ae332655e3a32e712fccbda47e` |

## Passo 4 — publicar

Assim que o código subir (passo 1), o GitHub Actions publica sozinho.
Para acompanhar ou repetir:
https://github.com/MateusHBLima/alfa_contabililidade/actions
→ **Publicar na Cloudflare** → **Run workflow**.

O robô roda os testes, aplica as migrações no banco de produção,
publica o Worker e confere `/api/saude` no fim. Se algo falhar, ele para
antes de publicar.

---

## Plano B — sem autorizar o repositório

Eu te entrego aqui na conversa o arquivo `planee-fiscal-atualizado.zip`
com o projeto inteiro. Você:

1. Baixa e descompacta.
2. Vai em https://github.com/MateusHBLima/alfa_contabililidade
3. **Add file → Upload files**, arrasta tudo, **Commit changes**.
4. Segue os passos 2, 3 e 4 acima.

É mais chato, mas também só usa o navegador.
