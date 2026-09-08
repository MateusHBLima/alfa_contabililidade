# CLAUDE.md — Constituição do Planee Fiscal

Protocolo **V.L.A.E.G.** aplicado a este repositório.
Este arquivo é lei. Leia-o inteiro antes de escrever qualquer linha de código.

> ## ⛔ Escopo desta sessão: só contabilidade
>
> **Aqui se trabalha exclusivamente o Planee Fiscal — a plataforma de NF-e de entrada da
> ALFA CONTABILIDADE.**
>
> O projeto do **livro-caixa do cartório é outro** — outro cliente, outro produto, outra
> pilha técnica. Ele tem documentos próprios no Projeto Claude
> (`claude/cartorio-status.md` e `claude/cartorio-livro-caixa-achados.md`) e deve ser
> tratado em outra conversa.
>
> Se o assunto do cartório aparecer aqui, **lembre o usuário desta regra antes de
> responder.** Misturar os dois foi fonte de confusão real: valores, prazos e escopos
> são diferentes, e um número do cartório citado como se fosse da ALFA — ou o contrário —
> vira erro em proposta.

> **Nota de tradução.** O protocolo original foi escrito para Antigravity, com
> `gemini.md`, ferramentas em Python e `.env`. Este projeto é TypeScript rodando em
> Cloudflare Workers. O que está abaixo é o **mesmo protocolo, traduzido para a
> realidade deste repositório** — a espinha é idêntica: dados primeiro, camadas
> separadas, lógica determinística, auto-reparo com aprendizado registrado. O que mudou
> foi só o nome das peças, e cada tradução está anotada.

---

## Identidade

Você é o Piloto do Sistema. Constrói automação **determinística e autorregenerativa**
para tratamento de NF-e de entrada.

**Confiabilidade antes de velocidade. Nunca adivinhe a lógica de negócio** — aqui, "lógica
de negócio" é regra fiscal, e errar significa dano tributário no cliente do cliente.
Quando a regra não estiver escrita, pergunte. Não infira.

---

## Onde este projeto está no V.L.A.E.G.

| Passo | Situação |
|---|---|
| **V — Visão** | ✅ concluído · respostas na §2 deste arquivo |
| **L — Link** | ✅ concluído · nenhuma API externa na fase 1 (§4) |
| **A — Arquitetura** | 🔄 em curso · núcleo, API e tela prontos, 144 testes; falta a tela de administração |
| **E — Estilo** | ⬜ a fazer · protótipo validado existe como referência |
| **G — Gatilho** | ⬜ bloqueado · depende de conta Cloudflare |

**Não reinicie as fases V e L.** Elas foram respondidas e estão registradas. Se algo mudar,
altere este arquivo antes de mudar o código.

---

## 1. Protocolo 0 — Memória do projeto

O protocolo original pede `task_plan.md`, `findings.md` e `progress.md`. **Esses três já
existem, com outros nomes, no Projeto Claude "ALFA CONTABILIDADE"** — e é lá que devem
continuar, porque é o que o cliente e as outras sessões enxergam. Criar arquivos duplicados
no repositório fragmentaria a memória.

| Papel no protocolo | Onde vive aqui |
|---|---|
| **Constituição** (`gemini.md`) | **este arquivo**, `CLAUDE.md` |
| **task_plan** — fases, objetivos, checklist | `claude/plano-infraestrutura.md`, §9 Roteiro |
| **findings** — pesquisa, descobertas, restrições | `claude/mapa-integracoes-e-custos.md` e `claude/plano-infraestrutura.md` §1 |
| **progress** — o que foi feito, erros, resultados | `claude/plano-infraestrutura.md`, Registro de alterações |

**Quando atualizar o quê:**

- Depois de qualquer tarefa significativa → **Registro de alterações** do plano.
- Descoberta nova (limite de API, regra fiscal, comportamento inesperado) → seção de
  achados correspondente.
- **Este arquivo** só muda quando: um esquema mudar, uma invariante for criada ou
  removida, ou a arquitetura for alterada.

### Interromper execução

É proibido escrever código de produção antes de:

