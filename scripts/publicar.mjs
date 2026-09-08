#!/usr/bin/env node
/**
 * Publica o Planee Fiscal na Cloudflare, do zero, numa passada só.
 *
 *   node scripts/publicar.mjs
 *
 * É IDEMPOTENTE de propósito: cada passo confere se a coisa já existe antes de
 * criar. Se parar no meio (falta de cartão, internet, o que for), rodar de novo
 * continua de onde parou em vez de duplicar recurso.
 *
 * O que ele NÃO faz, e é intencional:
 *   - não ativa o Object Lock no bucket dos originais. Isso é irreversível por
 *     cinco anos; qualquer XML de teste que estiver lá fica lá. Vai a dedo, pelo
 *     painel, depois que os testes acabarem.
 *   - não apaga nada, nunca.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { webcrypto as crypto, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { lerSegredo, segredoPlausivel, acharIdBanco, trocarDatabaseId, contarUsuarios } from './partes.mjs';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const BANCO = 'planee-fiscal';
const BUCKETS = ['planee-xml-original', 'planee-xml-trabalho'];
const ITERACOES = 100_000;   // teto do runtime de Workers; ver src/auth/senha.ts

const cor = (c, t) => `\u001b[${c}m${t}\u001b[0m`;
const passo = (n, t) => console.log(cor(36, `\n[${n}] ${t}`));
const ok = (t) => console.log(cor(32, `    ✓ ${t}`));
const aviso = (t) => console.log(cor(33, `    ! ${t}`));

function parar(titulo, comoResolver) {
  console.error(cor(31, `\n✗ ${titulo}\n`));
  console.error(comoResolver.trim() + '\n');
  console.error('Nada do que já foi criado se perde. Rode este script de novo depois'
    + ' de resolver — ele continua de onde parou.\n');
  process.exit(1);
}

/** Roda o wrangler. `mudo: true` captura a saída em vez de despejar na tela. */
function wr(args, { mudo = false, input = undefined, tolerar = false, interativo = false } = {}) {
  // Interativo: o wrangler herda o terminal e PODE perguntar. Existe por causa
  // do deploy: sem subdominio workers.dev registrado ele pergunta se quer criar
  // um agora, e o CI=true respondia "no" — deixando o Worker publicado mas sem
  // endereco nenhum. Automatizar demais tambem quebra.
  const r = spawnSync('npx', ['wrangler', ...args], {
    cwd: raiz, shell: true, input: interativo ? undefined : input,
    stdio: interativo ? 'inherit' : (mudo ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'inherit', 'inherit']),
    // CI=true: nada de prompt esperando um Y.
    // NODE_NO_WARNINGS: o aviso DEP0190 do Node se enfileirava na MESMA linha da
    // pergunta do e-mail, e a tela ficava com cara de erro bem na hora em que o
    // usuario precisava digitar. Ruido que aparece no pior momento nao e ruido.
    env: interativo
      ? { ...process.env, NODE_NO_WARNINGS: '1' }
      : { ...process.env, CI: 'true', NODE_NO_WARNINGS: '1' },
    encoding: 'utf8',
  });
  const saida = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0 && !tolerar) return { ok: false, saida };
  return { ok: r.status === 0, saida };
}

function perguntar(texto, escondido = false) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (!escondido) return rl.question(texto, (v) => { rl.close(); resolve(v.trim()); });
    // Senha: eco desligado à mão, porque o readline não faz isso sozinho.
    const escrever = rl._writeToOutput.bind(rl);
    rl._writeToOutput = function (s) { if (s.includes(texto)) escrever(s); else escrever('*'); };
    rl.question(texto, (v) => { rl.close(); console.log(); resolve(v.trim()); });
  });
}

// ============================================================ 1. quem é você
passo(1, 'Conferindo o login na Cloudflare');
let quem = wr(['whoami'], { mudo: true });
if (!quem.ok || /not authenticated|não autenticado/i.test(quem.saida)) {
  aviso('não está logado — abrindo o navegador para autorizar');
  const login = wr(['login']);
  if (!login.ok) {
    parar('Não foi possível entrar na Cloudflare.', `
Rode à mão e autorize no navegador:

    npx wrangler login`);
  }
  quem = wr(['whoami'], { mudo: true });
}
const conta = (quem.saida.match(/([^\s│|]+@[^\s│|]+)/) || [])[1]
  || (quem.saida.match(/Account Name[^\n]*?([A-Za-z0-9][^\n│|]*)/) || [])[1];
ok(`autenticado${conta ? ` como ${conta.trim()}` : ''}`);

// ============================================================ 2. banco
passo(2, `Banco de dados D1 "${BANCO}"`);
function idDoBanco() {
  const lista = wr(['d1', 'list', '--json'], { mudo: true, tolerar: true });
  return acharIdBanco(lista.saida, BANCO);
}

