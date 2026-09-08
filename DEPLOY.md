# Subir o Planee Fiscal na Cloudflare

Passo a passo para a primeira publicação. **Rode do seu terminal**, na sua máquina — nem o
ambiente do Claude nem a VM do app Cowork alcançam a API da Cloudflare.

Tempo estimado: 15 minutos, sendo 10 esperando a conta ser criada.

---

## O jeito mais curto: dois cliques

Na raiz do projeto tem um arquivo **`subir.cmd`**. **Dê dois cliques nele.**

Ele faz tudo sozinho: instala as dependências se faltarem, cria as tabelas do banco local,
cria o usuário administrador e sobe o servidor — e ainda abre o navegador em
`http://localhost:8787`.

```
Usuário:  contadora@alfacontabil.net
Senha:    alfa-contabilidade-2026
```

**A tela de login já vem preenchida com esse par** — é só dar Enter. Embaixo do botão
há um bloco *modo local* com os dois valores e um botão de copiar, para quando você
precisar deles em outro lugar.

Esse bloco **não existe em nada que for publicado**: ele depende de `LOGIN_DEMO`, que
mora no `.dev.vars`, e o wrangler lê o `.dev.vars` só no `wrangler dev` — nunca envia
no deploy. Sem essa chave, a rota `/api/local` responde 404 e o bloco fica escondido.
A trava não é o `AMBIENTE`: esse continua `dev` no `wrangler.jsonc` que vai para
produção, e trava que depende de alguém lembrar de trocar uma string não é trava.

A senha só existe como hash, no banco local desta máquina. Para usar outro par, rode
`node scripts\preparar-local.mjs seu@email.com "sua frase de senha longa"` antes.

Deixe a janela preta aberta enquanto estiver usando — fechá-la derruba o servidor.
`Ctrl+C` encerra.

---

## Atalho: rodar sem conta nenhuma

**Antes de criar conta em lugar algum, você pode ver o sistema funcionando.** O modo local
do wrangler roda tudo na sua máquina — banco SQLite local, arquivos em disco, sem
Cloudflare, sem cartão, sem internet além do `npm install`.

```bash
cd planee-fiscal
npm install
npm run db:migrate:local                 # cria as tabelas no banco local
node scripts/semear-usuario.mjs voce@alfacontabil.net "uma frase de senha longa"
```

O script imprime dois `INSERT`. Rode-os no banco local:

```bash
npx wrangler d1 execute planee-fiscal --local --command "<primeiro INSERT>"
npx wrangler d1 execute planee-fiscal --local --command "<segundo INSERT>"
```

E suba:

```bash
npm run dev
```

Abre em `http://localhost:8787`. Entra com o usuário que você criou, cadastra a empresa,
sobe um XML e trata. **É o sistema inteiro, de verdade** — o que muda no deploy é só onde
o banco e os arquivos moram.

Use isso para o primeiro teste com o pessoal e para calibrar o motor de regras com notas
reais. A conta na Cloudflare só é necessária quando quiserem uma URL pública.

> O que **não** funciona no modo local: nada. Upload, motor de regras, alertas, exportação
> e auditoria rodam igual. O banco local vive em `.wrangler/state/` e é descartável — apagar
> essa pasta zera tudo e recomeça.

---

## Publicar: um clique

Depois que a conta na Cloudflare existir e o R2 estiver habilitado, **dê dois cliques em
`publicar.cmd`** na raiz do projeto.

Ele faz o caminho inteiro, e é **idempotente** — cada passo confere se a coisa já existe
antes de criar, então parar no meio e rodar de novo continua de onde parou:

1. login na Cloudflare (abre o navegador se precisar)
2. cria o banco D1 e **escreve o `database_id` no `wrangler.jsonc` sozinho**
3. cria os dois buckets R2
4. aplica as migrações em produção
5. grava `SESSION_SECRET` e `AUDIT_SEED` a partir do `SEGREDOS.txt`
6. cria o primeiro administrador (pergunta e-mail e senha; o hash é calculado na sua
   máquina e só o hash viaja)
7. publica, e imprime a URL

**O que ele deliberadamente NÃO faz:** ativar o Object Lock. Isso é irreversível por cinco
anos — qualquer XML de teste que estiver no bucket fica lá até 2031. Vai a dedo, pelo
painel, depois que os testes acabarem.

Os passos manuais abaixo continuam documentados para quando algo sair do script.

---

## 0. O que você precisa antes

- **Conta na Cloudflare.** O plano gratuito atende a fase 1 inteira.
- **Um cartão cadastrado.** O R2 exige forma de pagamento mesmo no nível gratuito
  (10 GB de armazenamento e as operações do nosso volume cabem no grátis). Não é cobrança;
  é cadastro.
- **Node 18 ou superior.** Confira com `node -v`.

Não precisa de plano pago agora. O Workers Paid (US$ 5/mês) só entra quando o volume passar
de 100 mil requisições por dia — o que, para um escritório, demora.