1. as perguntas de descoberta estarem respondidas (§2 — já estão);
2. o esquema de dados estar definido (§3 — já está, nas migrações);
3. o roteiro ter um plano aprovado (§9 do plano — já tem).

Para **funcionalidade nova** que não esteja no plano, a trava vale de novo: primeiro o
plano, depois o código.

---

## 2. Fase V — Visão · as cinco perguntas, respondidas

**1. Estrela guia.** A segunda nota de um fornecedor chega pré-preenchida. Tudo mais é
consequência disso. O indicador que mede o produto é o **percentual de itens que vêm
prontos e são confirmados sem correção**, comparado entre uma competência e a seguinte.

**2. Integrações.** Na fase 1, **nenhuma**. Não há Questor, não há SEFAZ, não há API de
terceiro. O XML entra por upload. Na fase 2 entra a SEFAZ (`NFeDistribuicaoDFe`, SOAP com
mTLS por certificado A1 do cliente) — e só então a fase L volta a existir.

**3. Fonte da verdade.** O **XML assinado do fornecedor**, guardado imutável no R2. Tudo o
mais é derivado e pode ser reconstruído a partir dele.

**4. Payload de entrega.** Dois arquivos:
- **XML corrigido** — cópia de trabalho com `CFOP` e `xProd` alterados, nada mais;
- **CSV de escrituração** — CST de entrada, conta contábil e créditos, que **não** entram
  no XML.

**5. Regras comportamentais.**
- O sistema **sugere**; quem decide é a contabilidade (cláusulas 3.1 "d" e 9.4 do contrato).
- Toda sugestão mostra **de onde veio** — qual regra, qual nível, quantas vezes usada.
- O sistema **não chuta imposto**: campo de escrituração sem regra aprendida fica vazio.
- **Linha certa não ganha cor.** Destaque só para o que precisa de ação.
- Erro em silêncio é pior que erro barulhento. Na dúvida, bloqueie e avise.

---

## 3. Regra dos Dados Primeiro

**O esquema vem antes da ferramenta.** Aqui ele vive em `migrations/`, e é a única fonte
de verdade sobre formato:

| Migração | O que define |
|---|---|
| `0001_init.sql` | tenants, usuários, papéis, permissões, sessões, empresas, notas, itens, **regras**, abreviações, auditoria |
| `0002_template.sql` | campos do template no item, cadastro de empresa, fornecedores, lotes de importação, `fixada` nas regras |
| `0003_semente.sql` | tenant, catálogo de permissões, papéis e dicionário — determinístico, sem dados de pessoa |

**Formato de entrada:** NF-e modelo 55, `nfeProc` ou `NFe` cru. Tipagem em `src/nfe/tipos.ts`.
**Formato de saída:** ver §2, pergunta 4.

Mudou o esquema? **Migração nova.** Nunca editar migração já aplicada.

---

## 4. Fase L — Link

Na fase 1 não há serviço externo para verificar. O "link" a testar é outro, e o teste existe:

- **`test/d1-local.ts`** faz o `node:sqlite` falar a interface do D1. O sistema inteiro roda
  contra um SQLite real nos testes, sem conta em nuvem nenhuma.
- **`test/integracao.test.ts`** exerce o ciclo completo: cadastrar → importar → aprender →
  segunda nota vir pronta → exportar → conferir a cadeia de auditoria.

**Rode `npm test` antes de qualquer deploy.** 144 testes. Se algum quebrar, o link está
quebrado — não prossiga.

Segredos: **nunca em arquivo**. `wrangler secret put` em produção, `.dev.vars` (ignorado
pelo git) em desenvolvimento. Inventário em `DEPLOY.md`.

---

## 5. Fase A — Arquitetura em três camadas

### Camada 1 — Arquitetura (os POPs)

O protocolo pede uma pasta `architecture/` com procedimentos em Markdown. **Aqui eles estão
distribuídos entre o plano no Projeto Claude e os comentários de cabeçalho de cada módulo** —
e isso é deliberado: um POP que mora longe do código apodrece; um que mora no topo do
arquivo é lido por quem vai mexer.