let idBanco = idDoBanco();
if (idBanco) {
  ok(`já existe (${idBanco})`);
} else {
  const criou = wr(['d1', 'create', BANCO], { mudo: true });
  idBanco = idDoBanco();
  if (!idBanco) {
    parar('Não consegui criar o banco D1.', `Saída do wrangler:\n\n${criou.saida}`);
  }
  ok(`criado (${idBanco})`);
}

// grava o id no wrangler.jsonc — é o passo que todo mundo esquece de fazer à mão
const caminhoConf = join(raiz, 'wrangler.jsonc');
const conf = readFileSync(caminhoConf, 'utf8');
if (conf.includes(idBanco)) {
  ok('wrangler.jsonc já aponta para esse banco');
} else {
  const novo = trocarDatabaseId(conf, idBanco);
  if (!novo) parar('Não achei o campo database_id no wrangler.jsonc.', 'Edite à mão.');
  writeFileSync(caminhoConf, novo, 'utf8');
  ok('wrangler.jsonc atualizado com o id do banco');
}

// ============================================================ 3. buckets
passo(3, 'Buckets R2 para os XML');
const listaB = wr(['r2', 'bucket', 'list'], { mudo: true, tolerar: true });
for (const b of BUCKETS) {
  if (listaB.saida.includes(b)) { ok(`${b} já existe`); continue; }
  const r = wr(['r2', 'bucket', 'create', b], { mudo: true, tolerar: true });
  if (r.ok || /already (exists|owned)/i.test(r.saida)) { ok(`${b} criado`); continue; }

  if (/10042|enable r2|payment|billing|subscri|cart[ãa]o|10000|not entitled/i.test(r.saida)) {
    parar('O R2 ainda não está ligado nesta conta.', `
Ter cartão cadastrado não basta: o R2 precisa ser ATIVADO uma vez, no painel.
É um botão. Continua no plano gratuito — 10 GB e o volume deste projeto cabem
folgados no grátis.

Como resolver, leva 1 minuto:
  1. Abra  https://dash.cloudflare.com/
  2. Menu da esquerda  →  "R2 Object Storage"
  3. Clique em  "Purchase R2 Plan"  /  "Enable R2"  e confirme
  4. Feche e dê dois cliques no publicar.cmd de novo

Por que não dá para pular: o XML assinado do fornecedor precisa ficar num
lugar imutável — é a cláusula 5.5.3 do contrato (guarda por 5 anos). O Object
Lock do R2 é o que garante que nem administrador apaga. Sem isso, a obrigação
vira promessa.

Enquanto o cartão não entra, o sistema roda inteiro na sua máquina pelo
subir.cmd — inclusive com notas reais.

Saída do wrangler:
${r.saida.trim()}`);
  }
  parar(`Falhou ao criar o bucket ${b}.`, `Saída do wrangler:\n\n${r.saida}`);
}

// ============================================================ 4. tabelas
passo(4, 'Criando as tabelas no banco de produção');
const mig = wr(['d1', 'migrations', 'apply', BANCO, '--remote']);
if (!mig.ok) parar('As migrações não aplicaram.', 'Veja a mensagem acima.');
ok('migrações aplicadas');

// ============================================================ 5. segredos
passo(5, 'Guardando os segredos');
const caminhoSeg = join(raiz, 'SEGREDOS.txt');
if (!existsSync(caminhoSeg)) {
  aviso('SEGREDOS.txt não está aqui — se os segredos já foram cadastrados, tudo bem');
} else {
  const texto = readFileSync(caminhoSeg, 'utf8');
  for (const nome of ['SESSION_SECRET', 'AUDIT_SEED']) {
    const valor = lerSegredo(texto, nome);
    if (!valor) { aviso(`não achei ${nome} no SEGREDOS.txt — cadastre à mão`); continue; }
    // Segunda rede: valor curto ou com cara de comando não entra em produção.
    if (!segredoPlausivel(valor)) {
      parar(`O valor lido para ${nome} não parece um segredo: "${valor}"`, `
No SEGREDOS.txt o nome deve estar sozinho numa linha e o valor na linha logo
abaixo. Ou cadastre à mão:

    npx wrangler secret put ${nome}`);
    }
    const r = wr(['secret', 'put', nome], { mudo: true, input: `${valor}\n` });
    if (!r.ok) parar(`Não consegui gravar o segredo ${nome}.`, r.saida);
    ok(`${nome} gravado`);
  }
  console.log(cor(33, '\n    O AUDIT_SEED é o primeiro elo da cadeia de hash da auditoria.'));
  console.log(cor(33, '    Depois que houver registros, trocá-lo invalida a verificação de tudo.'));
}

// ============================================================ 6. usuário
passo(6, 'Primeiro usuário administrador');
const jaTem = wr(
  ['d1', 'execute', BANCO, '--remote', '--json',
    '--command', '"SELECT COUNT(*) AS n FROM usuarios"'],
  { mudo: true, tolerar: true },
);
// Sem --json o wrangler desenha uma tabela em ASCII e o número nunca casava:
// o script concluía "zero usuários" e tentava criar um admin que já existe,
// estourando o UNIQUE do e-mail no meio da publicação.
const achou = contarUsuarios(jaTem.saida);
if (achou === null) {
  parar('Não consegui contar os usuários do banco de produção.', `
Sem essa contagem eu não sei se devo criar o primeiro administrador ou se ele
já existe — e criar duas vezes estoura no meio da publicação.

Confira à mão:

    npx wrangler d1 execute ${BANCO} --remote --command "SELECT email FROM usuarios"

Saída que recebi:
${jaTem.saida.trim()}`);
}
const quantos = achou;

