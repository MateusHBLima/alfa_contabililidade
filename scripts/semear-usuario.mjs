#!/usr/bin/env node
/**
 * Gera o SQL do primeiro usuário administrador.
 *
 * Senha não entra em migração — migração vai para o repositório, e senha em repositório
 * é senha vazada. Este script calcula o hash na sua máquina e imprime o INSERT.
 *
 *   node scripts/semear-usuario.mjs contadora@alfacontabil.net "uma frase de senha longa"
 *
 * Depois:
 *   npx wrangler d1 execute planee-fiscal --remote --command "<o SQL impresso>"
 */

import { webcrypto as crypto } from 'node:crypto';
import { randomUUID } from 'node:crypto';

const ITERACOES = 100_000;   // teto do runtime de Workers; ver src/auth/senha.ts

async function gerarHashSenha(senha) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const chave = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(senha.normalize('NFKC')), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERACOES, hash: 'SHA-256' }, chave, 256,
  );
  const b64 = (b) => Buffer.from(b).toString('base64');
  return `pbkdf2$${ITERACOES}$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

const [email, senha] = process.argv.slice(2);

if (!email || !senha) {
  console.error('uso: node scripts/semear-usuario.mjs <email> "<senha>"');
  process.exit(1);
}
if (senha.length < 12) {
  console.error('erro: use pelo menos 12 caracteres. Frase longa vale mais que símbolo estranho.');
  process.exit(1);
}

const id = randomUUID();
const hash = await gerarHashSenha(senha);
const agora = new Date().toISOString();
const nome = email.split('@')[0].replace(/[._-]/g, ' ');

console.log(`
INSERT INTO usuarios (id, tenant_id, email, nome, senha_hash, ativo, criado_em)
VALUES ('${id}', 'alfa', '${email.toLowerCase()}', '${nome}', '${hash}', 1, '${agora}');

INSERT INTO usuario_papeis (usuario_id, papel_id) VALUES ('${id}', 'papel-admin');
`.trim());

console.error(`\n✓ usuário ${email} — papel Admin. Rode o SQL acima com wrangler d1 execute.`);