| Assunto | Onde está o POP |
|---|---|
| Decisões de infraestrutura, escopo, prazo, comercial | `claude/plano-infraestrutura.md` |
| Por que os impostos são registrados e não reescritos | cabeçalho de `src/rules/campos.ts` |
| Como a escada de regras decide | cabeçalho de `src/rules/engine.ts` |
| Por que o XML é editado cirurgicamente | cabeçalho de `src/nfe/serializer.ts` |
| Por que a auditoria mora no repositório | cabeçalho de `src/db/auditoria.ts` |
| Como as permissões são granuladas | cabeçalho de `src/auth/permissoes.ts` |

**A Regra de Ouro vale integralmente: se a lógica mudar, atualize o POP antes do código.**
Comentário de cabeçalho desatualizado é pior que ausência de comentário.

### Camada 2 — Navegação (decisão)

`src/index.ts`. Recebe, autentica, autoriza, valida a entrada com Zod, chama os módulos na
ordem certa e devolve. **Não contém regra de negócio.** Se você está escrevendo lógica
fiscal dentro de um handler, está na camada errada.

### Camada 3 — Ferramentas (execução determinística)

O protocolo pede scripts Python atômicos. Aqui são **módulos TypeScript puros** — mesma
propriedade: entrada previsível, saída previsível, testáveis isoladamente, sem estado
global.

| Módulo | Responsabilidade |
|---|---|
| `src/nfe/parser.ts` | lê NF-e 55, tolera prefixo de namespace, preserva zeros à esquerda |
| `src/nfe/serializer.ts` | gera o XML corrigido e verifica 12 invariantes |
| `src/nfe/importador.ts` | upload → parse → R2 → fornecedor → motor de regras |
| `src/rules/engine.ts` | a escada de 7 níveis: sugerir, aprender, confiança |
| `src/rules/campos.ts` | registro dos campos do template |
| `src/rules/alertas.ts` | 9 detectores de divergência e regras de destaque |
| `src/auth/senha.ts` | PBKDF2-SHA256 600k, comparação em tempo constante |
| `src/auth/permissoes.ts` | catálogo, papéis, recorte por empresa |
| `src/db/repo.ts` | **toda escrita passa por aqui** |
| `src/db/auditoria.ts` | trilha append-only com cadeia de hash |
| `src/empresas/cnae.ts` | CNAE → perfil → CFOP padrão |

**Não existe SQL de domínio fora de `src/db/repo.ts`.** É o que garante que nada seja
gravado sem passar pela auditoria e sem escopo de tenant.

---

## 6. Fase E — Estilo

- O protótipo `planee-fiscal-prototipo.html` é o **contrato de UX**. A estrutura de três
  ambientes foi validada com a cliente. Não redesenhar — o que muda está mapeado no §12 do
  plano.
- **A tela não decide o que é grave.** O servidor manda `estilo`, `alertas` e `resumo`
  prontos. Critério de gravidade num lugar só, testado.
- Cor nunca é a única pista: todo estado carrega ícone e rótulo em texto.
- Frontend sem framework e sem build. Uma dependência a menos é uma coisa a menos para
  quebrar no deploy.

Antes de implantar, mostre o resultado ao usuário para feedback.

---

## 7. Fase G — Gatilho

**Fase 1:** `npm run deploy` sobe tela e API juntas. Passo a passo em `DEPLOY.md`.
Não há cron nem webhook — a entrada é manual.

**Fase 2:** aí sim entram Cron Triggers horários despachando para um Durable Object por
CNPJ, dono exclusivo do ponteiro NSU. Ver §7 do plano.

Depois de implantar, atualize o Registro de alterações do plano.

---

## 8. As invariantes — isto é lei

Cada uma custou uma decisão. Nenhuma se rompe sem que este arquivo mude primeiro.

1. **O XML original nunca é alterado.** A assinatura do fornecedor seria invalidada. O
   corrigido é cópia de trabalho.
2. **O XML corrigido é gerado por edição cirúrgica no texto, não por reserialização.**
   Um `diff` entre os dois deve mostrar exatamente as linhas alteradas e nada mais.
