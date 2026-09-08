#!/usr/bin/env node
/**
 * Prepara o banco local e cria o usuário administrador — tudo de uma vez.
 *
 *   node scripts/preparar-local.mjs [email] [senha]
 *
 * Sem argumentos usa o par padrão abaixo. Idempotente: pode rodar quantas vezes quiser,
 * o usuário é recriado. Só mexe no banco LOCAL (.wrangler/state) — nunca na Cloudflare.
 */
import { webcrypto as crypto, randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const ITERACOES = 100_000;   // teto do runtime de Workers; ver src/auth/senha.ts

const email = (process.argv[2] || 'contadora@alfacontabil.net').toLowerCase();
const senha = process.argv[3] || 'alfa-contabilidade-2026';

if (senha.length < 12) {
  console.error('erro: senha com pelo menos 12 caracteres.');
  process.exit(1);
}

async function hashSenha(s) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const chave = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(s.normalize('NFKC')), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERACOES, hash: 'SHA-256' }, chave, 256,
  );
  const b64 = (b) => Buffer.from(b).toString('base64');
  return `pbkdf2$${ITERACOES}$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

function wrangler(args, titulo) {
  console.log(`\n> ${titulo}`);
  // CI=true poe o wrangler em modo nao-interativo: ele assume o padrao das perguntas
  // de confirmacao em vez de parar esperando um Y. Sem isso o subir.cmd trava numa
  // pergunta ("About to apply 3 migration(s)... continue?") que so tem uma resposta
  // possivel — o banco e local e acabou de ser criado.
  const r = spawnSync('npx', ['wrangler', ...args], {
    cwd: raiz, stdio: 'inherit', shell: true,
    env: { ...process.env, CI: 'true' },
  });
  if (r.status !== 0) {
    console.error(`\nfalhou: ${titulo}`);
    process.exit(r.status ?? 1);
  }
}

// 0. segredos de desenvolvimento
//
// .dev.vars esta no .gitignore — e tem que estar, e onde moram os segredos. So que
// isso significa que toda maquina que clona o repositorio comeca sem ele, e sem ele
// o login responde 500. Entao geramos um aqui, uma vez, com valores aleatorios desta
// maquina. Nunca sobrescrevemos: o AUDIT_SEED e o primeiro elo da cadeia de hash da
// auditoria, e troca-lo invalidaria a verificacao de tudo o que ja foi gravado.
const devVars = join(raiz, '.dev.vars');
const aleatorio = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');

// Lemos o que ja existe para PRESERVAR SESSION_SECRET e AUDIT_SEED. O AUDIT_SEED
// e o primeiro elo da cadeia de hash da auditoria: troca-lo invalidaria a
// verificacao de tudo o que ja foi gravado. So o LOGIN_DEMO e reescrito, porque
// ele acompanha o usuario que acabamos de criar.
const jaExistia = existsSync(devVars);
const linhas = jaExistia
  ? readFileSync(devVars, 'utf8').split(/\r?\n/)
  : [
      '# Segredos do ambiente LOCAL. Gerados automaticamente pelo preparar-local.mjs.',
      '# Nao commitar (ja esta no .gitignore) e nao usar em producao — la vao os do',
      '# SEGREDOS.txt, cadastrados com npx wrangler secret put.',
      `SESSION_SECRET=${aleatorio()}`,
      `AUDIT_SEED=${aleatorio()}`,
    ];

const semDemo = linhas.filter((l) => !l.startsWith('LOGIN_DEMO='));
// LOGIN_DEMO faz a tela de login se preencher sozinha. Fica aqui e so aqui: o
// wrangler le o .dev.vars apenas em `wrangler dev` e nunca o envia no deploy,
// entao a rota /api/local responde 404 em qualquer instalacao publicada.
// AMBIENTE=dev vive aqui, nao no wrangler.jsonc: la o padrao e producao, para
// que publicar sem pensar nao publique um sistema se anunciando como teste.
const semAmbiente = semDemo.filter((l) => !l.startsWith('AMBIENTE='));
semAmbiente.push('AMBIENTE=dev', `LOGIN_DEMO=${email}|${senha}`, '');
writeFileSync(devVars, semAmbiente.join('\n'), 'utf8');
console.log(jaExistia
  ? '\n> .dev.vars atualizado (segredos preservados, credencial de teste renovada)'
  : '\n> .dev.vars criado com segredos novos para esta maquina');

// 1. tabelas
wrangler(['d1', 'migrations', 'apply', 'planee-fiscal', '--local'], 'criando as tabelas no banco local');

// 2. usuário
const id = randomUUID();
const hash = await hashSenha(senha);
const agora = new Date().toISOString();
const nome = email.split('@')[0].replace(/[._-]/g, ' ');

const sql = `
DELETE FROM usuario_papeis WHERE usuario_id IN (SELECT id FROM usuarios WHERE email = '${email}');
DELETE FROM usuarios WHERE email = '${email}';
INSERT INTO usuarios (id, tenant_id, email, nome, senha_hash, ativo, criado_em)
VALUES ('${id}', 'alfa', '${email}', '${nome}', '${hash}', 1, '${agora}');
INSERT INTO usuario_papeis (usuario_id, papel_id) VALUES ('${id}', 'papel-admin');
`.trim();

mkdirSync(join(raiz, 'scripts'), { recursive: true });
const arquivo = join(raiz, 'scripts', '.usuario-temp.sql');
writeFileSync(arquivo, sql, 'utf8');

try {
  wrangler(['d1', 'execute', 'planee-fiscal', '--local', '--file', arquivo], `criando o usuário ${email}`);
} finally {
  try { unlinkSync(arquivo); } catch {}
}

console.log(`
=========================================================
  Banco local pronto.

  Endereço:  http://localhost:8787
  Usuário:   ${email}
  Senha:     ${senha}
  Papel:     Admin

  A tela de login já vem preenchida com esse par — é só dar Enter.
  A senha só existe como hash no banco; o par de teste mora no .dev.vars,
  que nunca sobe em deploy.
=========================================================
`);
