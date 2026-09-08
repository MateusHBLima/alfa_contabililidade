#!/usr/bin/env node
/**
 * Fala com o site publicado, sem navegador no meio.
 *
 *   node scripts/testar-login.mjs email@x.com "a senha"
 *
 * O navegador acrescenta variáveis que atrapalham o diagnóstico: cache de
 * página antiga, preenchimento automático, cookie velho, extensão. Aqui é uma
 * requisição HTTP crua com exatamente as credenciais escritas acima — o que
 * voltar é o que o servidor pensa, e nada mais.
 *
 * Roda da máquina de quem publicou porque só ela alcança o site; o ambiente do
 * Claude é barrado pelo proxy da sessão.
 */
const BASE = process.env.PLANEE_URL || 'https://planee-fiscal.planee.workers.dev';
const [email, senha] = process.argv.slice(2);

if (!email || !senha) {
  console.error('uso: node scripts/testar-login.mjs <email> "<senha>"');
  process.exit(1);
}

const linha = (t) => console.log(t);
linha(`\nServidor: ${BASE}`);
linha(`E-mail:   ${email}`);
linha(`Senha:    "${senha}"  (${senha.length} caracteres)\n`);

async function passo(nome, url, opcoes = {}) {
  try {
    const r = await fetch(url, opcoes);
    const texto = await r.text();
    linha(`  ${nome}`);
    linha(`      status: ${r.status} ${r.statusText}`);
    linha(`      corpo:  ${texto.slice(0, 300)}`);
    const cookie = r.headers.get('set-cookie');
    if (cookie) linha(`      cookie: ${cookie.split(';')[0].slice(0, 40)}...`);
    linha('');
    return { r, texto, cookie };
  } catch (e) {
    linha(`  ${nome}\n      FALHOU: ${e.message}\n`);
    return null;
  }
}

// 1. o serviço está de pé?
await passo('GET /api/saude', `${BASE}/api/saude`);

// 2. o login aceita?
const login = await passo('POST /api/login', `${BASE}/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, senha }),
});

// 3. se aceitou, a sessão vale?
if (login && login.r.status === 200 && login.cookie) {
  await passo('GET /api/eu (com o cookie)', `${BASE}/api/eu`, {
    headers: { Cookie: login.cookie.split(';')[0] },
  });
}

linha('---------------------------------------------------------');
if (!login) {
  linha('  Não consegui falar com o servidor. Sem internet, ou o endereço mudou.');
} else if (login.r.status === 200) {
  linha('  ✓ O SERVIDOR ACEITA essa senha.');
  linha('');
  linha('  Então o problema está no navegador: página antiga em cache, ou o');
  linha('  preenchimento automático colocando uma senha velha no campo.');
  linha('');
  linha('  Faça assim:');
  linha('    1. abra uma JANELA ANÔNIMA (Ctrl+Shift+N)');
  linha(`    2. vá em ${BASE}`);
  linha('    3. digite e-mail e senha à mão, sem aceitar sugestão do navegador');
} else if (login.r.status === 401) {
  linha('  ✗ O servidor recusa essa senha, mesmo com o banco dizendo que ela bate.');
  linha('    Isso é bug do servidor, não seu. Me mande esta saída inteira.');
} else if (login.r.status === 429) {
  linha('  A conta está bloqueada por tentativas seguidas. Espere 15 minutos,');
  linha('  ou rode o ARRUMAR-MEU-LOGIN de novo — ele solta o bloqueio.');
} else {
  linha('  Resposta inesperada. Me mande esta saída inteira.');
}
linha('---------------------------------------------------------\n');
