# Planee Fiscal

Plataforma de tratamento de NF-e de entrada para a **ALFA CONTABILIDADE**.

Lê o XML das notas que os fornecedores emitem contra os clientes do escritório, converte o
CFOP de saída em CFOP de entrada, padroniza a descrição dos produtos, e **aprende com o que
a contadora corrige** — de modo que a próxima nota do mesmo fornecedor já chegue preenchida.

> O plano completo do projeto (decisões, arquitetura, prazos, pendências) fica no Projeto
> Claude da ALFA, em `claude/plano-infraestrutura.md`. **Leia antes de mexer aqui.**

---

## ⚠️ Antes de tentar o deploy

Este código foi escrito para **Cloudflare Workers**: usa D1 (banco) e R2 (arquivos) como
bindings do runtime da Cloudflare.

**Ele não roda na Vercel sem porte.** A Vercel não tem D1 nem R2, e não executa o runtime
de Workers. O que é portável e o que não é:

| Portável sem mexer | Precisa de porte |
|---|---|
| `src/nfe/*` — parser, gerador de XML, invariantes | `src/db/repo.ts` — SQL em dialeto SQLite |
| `src/rules/*` — motor de regras, campos, alertas | `src/db/auditoria.ts` — mesmo motivo |
| `src/auth/*` — senha, permissões | `src/nfe/importador.ts` — grava no R2 |
| `src/empresas/cnae.ts` | `src/index.ts` — bindings `c.env.DB` / `c.env.XML_ORIGINAL` |
| Hono (roda nos dois) | `wrangler.jsonc` |

Ou seja: **a lógica de negócio inteira é portável**; o que muda é a camada de banco e de
arquivos. Ver a seção "Deploy" abaixo antes de decidir.

---

## Rodar local

```bash
npm install
npm test          # 132 testes, sem precisar de conta em lugar nenhum
npm run typecheck
```

Os testes de integração rodam o sistema inteiro contra um **SQLite real**
(`test/d1-local.ts` faz o `node:sqlite` falar a interface do D1). Não é mock: é banco de
verdade. D1 *é* SQLite, então o que passa aqui passa lá — o que não é simulado é latência,
limite de tamanho e concorrência.

```bash
npm run test:integracao
```

---

## Como está organizado

```
src/
  nfe/
    parser.ts       lê NF-e 55 (nfeProc ou NFe cru), tolera prefixo de namespace
    serializer.ts   gera o XML corrigido + 12 invariantes que protegem a nota
    importador.ts   upload → parse → R2 → fornecedor → motor de regras
    tipos.ts
  rules/
    engine.ts       a escada de 7 níveis: sugerir, aprender, confiança
    campos.ts       registro dos campos do template — onde mora "registra, não reescreve"
    alertas.ts      9 detectores de divergência + regras de destaque na tela
  auth/
    senha.ts        PBKDF2-SHA256 600k, comparação em tempo constante
    permissoes.ts   catálogo de permissões, papéis-semente, recorte por empresa
  db/
    repo.ts         TODA escrita passa por aqui — e é aqui que a auditoria é gravada
    auditoria.ts    trilha append-only com cadeia de hash
  empresas/
    cnae.ts         CNAE → perfil → CFOP padrão (pré-preenchimento do cadastro)
  index.ts          a API (Hono)
migrations/         0001 esquema base · 0002 template, fornecedores, lotes
test/               132 testes, incluindo integração contra SQLite real
```

---

## Três decisões que o código protege

**1. O XML original nunca é alterado.** A assinatura do fornecedor seria invalidada. O
corrigido é cópia de trabalho, gerada por **edição cirúrgica no texto** — não por
reserialização. Assim um `diff` entre original e corrigido mostra exatamente as linhas
alteradas e nada mais. Há teste garantindo isso.

**2. Registra, não reescreve.** CST de entrada, conta contábil e crédito de ICMS/PIS/COFINS
são guardados e aprendidos, mas **não** vão para dentro do XML — só CFOP e descrição vão.
Cada campo declara isso em `src/rules/campos.ts`, e há teste travando. Mudar isso é decisão
fiscal, não decisão de programador.

**3. Uma regra recém-criada nasce amarela, não verde.** Ver o item uma vez não é saber. O
verde exige nível específico *e* histórico de acerto. Regra genérica (por NCM) nunca chega
ao verde.

---

## Deploy

### Caminho para o qual o código foi escrito — Cloudflare

```bash
npx wrangler login
npx wrangler d1 create planee-fiscal          # copie o database_id para wrangler.jsonc
npx wrangler r2 bucket create planee-xml-original
npx wrangler r2 bucket create planee-xml-trabalho
npm run db:migrate:prod
npx wrangler secret put SESSION_SECRET        # string aleatória longa
npx wrangler secret put AUDIT_SEED            # string aleatória longa
npm run deploy
```

Depois, ativar **Object Lock** (modo compliance, retenção 5 anos) no bucket
`planee-xml-original` pelo painel — é o que sustenta a guarda legal do XML.

### Caminho Vercel

Exige porte da camada de dados: D1 → Postgres (Neon ou Vercel Postgres) e R2 → Vercel Blob.
A lógica de negócio não muda. Ver a tabela no topo deste arquivo.

---

## Segredos

Nunca em arquivo. `wrangler secret put` (ou o painel da plataforma escolhida).

| Nome | Para quê |
|---|---|
| `SESSION_SECRET` | assinatura do cookie de sessão |
| `AUDIT_SEED` | primeiro elo da cadeia de hash da auditoria |

Trocar o `AUDIT_SEED` depois de haver registros **quebra a verificação da cadeia**. Defina
uma vez e não mexa.

---

*Propriedade da Planee. Uso licenciado à ALFA CONTABILIDADE durante a vigência do contrato.*