---

## 1. Entrar

```bash
cd planee-fiscal
npm install
npx wrangler login
```

Abre o navegador. Autorize.

```bash
npx wrangler whoami        # confere se entrou na conta certa
```

---

## 2. Criar o banco

```bash
npx wrangler d1 create planee-fiscal
```

A saída traz um bloco parecido com:

```
database_name = "planee-fiscal"
database_id = "a1b2c3d4-...."
```

**Copie o `database_id`** e cole no `wrangler.jsonc`, no lugar de `PREENCHER_APOS_CRIAR`.

---

## 3. Criar os dois buckets de arquivo

```bash
npx wrangler r2 bucket create planee-xml-original
npx wrangler r2 bucket create planee-xml-trabalho
```

O primeiro guarda o XML assinado do fornecedor — nunca é alterado. O segundo guarda as
cópias de trabalho.

> **Depois do primeiro deploy**, ative o **Object Lock** no bucket `planee-xml-original`
> pelo painel: R2 → planee-xml-original → Settings → Object Lock, modo *Compliance*,
> retenção **5 anos**. É o que sustenta a cláusula 5.5.3 do contrato — a partir daí o
> arquivo não pode ser apagado nem sobrescrito nem por administrador. **Não ative antes de
> testar**, senão qualquer arquivo de teste fica lá pelos próximos cinco anos.

---

## 4. Criar as tabelas

```bash
npm run db:migrate:prod
```

Aplica as três migrações: esquema base, template/fornecedores/lotes, e a semente com
permissões, papéis e o dicionário de abreviações.

Conferir:

```bash
npx wrangler d1 execute planee-fiscal --remote --command "SELECT nome FROM papeis"
```

Deve listar Operador, Supervisor e Admin.

---

## 5. Guardar os dois segredos

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put AUDIT_SEED
```

Cada comando pede o valor. Os valores estão em `SEGREDOS.txt`, na raiz do projeto — esse
arquivo é ignorado pelo git e **não deve ser commitado**. Depois de colar os dois, pode
apagá-lo.

> **Não troque o `AUDIT_SEED` depois que houver registros.** Ele é o primeiro elo da cadeia
> de hash da auditoria; trocar quebra a verificação de integridade de tudo o que já foi
> gravado. Define uma vez e esquece.

---

## 6. Criar o primeiro usuário

```bash
node scripts/semear-usuario.mjs contadora@alfacontabil.net "uma frase de senha bem longa"
```

Ele imprime dois `INSERT`. Rode-os:

```bash
npx wrangler d1 execute planee-fiscal --remote --command "<cole o primeiro INSERT>"
npx wrangler d1 execute planee-fiscal --remote --command "<cole o segundo INSERT>"
```

A senha nunca entra em arquivo do repositório — o script calcula o hash na sua máquina e só
o hash vai para o banco.

---

## 7. Publicar

```bash
npm run deploy
```

Sai a URL, algo como `https://planee-fiscal.<sua-conta>.workers.dev`.

Abra, entre com o usuário do passo 6, cadastre a empresa-piloto e suba uma nota.

---

## Conferir se está tudo de pé

```bash
curl https://planee-fiscal.<sua-conta>.workers.dev/api/saude
# {"ok":true,"ambiente":"dev"}
```

Na aplicação, o caminho feliz para o primeiro teste:

1. **Empresas → Nova empresa.** Preencha o CNAE e saia do campo: o perfil e o CFOP padrão
   vêm sugeridos sozinhos.
2. **Notas recebidas.** Arraste os XML da competência.
3. **Tratamento.** Todos os itens virão amarelos na primeira vez — o sistema ainda não sabe
   nada, então está chutando pelo perfil. É esperado.
4. Corrija alguns itens. Suba a competência seguinte e veja quantos vêm verdes.

**Esse é o teste que importa.** O número de itens que vêm prontos na segunda competência é
o que diz se o produto funciona.

---

## Quando for atualizar

```bash
git pull
npm test          # 139 testes — rode antes de publicar
npm run deploy
```

Migração nova exige `npm run db:migrate:prod` antes do deploy.

---

## Se der errado

| Sintoma | Provável causa |
|---|---|
| `D1_ERROR: no such table` | faltou o `npm run db:migrate:prod` |
| Login recusa a senha certa | o `INSERT` do usuário não rodou, ou rodou no banco local em vez do `--remote` |
| Tela abre mas fica em branco | veja o console do navegador; provavelmente `/api/eu` respondeu 401 — cookie não gravou (precisa ser HTTPS) |
| `Missing binding ASSETS` | wrangler antigo; `npm i -D wrangler@latest` |
| Upload aceita mas a nota some | veja `npx wrangler tail` com a aplicação aberta |

`npx wrangler tail` mostra os logs em tempo real. É a primeira coisa a abrir quando algo não
bate.
