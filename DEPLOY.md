# Subir o Planee Fiscal na Cloudflare

Passo a passo para a primeira publicação. **Rode do seu terminal**, na sua máquina — nem o
ambiente do Claude nem a VM do app Cowork alcançam a API da Cloudflare.

Tempo estimado: 15 minutos, sendo 10 esperando a conta ser criada.

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