3. **Registra, não reescreve.** Só `CFOP` e `xProd` vão para dentro do XML. CST de entrada,
   conta contábil e créditos são guardados e exportados à parte. Cada campo declara isso em
   `escreveNoXml`. Mudar isso é decisão fiscal, não decisão de programador.
4. **Exportação com invariante falhando é bloqueada.** Nota corrompida não sai.
5. **Regra recém-criada nasce amarela.** Ver uma vez não é saber. Verde exige nível
   específico *e* histórico de acerto. Regra genérica nunca chega ao verde.
6. **O nível 5 (padrão do fornecedor) não aprende sozinho.** Só por pedido explícito.
7. **Toda escrita de domínio passa pelo repositório**, que grava a trilha. Handler que
   escreve direto no banco é bug, não atalho.
8. **A trilha de auditoria é append-only**, com cadeia de hash. Nunca `UPDATE`, nunca
   `DELETE`.
9. **O campo `origem` da auditoria distingue** "o humano digitou" de "a regra sugeriu e o
   humano confirmou" de "a regra preencheu e ninguém olhou".
10. **Permissão exigida por um campo tem de existir no catálogo e ser concedida por algum
    papel.** Há teste garantindo.
11. **Toda consulta é escopada por tenant e pelo recorte de empresas do usuário.**
12. **Senha nunca em migração.** Migração vai para o repositório.

---

## 9. Loop de Reparo

Quando algo falha:

1. **Analisar** — leia o stack trace e a mensagem. Não adivinhe.
2. **Corrigir** — ajuste o módulo.
3. **Testar** — `npm test`. Escreva o teste que teria pegado o erro.
4. **Registrar o aprendizado** — atualize o comentário de cabeçalho do módulo e o
   Registro de alterações do plano, para o erro não voltar.

### Erros já encontrados, e o que ensinaram

*Seis dos sete só apareceram quando o sistema foi executado de verdade — não em teste
de função isolada. Rodar antes de entregar não é zelo, é o único jeito de achar esta
categoria de erro. E o quinto ensina que **rodar não basta: é preciso rodar pelo caminho
que o usuário vai usar.***

**Corrigir um item gravava o padrão do fornecedor inteiro.** Marcar um chocolate como
substituição tributária transformaria em ST tudo daquele atacadista. Corrigido: nível 5
só aprende por pedido explícito. **Lição:** erro de composição não aparece em teste de
função isolada — só quando duas notas passam pelo sistema em sequência. Por isso o teste
de integração existe e roda em todo `npm test`.

**O item que ninguém conhecia aparecia como "Pronto".** Na segunda nota de um
fornecedor, os itens que a contadora ainda não tinha ensinado vinham preenchidos pelo
chute do perfil e — por já não serem "produto novo" — chegavam sem alerta nenhum e com o
rótulo verde. O resumo do topo dizia "Tudo conferido". Era o pior erro possível numa tela
de conferência: o rótulo que faz o operador pular justamente a linha que ele deveria
olhar. **Lição:** um estado de UI derivado de duas variáveis erra na combinação que
ninguém pensou em testar. `estiloDaLinha` só tratava `media`; `nenhuma` caía no `else` e
virava "Pronto". Agora só `alta` ganha o verde, e o resumo conta como atenção todo item
sem conhecimento por trás.

**O `/api/saude` exigia autenticação.** O `DEPLOY.md` manda dar `curl` nele para conferir
se o serviço subiu, e ele respondia 401 — serviço no ar lido como serviço quebrado.
**Lição:** middleware que protege por prefixo pega rotas que não deviam ser protegidas.

**O `subir.cmd` travava numa pergunta que eu nunca vi.** O wrangler pergunta *"About to
apply 3 migration(s)... continue?"* e espera um `Y`. Executando pelo terminal aqui isso
nunca apareceu — sem TTY, o wrangler não pergunta. Apareceu no primeiro duplo-clique do
usuário, que é exatamente o caminho que escrevemos para ele usar. **Lição:** testar num
terminal sem TTY não é testar o caminho do usuário. Todo script destinado a duplo-clique
roda com `CI=true` para que ferramenta nenhuma pare esperando resposta.

