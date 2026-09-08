#!/usr/bin/env node
/**
 * Mantido como atalho: a troca de senha virou um caso do garantir-acesso.mjs,
 * que faz a mesma coisa e ainda cria o usuário se ele não existir — e confere
 * o resultado relendo o banco.
 *
 *   node scripts/trocar-senha.mjs email@x.com "a senha nova" [--local]
 *
 * Duas implementações do mesmo passo divergem em silêncio; esta aqui só
 * encaminha. (A versão anterior usava `--file`, que fala com a API de
 * importação do D1 e devolve "Authentication error [code: 10000]" com o token
 * do `wrangler login`.)
 */
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const aqui = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const livres = args.filter((a) => !a.startsWith('--'));

const pergunta = (t) => new Promise((r) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question(t, (v) => { rl.close(); r(v); });
});

const email = livres[0] || (await pergunta('  E-mail: ')).trim();
// A senha aparece na tela de propósito: digitar às cegas foi a origem de todo
// o problema do primeiro acesso em produção.
const senha = livres[1] || await pergunta('  Senha nova (aparece na tela): ');

const r = spawnSync(process.execPath,
  [join(aqui, 'garantir-acesso.mjs'), email, senha, ...args.filter((a) => a.startsWith('--'))],
  { stdio: 'inherit' });
process.exit(r.status ?? 1);
