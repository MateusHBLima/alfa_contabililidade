#!/usr/bin/env node
/**
 * Mostra o que está REALMENTE gravado, byte a byte, e reproduz a conferência
 * do servidor exatamente como ela acontece lá dentro.
 *
 *   node scripts/dump-usuario.mjs email@x.com "a senha" [--local]
 *
 * Existe porque o banco diz que a senha bate e o site devolve 401. Uma das duas
 * afirmações é falsa, e a diferença provável está no decodificador de base64:
 * o Worker usa `atob`, que recusa qualquer caractere fora do alfabeto; este
 * script até agora usava `Buffer.from(..., 'base64')`, que ignora lixo em
 * silêncio. Um caractere perdido no caminho passaria despercebido de um lado e
 * derrubaria o login do outro.
 */
import { spawnSync } from 'node:child_process';
import { webcrypto as crypto } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const local = args.includes('--local');
const livres = args.filter((a) => !a.startsWith('--'));
const email = (livres[0] || '').trim().toLowerCase();
const senha = livres[1] || '';
if (!email || !senha) {
  console.error('uso: node scripts/dump-usuario.mjs <email> "<senha>" [--local]');
  process.exit(1);
}

const paraShell = (t) => (process.platform === 'win32' ? t : t.replace(/([$`\\])/g, '\\$1'));

function consultar(comando) {
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'planee-fiscal',
    local ? '--local' : '--remote', '--json', '--command', `"${paraShell(comando)}"`], {
    cwd: raiz, shell: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CI: 'true', NODE_NO_WARNINGS: '1' }, encoding: 'utf8',
  });
  const bruto = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  for (let i = bruto.indexOf('['); i >= 0; i = bruto.indexOf('[', i + 1)) {
    try {
      const j = JSON.parse(bruto.slice(i));
      if (Array.isArray(j) && j[0] && Array.isArray(j[0].results)) return j[0].results;
    } catch { /* próximo */ }
  }
  console.error(`\n✗ O banco não respondeu.\n\n${bruto.trim()}`);
  process.exit(1);
}

const linhas = consultar(
  `SELECT email, ativo, tenant_id, senha_hash FROM usuarios WHERE lower(email) = '${email}'`,
);

console.log(`\nBanco: ${local ? 'LOCAL' : 'PRODUÇÃO'}`);
console.log(`Linhas encontradas com esse e-mail: ${linhas.length}\n`);
if (linhas.length === 0) process.exit(1);

for (const u of linhas) {
  // JSON.stringify revela espaço no fim, maiúscula, caractere invisível.
  console.log(`  email:     ${JSON.stringify(u.email)}   (${String(u.email).length} chars)`);
  console.log(`  bate exato com o que o login procura: `
    + `${u.email === email ? 'SIM' : 'NÃO  <<< é a causa do 401'}`);
  console.log(`  ativo:     ${JSON.stringify(u.ativo)}`);
  console.log(`  tenant_id: ${JSON.stringify(u.tenant_id)}`);

  const h = String(u.senha_hash);
  const partes = h.split('$');
  console.log(`  hash:      ${h.length} chars, ${partes.length} partes`);
  partes.forEach((p, i) => {
    const rotulo = ['algoritmo', 'iterações', 'salt', 'digest'][i] ?? `parte ${i}`;
    console.log(`      ${rotulo}: ${JSON.stringify(p.length > 20 ? p.slice(0, 20) + '…' : p)}`
      + ` (${p.length} chars)`);
  });

  // --- exatamente o que o servidor faz -------------------------------------
  console.log('\n  --- reproduzindo a conferência do servidor (atob, rigoroso) ---');
  let veredito;
  try {
    if (partes.length !== 4 || partes[0] !== 'pbkdf2') throw new Error('formato do hash inesperado');
    const iteracoes = Number(partes[1]);
    if (!Number.isFinite(iteracoes) || iteracoes < 1000) throw new Error(`iterações inválidas: ${partes[1]}`);
    const deB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const salt = deB64(partes[2]);
    const esperado = deB64(partes[3]);
    const k = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(senha.normalize('NFKC')), 'PBKDF2', false, ['deriveBits'],
    );
    const bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: iteracoes, hash: 'SHA-256' }, k, 256,
    ));
    if (bits.length !== esperado.length) throw new Error(`tamanhos diferentes: ${bits.length} vs ${esperado.length}`);
    let d = 0;
    for (let i = 0; i < bits.length; i++) d |= bits[i] ^ esperado[i];
    veredito = d === 0 ? 'ACEITA' : 'RECUSA (o digest não bate)';
  } catch (e) {
    veredito = `RECUSA por exceção: ${e.message}`;
  }
  console.log(`  servidor:  ${veredito}`);

  // --- o jeito tolerante, que eu vinha usando ------------------------------
  try {
    const [, it, s2, h2] = partes;
    const k2 = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(senha.normalize('NFKC')), 'PBKDF2', false, ['deriveBits'],
    );
    const b2 = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: Buffer.from(s2, 'base64'), iterations: Number(it), hash: 'SHA-256' }, k2, 256,
    );
    console.log(`  Buffer:    ${Buffer.from(b2).toString('base64') === h2 ? 'ACEITA' : 'RECUSA'}`);
  } catch (e) {
    console.log(`  Buffer:    erro: ${e.message}`);
  }
  console.log();
}
