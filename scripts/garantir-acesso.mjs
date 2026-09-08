#!/usr/bin/env node
/**
 * Garante que existe um administrador com a senha informada — e prova que entra.
 *
 *   node scripts/garantir-acesso.mjs email@x.com "a senha"            (produção)
 *   node scripts/garantir-acesso.mjs email@x.com "a senha" --local    (banco local)
 *
 * Se o usuário não existir, cria. Se existir, regrava a senha. Nos dois casos
 * relê o banco e confere se aquela senha realmente entra.
 *
 * TUDO passa por `--command`, nunca por `--file`.
 *
 * O `--file` do wrangler usa a API de IMPORTAÇÃO do D1
 * (/d1/database/<id>/import), que é outro endpoint com outra exigência de
 * permissão — e o token OAuth do `wrangler login` recebe dela um
 * "Authentication error [code: 10000]". O `--command` usa a API de consulta e
 * funciona com o mesmo login. Adotamos o `--file` para fugir do inferno de
 * aspas do cmd do Windows e trocamos um problema cosmético por um que impedia
 * gravar. O SQL daqui só contém base64 e hexadecimal, sem `&`, `|`, `<`, `>`
 * ou `^`, então uma linha entre aspas atravessa o cmd sem sustos.
 */
import { spawnSync } from 'node:child_process';
import { webcrypto as crypto, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const ITERACOES = 100_000;   // teto do runtime de Workers; ver src/auth/senha.ts
const args = process.argv.slice(2);
const local = args.includes('--local');
const livres = args.filter((a) => !a.startsWith('--'));
const email = (livres[0] || '').trim().toLowerCase();
const senha = livres[1] || '';

if (!email || !senha) {
  console.error('uso: node scripts/garantir-acesso.mjs <email> "<senha>" [--local]');
  process.exit(1);
}
if (senha.length < 12) {
  console.error(`erro: "${senha}" tem ${senha.length} caracteres; o mínimo é 12.`);
  process.exit(1);
}

const escapar = (t) => String(t).replace(/'/g, "''");

/**
 * O hash tem a forma `pbkdf2$600000$<salt>$<hash>`, e o `$` é veneno.
 *
 * Como rodamos com `shell: true` (o npx do Windows exige), no Linux e no Mac o
 * `sh` expande `$600000` para nada dentro de aspas duplas — o hash chega
 * mutilado ao banco e a senha nunca mais confere. No cmd do Windows o `$` é
 * literal, então o mesmo código funciona lá e quebra aqui: bug que só aparece
 * num dos dois lados. Escapar `$`, crase e barra invertida resolve para os dois.
 */
const paraShell = (t) => (process.platform === 'win32' ? t : t.replace(/([$`\\])/g, '\\$1'));

function consultar(comando, { tolerar = false } = {}) {
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'planee-fiscal',
    local ? '--local' : '--remote', '--json', '--command', `"${paraShell(comando)}"`], {
    cwd: raiz, shell: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CI: 'true', NODE_NO_WARNINGS: '1' }, encoding: 'utf8',
  });
  const bruto = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // O wrangler imprime banner e "[WARNING] out-of-date" antes do JSON, e esse
  // aviso tem um '[' que não abre o array. Tentamos cada colchete.
  for (let i = bruto.indexOf('['); i >= 0; i = bruto.indexOf('[', i + 1)) {
    try {
      const j = JSON.parse(bruto.slice(i));
      if (Array.isArray(j) && j[0] && Array.isArray(j[0].results)) return j[0];
    } catch { /* próximo */ }
  }
  if (tolerar) return null;
  console.error(`\n✗ O banco não respondeu como esperado.\n\n${bruto.trim()}`);
  process.exit(1);
}

async function hashDe(s, salt = crypto.getRandomValues(new Uint8Array(16)), iter = ITERACOES) {
  const k = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(s.normalize('NFKC')), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, k, 256,
  );
  return { salt, iter, digest: Buffer.from(bits).toString('base64') };
}

console.log(`\nBanco: ${local ? 'LOCAL' : 'PRODUÇÃO'}`);
console.log(`E-mail: ${email}`);
console.log(`Senha:  "${senha}"  (${senha.length} caracteres)\n`);

// ---------------------------------------------------------------- 1. quem existe
const todos = consultar('SELECT email, ativo FROM usuarios');
console.log(`Usuários no banco: ${todos.results.length}`);
for (const u of todos.results) {
  console.log(`  - ${u.email}${u.ativo === 1 ? '' : '  (INATIVO)'}`);
}

const existe = todos.results.some((u) => String(u.email).toLowerCase() === email);

// ---------------------------------------------------------------- 2. gravar
const { salt, iter, digest } = await hashDe(senha);
const hash = `pbkdf2$${iter}$${Buffer.from(salt).toString('base64')}$${digest}`;
const agora = new Date().toISOString();

if (existe) {
  console.log('\n> usuário existe — regravando a senha');
  consultar(
    `UPDATE usuarios SET senha_hash = '${hash}', ativo = 1, deve_trocar_senha = 0, `
    + `tentativas_falhas = 0, bloqueado_ate = NULL WHERE email = '${escapar(email)}'`,
  );
} else {
  console.log('\n> usuário NÃO existe — criando como Admin');
  const id = randomUUID();
  const nome = email.split('@')[0].replace(/[._-]/g, ' ');
  consultar(
    `INSERT INTO usuarios (id, tenant_id, email, nome, senha_hash, ativo, criado_em) `
    + `VALUES ('${id}', 'alfa', '${escapar(email)}', '${escapar(nome)}', '${hash}', 1, '${agora}')`,
  );
  consultar(`INSERT INTO usuario_papeis (usuario_id, papel_id) VALUES ('${id}', 'papel-admin')`);
}

// ---------------------------------------------------------------- 3. provar
// "Gravou sem erro" não é "a senha entra". Relemos e refazemos a derivação.
const conf = consultar(
  `SELECT senha_hash, ativo, tentativas_falhas FROM usuarios WHERE email = '${escapar(email)}'`,
);
const linha = conf.results[0];
if (!linha) {
  console.error('\n✗ Gravei e o usuário não está lá. Algo muito errado — me mande esta saída.');
  process.exit(1);
}

const [, it2, salt2, hash2] = String(linha.senha_hash).split('$');
const refeito = await hashDe(senha, Buffer.from(salt2, 'base64'), Number(it2));
const bate = refeito.digest === hash2;

const papeis = consultar(
  `SELECT COUNT(*) AS n FROM usuario_papeis up JOIN usuarios u ON u.id = up.usuario_id `
  + `WHERE u.email = '${escapar(email)}'`,
);

console.log('\n=========================================================');
console.log(`  senha entra:   ${bate ? '✓ SIM' : '✗ NÃO — algo escreveu por cima'}`);
console.log(`  conta ativa:   ${linha.ativo === 1 ? '✓ sim' : '✗ NÃO — login recusa mesmo com senha certa'}`);
console.log(`  tentativas:    ${linha.tentativas_falhas}`);
console.log(`  papéis:        ${papeis.results[0].n}${papeis.results[0].n === 0 ? '  ✗ sem papel — entra e não vê nada' : ''}`);
console.log('=========================================================\n');

if (bate && linha.ativo === 1 && papeis.results[0].n > 0) {
  console.log('  Pode entrar. Se o site ainda recusar, o problema não é a conta.\n');
} else {
  process.exitCode = 1;
}