if (quantos > 0) {
  ok(`já existe ${quantos} usuário(s) — nada a fazer`);
} else {
  const email = (process.argv[2] || await perguntar('    E-mail do administrador: ')).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) parar('E-mail inválido.', 'Rode de novo.');

  let senha = process.argv[3] || '';
  while (senha.length < 12) {
    senha = await perguntar('    Senha (mínimo 12 caracteres, frase longa vale mais): ', true);
    if (senha.length < 12) aviso('curta demais');
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const chave = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(senha.normalize('NFKC')), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERACOES, hash: 'SHA-256' }, chave, 256,
  );
  const b64 = (b) => Buffer.from(b).toString('base64');
  const hash = `pbkdf2$${ITERACOES}$${b64(salt)}$${b64(new Uint8Array(bits))}`;
  const id = randomUUID();
  const nome = email.split('@')[0].replace(/[._-]/g, ' ');

  /*
   * `--command`, nunca `--file`.
   *
   * O `--file` usa a API de IMPORTAÇÃO do D1 (/d1/database/<id>/import), que é
   * outro endpoint com outra exigência de permissão: com o token do
   * `wrangler login` ela devolve "Authentication error [code: 10000]". A API de
   * consulta, que o `--command` usa, funciona com o mesmo login. Adotamos o
   * `--file` para fugir do inferno de aspas do cmd e trocamos um problema
   * cosmético por um que impedia gravar.
   *
   * O `$` do hash precisa ser escapado fora do Windows: com shell:true o `sh`
   * expandiria `$600000` para nada e o hash chegaria mutilado ao banco.
   */
  const paraShell = (t) => (process.platform === 'win32' ? t : t.replace(/([$`\\])/g, '\\$1'));
  const inserirUsuario = `INSERT INTO usuarios (id, tenant_id, email, nome, senha_hash, ativo, criado_em) `
    + `VALUES ('${id}', 'alfa', '${email}', '${nome}', '${hash}', 1, '${new Date().toISOString()}')`;
  const inserirPapel = `INSERT INTO usuario_papeis (usuario_id, papel_id) VALUES ('${id}', 'papel-admin')`;

  for (const comando of [inserirUsuario, inserirPapel]) {
    const r = wr(['d1', 'execute', BANCO, '--remote', '--json', '--command', `"${paraShell(comando)}"`],
      { mudo: true });
    if (!r.ok) parar('Não consegui criar o usuário.', r.saida);
  }

  // Provar, não supor: relê o banco e confere que o usuário está lá com papel.
  const conferir = wr(['d1', 'execute', BANCO, '--remote', '--json', '--command',
    `"SELECT COUNT(*) AS n FROM usuario_papeis WHERE usuario_id = '${id}'"`], { mudo: true });
  if (!/"n":\s*1/.test(conferir.saida)) {
    parar('Criei o usuário mas não consegui confirmar o papel dele.', conferir.saida);
  }

  ok(`${email} criado como Admin — o hash foi calculado aqui, a senha não viajou`);
}

// ============================================================ 7. publicar
passo(7, 'Publicando');
console.log('    Se ele perguntar sobre um subdominio workers.dev, responda SIM.');
console.log('    O nome que voce escolher vira o endereco: planee-fiscal.<nome>.workers.dev\n');
const dep = wr(['deploy'], { interativo: true });
if (!dep.ok) {
  parar('O deploy falhou.', `
Leia a mensagem do wrangler acima.

Se ele reclamou de subdominio workers.dev, registre um aqui e rode de novo:

    https://dash.cloudflare.com/workers/onboarding`);
}
const url = null;   // saida foi direto para o terminal; a URL esta impressa acima
ok('publicado');

console.log(`
${cor(32, '=========================================================')}
  ${cor(32, 'No ar.')}

  ${url ? cor(36, url) : cor(36, 'A URL está impressa acima — a linha que termina em workers.dev')}

  Abra ela no navegador e entre com o usuário que você criou.

  Para conferir o serviço, acrescente /api/saude no fim do endereço:
  deve responder      {"ok":true,"ambiente":"producao"}

  ${cor(33, 'Falta uma coisa, e é a dedo:')}
  Depois que os testes acabarem, ative o Object Lock no bucket
  planee-xml-original — painel → R2 → Settings → Object Lock,
  modo Compliance, retenção 5 anos. É o que sustenta a cláusula
  5.5.3 do contrato. NÃO ative antes de testar: qualquer arquivo
  de teste fica lá pelos próximos cinco anos.
${cor(32, '=========================================================')}
`);
