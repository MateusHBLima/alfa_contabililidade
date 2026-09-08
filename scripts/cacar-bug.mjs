#!/usr/bin/env node
/**
 * Descobre POR QUE o servidor recusa uma senha que o banco confirma.
 *
 *   node scripts/cacar-bug.mjs email@x.com "a senha"
 *
 * A ideia: o handler de login tem dois caminhos para o 401, e eles se
 * distinguem por um efeito colateral.
 *
 *   - usuário NÃO encontrado  -> devolve 401 e NÃO mexe em tentativas_falhas
 *   - senha não confere       -> devolve 401 e INCREMENTA tentativas_falhas
 *
 * Então: lemos o contador, tentamos entrar, lemos de novo. Se o número subiu,
 * o Worker achou o usuário e recusou a senha. Se não subiu, o Worker não achou
 * o usuário — e como a linha existe no banco que consultamos, ele está lendo
 * OUTRO banco. Uma pergunta que nenhuma quantidade de palpite responde.
 */
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.PLANEE_URL || 'https://planee-fiscal.planee.workers.dev';
const [email, senha] = process.argv.slice(2);
if (!email || !senha) {
  console.error('uso: node scripts/cacar-bug.mjs <email> "<senha>"');
  process.exit(1);
}

const paraShell = (t) => (process.platform === 'win32' ? t : t.replace(/([$`\\])/g, '\\$1'));

function wrangler(args) {
  const r = spawnSync('npx', ['wrangler', ...args], {
    cwd: raiz, shell: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CI: 'true', NODE_NO_WARNINGS: '1' }, encoding: 'utf8',
  });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

function consultar(comando) {
  const bruto = wrangler(['d1', 'execute', 'planee-fiscal', '--remote', '--json',
    '--command', `"${paraShell(comando)}"`]);
  for (let i = bruto.indexOf('['); i >= 0; i = bruto.indexOf('[', i + 1)) {
    try {
      const j = JSON.parse(bruto.slice(i));
      if (Array.isArray(j) && j[0] && Array.isArray(j[0].results)) return j[0].results;
    } catch { /* próximo */ }
  }
  console.error(`\n✗ O banco não respondeu.\n\n${bruto.trim()}`);
  process.exit(1);
}

// ---------------------------------------------------------- 1. quantos bancos existem?
console.log('\n=== Bancos D1 nesta conta ===');
const lista = wrangler(['d1', 'list', '--json']);
let bancos = [];
for (let i = lista.indexOf('['); i >= 0; i = lista.indexOf('[', i + 1)) {
  try {
    const j = JSON.parse(lista.slice(i));
    if (Array.isArray(j) && j.every((b) => b && b.name)) { bancos = j; break; }
  } catch { /* próximo */ }
}
for (const b of bancos) console.log(`  ${b.name}  ${b.uuid}`);
const homonimos = bancos.filter((b) => b.name === 'planee-fiscal');
if (homonimos.length > 1) {
  console.log(`\n  !!! ${homonimos.length} bancos com o MESMO NOME. É a causa: o Worker`);
  console.log('      usa o id do wrangler.jsonc e os comandos resolvem pelo nome.');
}

// ---------------------------------------------------------- 2. para onde o Worker aponta
const { readFileSync } = await import('node:fs');
const conf = readFileSync(join(raiz, 'wrangler.jsonc'), 'utf8');
const idConf = (conf.match(/"database_id":\s*"([^"]*)"/) || [])[1];
console.log(`\n  wrangler.jsonc aponta para: ${idConf}`);

// ---------------------------------------------------------- 3. o contador, antes
// Zeramos primeiro: cinco falhas travam a conta por 15 minutos, e seria
// constrangedor o diagnóstico ser a gota que bloqueia o acesso.
consultar(
  `UPDATE usuarios SET tentativas_falhas = 0, bloqueado_ate = NULL WHERE email = '${email}'`,
);
const antes = consultar(
  `SELECT id, tentativas_falhas, ultimo_login FROM usuarios WHERE email = '${email}'`,
)[0];
if (!antes) { console.error(`\n✗ Nenhum usuário com ${email}.`); process.exit(1); }
console.log(`\n=== Antes da tentativa ===`);
console.log(`  tentativas_falhas: ${antes.tentativas_falhas}`);
console.log(`  ultimo_login:      ${antes.ultimo_login ?? '(nunca)'}`);

// ---------------------------------------------------------- 4. tentar entrar
console.log(`\n=== Tentando entrar em ${BASE} ===`);
let status = 0; let corpo = '';
try {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, senha }),
  });
  status = r.status; corpo = (await r.text()).slice(0, 200);
} catch (e) {
  console.error(`  não consegui falar com o site: ${e.message}`);
  process.exit(1);
}
console.log(`  status: ${status}`);
console.log(`  corpo:  ${corpo}`);

// ---------------------------------------------------------- 5. o contador, depois
await new Promise((r) => setTimeout(r, 1500));
const depois = consultar(
  `SELECT tentativas_falhas, ultimo_login FROM usuarios WHERE email = '${email}'`,
)[0];
console.log(`\n=== Depois da tentativa ===`);
console.log(`  tentativas_falhas: ${depois.tentativas_falhas}`);
console.log(`  ultimo_login:      ${depois.ultimo_login ?? '(nunca)'}`);

// ---------------------------------------------------------- 6. veredito
console.log('\n=========================================================');
if (status === 200) {
  console.log('  ✓ Entrou. O problema estava no navegador.');
} else if (depois.tentativas_falhas > antes.tentativas_falhas) {
  console.log('  O Worker ACHOU o usuário e recusou a senha.');
  console.log('  (o contador de falhas subiu — é o mesmo banco)');
  console.log('');
  console.log('  Então o conferirSenha está devolvendo false para uma senha que');
  console.log('  bate. Bug no servidor. Me mande esta saída.');
} else {
  console.log('  O Worker NÃO achou o usuário — o contador não subiu.');
  console.log('');
  console.log('  Mas a linha existe no banco que estes comandos consultam.');
  console.log('  Ou seja: o Worker publicado está lendo OUTRO banco de dados.');
  console.log('  Me mande esta saída, com a lista de bancos lá em cima.');
}
console.log('=========================================================\n');
