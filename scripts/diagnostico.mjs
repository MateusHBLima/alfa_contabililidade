#!/usr/bin/env node
/**
 * Diz por que o login está sendo recusado — sem adivinhação.
 *
 *   node scripts/diagnostico.mjs                      (produção)
 *   node scripts/diagnostico.mjs --local              (banco local)
 *   node scripts/diagnostico.mjs email@x.com senha    (testa direto)
 *
 * Faz três coisas que a tela não consegue fazer:
 *   1. lista os usuários que existem de verdade no banco, com o estado de cada um;
 *   2. testa uma senha contra o hash guardado, aqui na máquina;
 *   3. mostra a senha em texto na tela — de propósito. Todo este problema nasceu
 *      de digitar senha às cegas, com asterisco. Aqui você VÊ o que está testando.
 */
import { spawnSync } from 'node:child_process';
import { webcrypto as crypto } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const local = args.includes('--local');
const livres = args.filter((a) => !a.startsWith('--'));

function sql(comando) {
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'planee-fiscal',
    local ? '--local' : '--remote', '--json', '--command', `"${comando}"`], {
    cwd: raiz, shell: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CI: 'true', NODE_NO_WARNINGS: '1' }, encoding: 'utf8',
  });
  const saida = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // O wrangler imprime banner e aviso antes do JSON; procuramos o array de verdade.
  for (let i = saida.indexOf('['); i >= 0; i = saida.indexOf('[', i + 1)) {
    try {
      const j = JSON.parse(saida.slice(i));
      if (Array.isArray(j) && j[0] && Array.isArray(j[0].results)) return j[0].results;
    } catch { /* tenta o proximo */ }
  }
  console.error(`\n✗ Não consegui consultar o banco.\n\n${saida}`);
  process.exit(1);
}

const pergunta = (t) => new Promise((r) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question(t, (v) => { rl.close(); r(v); });
});

console.log(`\n=== Usuários no banco ${local ? 'LOCAL' : 'de PRODUÇÃO'} ===\n`);
const usuarios = sql(
  'SELECT email, nome, ativo, tentativas_falhas, bloqueado_ate, length(senha_hash) AS tam FROM usuarios',
);
if (usuarios.length === 0) {
  console.log('  NENHUM usuário cadastrado. É por isso que o login recusa.');
  process.exit(0);
}
for (const u of usuarios) {
  const travado = u.bloqueado_ate && new Date(u.bloqueado_ate) > new Date();
  console.log(`  ${u.email}`);
  console.log(`      ativo: ${u.ativo === 1 ? 'sim' : 'NÃO — login recusa'}`
    + ` | tentativas falhas: ${u.tentativas_falhas}`
    + ` | bloqueado: ${travado ? `SIM até ${u.bloqueado_ate}` : 'não'}`
    + ` | hash: ${u.tam} chars`);
}

console.log('\n=== Testar uma senha contra o hash guardado ===');
console.log('    (a senha aparece na tela de propósito — é para você VER o que está testando)\n');

const email = (livres[0] || await pergunta('  E-mail: ')).trim().toLowerCase();
const senha = livres[1] || await pergunta('  Senha (aparece na tela): ');

const linha = sql(`SELECT senha_hash FROM usuarios WHERE email = '${email.replace(/'/g, "''")}'`);
if (linha.length === 0) {
  console.log(`\n  ✗ Não existe usuário com o e-mail "${email}".`);
  console.log('    Compare com a lista acima — provavelmente é aí que está o problema.');
  process.exit(0);
}

const [, iteracoes, saltB64, hashB64] = linha[0].senha_hash.split('$');
const salt = Buffer.from(saltB64, 'base64');
const chave = await crypto.subtle.importKey(
  'raw', new TextEncoder().encode(senha.normalize('NFKC')), 'PBKDF2', false, ['deriveBits'],
);
const bits = await crypto.subtle.deriveBits(
  { name: 'PBKDF2', salt, iterations: Number(iteracoes), hash: 'SHA-256' }, chave, 256,
);
const bate = Buffer.from(bits).toString('base64') === hashB64;

console.log(`\n  Senha testada: "${senha}"  (${senha.length} caracteres)`);
console.log(bate
  ? '\n  ✓ ESSA SENHA ESTÁ CERTA. Se o site recusa, o problema não é a senha.'
  : '\n  ✗ Essa senha NÃO é a que está no banco.\n'
    + '    Rode o TROCAR-SENHA e defina outra — ou passe a senha como argumento,\n'
    + '    para não digitar às cegas:\n\n'
    + `        node scripts/trocar-senha.mjs ${email}`);
console.log();