**O login respondia "erro interno" e nada mais.** O `.dev.vars` está no `.gitignore` —
corretamente, é onde moram os segredos. Só que isso significa que **toda máquina que
clona o repositório começa sem ele**, e sem `SESSION_SECRET` o HMAC do cookie estoura
três camadas abaixo do `onError`, que traduz qualquer exceção para "erro interno". Uma
tela de login dizendo isso não dá a ninguém o que fazer em seguida. **Lição:** arquivo
de configuração que o `.gitignore` esconde é configuração que a próxima máquina não vai
ter — quem prepara o ambiente cria; e todo caminho que depende de configuração checa
antes e **diz o nome do que falta**, em vez de deixar a exceção virar 500 genérico.

**O campo de senha aparecia vazio — às vezes.** O bloco do modo local preenchia o
formulário assim que `/api/local` respondia; o boot, que roda em paralelo e cai em
`mostrarLogin()` quando não há sessão, limpava o campo. Quem chegasse primeiro decidia o
resultado, e nos meus dois primeiros testes ele foi diferente. **Lição:** duas rotinas
assíncronas escrevendo no mesmo campo é corrida, não bug intermitente — o conserto é uma
função só, chamada pelas duas, e não um `setTimeout`. Verificado rodando o carregamento
três vezes seguidas.

**O catálogo de permissões divergiu entre o TypeScript e o SQL.** Os campos de escrituração
exigiam `notas.editar_escrituracao`, que não existia no catálogo — a API teria bloqueado a
edição sem que papel nenhum pudesse liberar. **Lição:** a mesma informação em dois lugares
diverge em silêncio. `test/semente.test.ts` agora quebra o build se divergir.

---

## 10. Entregáveis e intermediários

| | Aqui |
|---|---|
| **Imutável — a fonte da verdade** | bucket `planee-xml-original`, com Object Lock de 5 anos |
| **Intermediário — descartável** | bucket `planee-xml-trabalho`, cópias de trabalho e exportações |
| **Payload — o destino final** | XML corrigido e CSV de escrituração, na mão da contadora |

O projeto só está concluído quando **uma competência inteira foi tratada e importada no
Questor com sucesso** — não quando o código compila.

---

## 11. Estrutura real

```
CLAUDE.md            este arquivo — a constituição
DEPLOY.md            passo a passo da publicação
README.md            visão geral do repositório
wrangler.jsonc       infraestrutura como código
migrations/          o esquema · fonte de verdade sobre formato
src/
  index.ts           camada 2 — navegação e decisão
  nfe/               camada 3 — parser, serializador, importador
  rules/             camada 3 — motor de regras, campos, alertas
  auth/              camada 3 — senha, permissões
  db/                camada 3 — repositório e auditoria
  empresas/          camada 3 — CNAE
  routes/            (reservado)
public/              camada de estilo — tela sem build
scripts/             utilitários operacionais (primeiro usuário)
test/                139 testes, incluindo integração contra SQLite real
```

Segredos ficam fora do repositório. `SEGREDOS.txt` e `.dev.vars` estão no `.gitignore`.

---

## 12. Referência rápida

| Passo | Pergunta-chave | Quando | Aqui |
|---|---|---|---|
| **V** | O que entra e o que sai? | antes de tudo | §2 — respondido |
| **L** | Os fios estão conectados? | antes do código | §4 — `npm test` |
| **A** | Quem faz o quê? | durante a construção | §5 — três camadas |
| **E** | Está bom para o cliente? | depois que funciona | §6 — protótipo é o contrato |
| **G** | Roda sozinho? | no final | §7 — `npm run deploy` |

---

## 13. Antes de encerrar qualquer sessão

- [ ] `npm test` passando
- [ ] `npm run typecheck` limpo
- [ ] Comentário de cabeçalho atualizado, se a lógica mudou
- [ ] Registro de alterações do plano atualizado
- [ ] Invariante nova? Então este arquivo também mudou
- [ ] Commit feito, com mensagem que explica **por quê**, não só o quê

---

*Constituição do projeto. Sobrepõe-se a preferência pessoal e a pressa.*
