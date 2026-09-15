/* Alfa Fiscal — cliente.
 *
 * Sem framework e sem passo de build: o protótipo era assim, o app é pequeno, e uma
 * dependência a menos é uma coisa a menos para quebrar num deploy.
 *
 * Regra que atravessa este arquivo: a TELA NÃO DECIDE O QUE É GRAVE. O servidor manda
 * `estilo` e `alertas` prontos por item, e `resumo` da nota. Assim o critério é um só e
 * está coberto por teste — a tela só pinta.
 */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const estado = {
  filtroNotas: 'todas',
  eu: null,
  empresas: [],
  empresaId: null,
  demo: null,   // par de teste do modo local, quando /api/local responde
  desafioMfa: null,
  competencia: '',
  competencias: [],
  notas: [],
  notaAberta: null,
  filtro: 'todos',
  busca: '',
};

// ------------------------------------------------------------------ api

/**
 * O que a pessoa logada pode. Vive aqui no escopo do módulo, e não dentro de uma
 * função, porque as telas de lista também precisam dela — quando isto era um
 * `const` local, `renderNotas` e `renderEmpresas` quebravam com
 * "pode is not defined" e a tabela aparecia vazia, sem erro visível.
 *
 * Esconder botão é conveniência, não segurança: cada rota confere a permissão
 * por conta própria no servidor.
 */
function pode(p) {
  return !!estado.eu?.permissoes?.includes(p);
}

async function api(caminho, opcoes = {}) {
  const r = await fetch(caminho, {
    credentials: 'same-origin',
    headers: opcoes.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...opcoes,
  });
  // O 401 do PRÓPRIO login significa "e-mail ou senha inválidos" — não sessão
  // vencida. A mensagem errada manda o usuário procurar o problema no lugar
  // errado. Foi bug de verdade: a primeira tentativa de entrar em produção
  // mostrou "sessão expirada" para quem nunca tinha tido sessão nenhuma.
  // As duas etapas do login ficam de fora: 401 nelas quer dizer "credencial
  // errada", não "sessão vencida". Tratar igual mandava o usuário de volta para
  // a primeira tela, com os campos limpos, ao errar um dígito do código — e a
  // mensagem "sessão expirada" o fazia procurar o problema no lugar errado.
  const ROTAS_DE_ENTRADA = ['/api/login', '/api/login/mfa'];
  if (r.status === 401 && !ROTAS_DE_ENTRADA.includes(caminho)) {
    mostrarLogin();
    throw new Error('sessão expirada');
  }
  const ct = r.headers.get('Content-Type') ?? '';
  const corpo = ct.includes('json') ? await r.json() : await r.text();
  // Senha redefinida por um administrador: o servidor recusa tudo até a troca.
  // A tela abre o formulário em vez de mostrar um 403 seco em cada clique.
  if (r.status === 403 && corpo && corpo.deveTrocarSenha) {
    if (!$('#modal-fundo').classList.contains('hidden')) { /* já está aberto */ }
    else abrirTrocaDeSenha(true);
  }
  if (!r.ok) throw Object.assign(new Error(corpo?.erro ?? 'erro'), { dados: corpo, status: r.status });
  return corpo;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const moeda = (v) =>
  v == null ? '—' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const dataCurta = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '—');

// ------------------------------------------------------------------ login

$('#form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#btn-entrar');
  btn.disabled = true;
  $('#login-erro').classList.add('hidden');
  try {
    const r = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ email: $('#login-email').value.trim(), senha: $('#login-senha').value }),
    });

    // Senha certa, sessão ainda não. Pedimos o segundo fator sem sair da tela.
    if (r && r.mfaRequerido) {
      estado.desafioMfa = r.desafio;
      $('#passo-mfa').classList.remove('hidden');
      $('#login-email').disabled = true;
      $('#login-senha').disabled = true;
      $('#btn-entrar').classList.add('hidden');
      $('#mfa-codigo').focus();
      return;
    }

    await iniciar();
    if (r && r.deveTrocarSenha) abrirTrocaDeSenha(true);
  } catch (err) {
    $('#login-erro').textContent = err.message || 'não foi possível entrar';
    $('#login-erro').classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

/* Credenciais de teste na tela de login.
   So aparece se /api/local responder — o que exige LOGIN_DEMO no .dev.vars, que
   nao sobe em deploy nenhum. Em producao o fetch da 404 e nada acontece. */
(async function cartaoLocal() {
  try {
    const r = await fetch('/api/local');
    if (!r.ok) return;
    const { email, senha } = await r.json();
    if (!email || !senha) return;

    $('#demo-email').textContent = email;
    $('#demo-senha').textContent = senha;
    $('#cartao-local').classList.remove('hidden');

    estado.demo = { email, senha };
    $('#btn-preencher').addEventListener('click', preencherDemo);
    preencherDemo();   // ja chega preenchido: um Enter e voce esta dentro

    for (const b of $$('#cartao-local .copiar')) {
      b.addEventListener('click', async () => {
        const texto = $('#' + b.dataset.alvo).textContent;
        try { await navigator.clipboard.writeText(texto); } catch {
          // clipboard bloqueado (http sem localhost, permissao negada): seleciona
          // o texto para o Ctrl+C funcionar. Botao que nao faz nada e pior que
          // botao que faz metade.
          const faixa = document.createRange();
          faixa.selectNodeContents($('#' + b.dataset.alvo));
          const sel = getSelection(); sel.removeAllRanges(); sel.addRange(faixa);
        }
        const antes = b.textContent;
        b.textContent = 'copiado';
        setTimeout(() => { b.textContent = antes; }, 1200);
      });
    }
  } catch { /* sem rota, sem cartao */ }
})();

/* Trocar senha dentro do app.
   Faltava, e a falta apareceu do pior jeito: a senha do primeiro admin em
   producao foi digitada as cegas, sem confirmacao, e a unica saida era um
   script na maquina de quem publicou. */
function abrirTrocaDeSenha(forcado = false) {
  abrirModal(forcado ? 'Defina uma senha nova' : 'Trocar senha', `
    ${forcado ? '<p class="page-desc">Sua senha precisa ser trocada antes de continuar.</p>' : ''}
    <div class="campo">
      <label class="fl" for="ts-atual">Senha atual</label>
      <input type="password" id="ts-atual" autocomplete="current-password">
    </div>
    <div class="campo">
      <label class="fl" for="ts-nova">Senha nova</label>
      <input type="password" id="ts-nova" autocomplete="new-password">
    </div>
    <div class="campo">
      <label class="fl" for="ts-confirma">Repita a senha nova</label>
      <input type="password" id="ts-confirma" autocomplete="new-password">
    </div>
    <p class="page-desc">Pelo menos 12 caracteres. Uma frase longa vale mais que
      símbolo estranho — e você não vai anotá-la num papel.</p>
    <p class="page-desc"><b>Todas as sessões abertas serão encerradas</b>, aqui e em
      qualquer outro computador. Menos esta.</p>
  `, async () => {
    const atual = $('#ts-atual').value;
    const nova = $('#ts-nova').value;
    // Confere aqui tambem: erro de digitacao nao precisa de ida ao servidor,
    // e foi exatamente o que fez a senha do primeiro admin sair errada.
    if (nova !== $('#ts-confirma').value) throw new Error('as duas senhas novas não batem');
    if (!atual || !nova) throw new Error('preencha os três campos');
    await api('/api/trocar-senha', {
      method: 'POST',
      body: JSON.stringify({ senhaAtual: atual, senhaNova: nova }),
    });
    alerta('Senha trocada. As outras sessões foram encerradas.');
  });
}

$('#btn-trocar-senha').addEventListener('click', (e) => {
  e.preventDefault();
  abrirTrocaDeSenha();
});

/* ------------------------------------------------------------------ cadastro */

/** Três formulários no mesmo cartão: entrar, pedir acesso, esquecer a senha. */
function mostrarFormulario(qual) {
  for (const [id, nome] of [['#form-login', 'login'], ['#form-cadastro', 'cadastro'], ['#form-esqueci', 'esqueci']]) {
    $(id).classList.toggle('hidden', nome !== qual);
  }
  for (const p of ['cadastro', 'esqueci']) {
    $(`#${p}-erro`).classList.add('hidden');
    $(`#${p}-ok`).classList.add('hidden');
    $(`#${p}-campos`).classList.remove('hidden');
  }
}
const mostrarCadastro = (mostrar) => mostrarFormulario(mostrar ? 'cadastro' : 'login');

$('#link-esqueci').addEventListener('click', (e) => { e.preventDefault(); mostrarFormulario('esqueci'); });
$('#btn-voltar-login3').addEventListener('click', (e) => { e.preventDefault(); mostrarFormulario('login'); });
$('#btn-voltar-login4').addEventListener('click', () => mostrarFormulario('login'));

$('#btn-esqueci').addEventListener('click', async (e) => {
  e.preventDefault();
  const btn = $('#btn-esqueci');
  btn.disabled = true;
  $('#esqueci-erro').classList.add('hidden');
  try {
    const r = await api('/api/esqueci', {
      method: 'POST', body: JSON.stringify({ email: $('#esq-email').value.trim() }),
    });
    $('#esqueci-campos').classList.add('hidden');
    $('#esqueci-msg').textContent = r.mensagem;
    $('#esqueci-ok').classList.remove('hidden');
  } catch (err) {
    $('#esqueci-erro').textContent = err.message || 'não foi possível registrar o pedido';
    $('#esqueci-erro').classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

$('#link-criar-conta').addEventListener('click', (e) => { e.preventDefault(); mostrarCadastro(true); });

// Link de convite abre direto no cadastro, com o código já preenchido: quem
// recebe o link não precisa entender o que fazer com um código solto.
(() => {
  const codigo = new URLSearchParams(location.search).get('convite');
  if (!codigo) return;
  $('#cad-convite').value = codigo;
  mostrarFormulario('cadastro');
})();
$('#btn-voltar-login').addEventListener('click', (e) => { e.preventDefault(); mostrarCadastro(false); });
$('#btn-voltar-login2').addEventListener('click', () => mostrarCadastro(false));

$('#btn-cadastrar').addEventListener('click', async (e) => {
  e.preventDefault();
  const btn = $('#btn-cadastrar');
  const erro = (m) => {
    $('#cadastro-erro').textContent = m;
    $('#cadastro-erro').classList.remove('hidden');
  };
  $('#cadastro-erro').classList.add('hidden');

  const senha = $('#cad-senha').value;
  // Confere aqui as duas senhas: é erro de digitação, não precisa de servidor —
  // e no cadastro ele custa caro, porque a pessoa fica com uma conta cuja senha
  // não é a que ela pensa, esperando aprovação para descobrir isso.
  if (senha !== $('#cad-senha2').value) return erro('as duas senhas não são iguais');
  if (!$('#cad-nome').value.trim()) return erro('informe seu nome');

  btn.disabled = true;
  try {
    const r = await api('/api/cadastrar', {
      method: 'POST',
      body: JSON.stringify({
        nome: $('#cad-nome').value.trim(),
        email: $('#cad-email').value.trim(),
        senha,
        convite: $('#cad-convite').value.trim() || undefined,
      }),
    });
    $('#cadastro-campos').classList.add('hidden');
    $('#cadastro-msg').textContent = r.mensagem;
    $('#cadastro-ok').classList.remove('hidden');
  } catch (err) {
    erro(err.message || 'não foi possível registrar o pedido');
  } finally {
    btn.disabled = false;
  }
});

$('#btn-mfa').addEventListener('click', async () => {
  const btn = $('#btn-mfa');
  btn.disabled = true;
  $('#login-erro').classList.add('hidden');
  try {
    const r = await api('/api/login/mfa', {
      method: 'POST',
      body: JSON.stringify({ desafio: estado.desafioMfa, codigo: $('#mfa-codigo').value }),
    });
    await iniciar();
    if (r && r.deveTrocarSenha) abrirTrocaDeSenha(true);
  } catch (err) {
    $('#login-erro').textContent = err.message || 'código não confere';
    $('#login-erro').classList.remove('hidden');
    // Desafio vencido ou gasto: a mensagem manda começar de novo, e sem isto não
    // existia controle nenhum para isso — os campos ficavam travados e o botão
    // Entrar escondido. Só F5 resolvia.
    if (err && err.dados && err.dados.expirado) mostrarLogin();
    else $('#mfa-codigo').select();
  } finally {
    btn.disabled = false;
  }
});

// Enter no campo do código confirma, em vez de reenviar a senha.
$('#mfa-codigo').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#btn-mfa').click(); }
});

/* ---------------------------------------------------------------- segurança */

async function abrirSeguranca() {
  const est = await api('/api/mfa');

  if (est.ativo) {
    abrirModal('Segundo fator', `
      <p class="page-desc"><b>Está ligado.</b> Confirmado em
        ${est.confirmadoEm ? new Date(est.confirmadoEm).toLocaleDateString('pt-BR') : '—'}.
        Códigos de recuperação ainda válidos: <b>${est.codigosRestantes}</b>.</p>
      <p class="page-desc">Para desligar, confirme sua senha e um código do aplicativo.
        As duas coisas, porque desligar a proteção não pode ser mais fácil do que usá-la.</p>
      <div class="campo">
        <label class="fl" for="sg-senha">Sua senha</label>
        <input type="password" id="sg-senha" autocomplete="current-password">
      </div>
      <div class="campo">
        <label class="fl" for="sg-codigo">Código do aplicativo</label>
        <input type="text" id="sg-codigo" inputmode="numeric" maxlength="6" placeholder="000000">
      </div>
    `, async () => {
      await api('/api/mfa/desativar', {
        method: 'POST',
        body: JSON.stringify({ senha: $('#sg-senha').value, codigo: $('#sg-codigo').value }),
      });
      alerta('Segundo fator desligado.');
    });
    $('#modal-ok').textContent = 'Desligar';
    return;
  }

  const ini = await api('/api/mfa/iniciar', { method: 'POST' });
  abrirModal('Ligar o segundo fator', `
    <p class="page-desc">Abra seu aplicativo autenticador (Google Authenticator, Authy,
      1Password, o que você usar) e cadastre esta chave:</p>
    <p style="text-align:center;margin:.6rem 0">
      <code style="font-size:1.05rem;letter-spacing:.08em;user-select:all;background:#fff;
        border:1px solid #dfe8f2;border-radius:6px;padding:.4rem .6rem;display:inline-block">
        ${esc(ini.segredoLegivel)}</code>
    </p>
    <p class="page-desc">No aplicativo, escolha <b>“inserir chave manualmente”</b> ou
      <b>“inserir código de configuração”</b>. O nome da conta pode ser qualquer coisa.</p>
    <div class="campo">
      <label class="fl" for="sg-conf">Digite o código que o aplicativo mostrar</label>
      <input type="text" id="sg-conf" inputmode="numeric" maxlength="6" placeholder="000000">
    </div>
    <p class="page-desc">Só depois que este código conferir é que o segundo fator liga —
      assim um erro de cadastro aparece agora, e não no próximo login.</p>
  `, async () => {
    const r = await api('/api/mfa/confirmar', {
      method: 'POST', body: JSON.stringify({ codigo: $('#sg-conf').value }),
    });
    mostrarCodigosRecuperacao(r.codigosRecuperacao);
  });
  $('#modal-ok').textContent = 'Confirmar';
}

function mostrarCodigosRecuperacao(codigos) {
  // Aparecem UMA vez. Só o hash fica no banco — nem administrador vê de novo.
  setTimeout(() => {
    abrirModal('Guarde estes códigos agora', `
      <p class="page-desc"><b>Segundo fator ligado.</b> Estes oito códigos são a sua
        saída se o celular sumir. Cada um serve uma vez.</p>
      <p class="page-desc"><b>Eles não aparecem de novo</b> — no banco fica só o
        embaralhado deles. Copie para onde você guarda senhas, ou imprima.</p>
      <pre style="background:#fff;border:1px solid #dfe8f2;border-radius:6px;padding:.7rem;
        font-size:.95rem;line-height:1.8;user-select:all;text-align:center">${codigos.map(esc).join('\n')}</pre>
    `, async () => {});
    $('#modal-cancelar').classList.add('hidden');
    $('#modal-ok').textContent = 'Guardei';
  }, 30);
}

$('#btn-seguranca').addEventListener('click', (e) => {
  e.preventDefault();
  abrirSeguranca().catch((err) => alerta(err.message));
});

$('#btn-sair').addEventListener('click', async (e) => {
  e.preventDefault();
  // Só mostra o login DEPOIS de o servidor confirmar. O `catch {}` seguido de
  // mostrarLogin() pintava a tela de deslogado sem revogar a sessão: numa
  // máquina compartilhada, a próxima pessoa dava F5 e entrava com o cookie
  // ainda válido. É o mesmo padrão de engolir erro, agora no cliente.
  try {
    await api('/api/logout', { method: 'POST' });
    mostrarLogin();
  } catch (err) {
    alerta('Não consegui encerrar a sessão no servidor. '
      + 'Você continua conectado — tente de novo antes de deixar este computador.');
  }
});

/* Preenche o formulario com o par de teste do modo local, se houver.
   Fica separado de proposito: o cartao chama na carga e o mostrarLogin chama
   depois de sair, e as duas coisas acontecem em ordem imprevisivel. */
function preencherDemo() {
  if (!estado.demo) return false;
  $('#login-email').value = estado.demo.email;
  $('#login-senha').value = estado.demo.senha;
  return true;
}

function mostrarLogin() {
  $('#tela-app').classList.add('hidden');
  $('#tela-login').classList.remove('hidden');
  // Desfaz a segunda etapa: voltar ao login com os campos travados e o botão
  // sumido deixaria a tela num beco sem saída.
  estado.desafioMfa = null;
  $('#passo-mfa').classList.add('hidden');
  $('#mfa-codigo').value = '';
  $('#login-email').disabled = false;
  $('#login-senha').disabled = false;
  $('#btn-entrar').classList.remove('hidden');
  // Limpar a senha ao voltar para o login e correto — mas no modo local a tela
  // deve voltar pronta. Foi bug de verdade: o cartao preenchia na carga e o
  // boot, que roda depois e cai aqui quando nao ha sessao, apagava o campo.
  // O resultado dependia de qual fetch terminava primeiro.
  if (!preencherDemo()) $('#login-senha').value = '';
}

// ------------------------------------------------------------------ shell

$$('#nav button').forEach((b) => b.addEventListener('click', () => irPara(b.dataset.view)));

/* Fornecedores e padroes sao POR EMPRESA — o banco sempre separou
   (UNIQUE tenant + empresa + CNPJ), mas a tela nao dizia, e um menu chamado
   "Cadastros" com as tres juntas dava a entender que a lista era global.
   Agora o titulo dessas telas carrega o nome da empresa selecionada. */
function nomeEmpresaAtual() {
  const e = (estado.empresas || []).find((x) => x.id === estado.empresaId);
  return e ? e.razao_social : null;
}

function marcarEscopo() {
  const nome = nomeEmpresaAtual();
  for (const id of ['#escopo-fornecedores', '#escopo-regras']) {
    const el = $(id);
    if (el) el.textContent = nome ? `de ${nome}` : 'nenhuma empresa selecionada';
  }
}

function irPara(view) {
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  ['v1', 'v2', 'v3', 'vEmpresas', 'vFornecedores', 'vRegras', 'vUsuarios', 'vPapeis'].forEach((v) =>
    $('#' + v).classList.toggle('hidden', v !== view));
  marcarEscopo();
  if (view === 'vEmpresas') renderEmpresas();
  if (view === 'vFornecedores') carregarFornecedores();
  if (view === 'vRegras') carregarRegras();
  if (view === 'vUsuarios') carregarUsuarios();
  if (view === 'vPapeis') carregarPapeis();
}

$('#sel-empresa').addEventListener('change', async (e) => {
  estado.empresaId = e.target.value;
  estado.notaAberta = null;
  marcarEscopo();
  // Competencia e recorte da empresa ANTERIOR. Levar "setembro/2026" para uma
  // empresa que so tem notas de 2025 devolveria lista vazia sem explicacao.
  estado.competencia = '';
  await carregarCompetencias();
  // Trocar de empresa nao pode deixar na tela a lista da empresa anterior.
  const aberta = ['vFornecedores', 'vRegras']
    .find((v) => !$('#' + v).classList.contains('hidden'));
  if (aberta === 'vFornecedores') await carregarFornecedores();
  if (aberta === 'vRegras') await carregarRegras();
  await carregarNotas();
});

/**
 * Ano e mes, nesta ordem, porque e assim que a contadora procura: primeiro o
 * exercicio, depois a competencia. Uma empresa com 200 notas nao se acha numa
 * lista unica - foi o proprio pedido dela, falando de "empresas aqui que sao
 * 200 notas e que a gente tambem nao vai fazer tudo no mesmo dia".
 *
 * As opcoes vem de /competencias, NAO das notas ja filtradas. Antes elas saiam
 * do resultado da busca, e o seletor se destruia sozinho: escolhia setembro, a
 * busca voltava so com setembro, o seletor era remontado a partir dela, e
 * agosto sumia da lista. Quem nao descobrisse que precisava voltar em "todas"
 * concluia que as notas de agosto tinham sumido do sistema.
 */
$('#sel-ano').addEventListener('change', async () => {
  desenharMeses();
  await aplicarCompetencia();
});

$('#sel-mes').addEventListener('change', aplicarCompetencia);

async function aplicarCompetencia() {
  const ano = $('#sel-ano').value;
  const mes = $('#sel-mes').value;
  // Mes sem ano nao existe como filtro: "setembro" de qual exercicio?
  estado.competencia = ano && mes ? `${ano}-${mes}` : ano || '';
  await carregarNotas();
}

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** [{competencia:'2026-09', notas:4}] da empresa inteira, nao do filtro. */
async function carregarCompetencias() {
  if (!estado.empresaId) return;
  try {
    estado.competencias = await api(`/api/empresas/${estado.empresaId}/competencias`);
  } catch {
    estado.competencias = [];
  }
  desenharAnos();
  desenharMeses();
}

function desenharAnos() {
  const sel = $('#sel-ano');
  const anos = [...new Set(estado.competencias.map((c) => c.competencia.slice(0, 4)))].sort().reverse();
  const contar = (a) => estado.competencias
    .filter((c) => c.competencia.startsWith(a))
    .reduce((s, c) => s + c.notas, 0);
  const atual = sel.value;
  sel.innerHTML = '<option value="">todos</option>' +
    anos.map((a) => `<option value="${a}">${a} (${contar(a)})</option>`).join('');
  sel.value = anos.includes(atual) ? atual : '';
}

function desenharMeses() {
  const sel = $('#sel-mes');
  const ano = $('#sel-ano').value;
  const atual = sel.value;

  // Sem ano escolhido nao ha mes para escolher, e o seletor diz isso em vez de
  // ficar habilitado e vazio.
  if (!ano) {
    sel.innerHTML = '<option value="">escolha o ano</option>';
    sel.disabled = true;
    sel.value = '';
    return;
  }

  sel.disabled = false;
  const doAno = estado.competencias
    .filter((c) => c.competencia.startsWith(ano))
    .sort((a, b) => a.competencia.localeCompare(b.competencia));
  sel.innerHTML = '<option value="">o ano todo</option>' +
    doAno.map((c) => {
      const m = c.competencia.slice(5, 7);
      return `<option value="${m}">${MESES[Number(m) - 1] ?? m} (${c.notas})</option>`;
    }).join('');
  sel.value = doAno.some((c) => c.competencia.slice(5, 7) === atual) ? atual : '';
}

async function iniciar() {
  estado.eu = await api('/api/eu');
  $('#usuario-nome').textContent = estado.eu.nome;
  $('#usuario-email').textContent = estado.eu.email;
  $('#rodape-ambiente').textContent = 'sessão ativa';

  $('#tela-login').classList.add('hidden');
  $('#tela-app').classList.remove('hidden');

  // A tela esconde; o servidor decide. Estas linhas são conveniência, não
  // segurança — cada rota confere a permissão por conta própria.
  $('#btn-nova-empresa').classList.toggle('hidden', !pode('empresas.criar'));
  $('#btn-novo-usuario').classList.toggle('hidden', !pode('usuarios.criar'));
  $('#btn-convidar').classList.toggle('hidden', !pode('usuarios.convidar'));
  $('#btn-novo-papel').classList.toggle('hidden', !pode('papeis.gerenciar'));
  for (const [botao, permissao] of [['vUsuarios', 'usuarios.visualizar'], ['vPapeis', 'papeis.gerenciar']]) {
    const b = document.querySelector(`#nav button[data-view="${botao}"]`);
    if (b) b.classList.toggle('hidden', !pode(permissao));
  }

  await carregarEmpresas();
  montarSeletorCfop();
}

async function carregarEmpresas() {
  estado.empresas = await api('/api/empresas');
  const sel = $('#sel-empresa');
  if (estado.empresas.length === 0) {
    sel.innerHTML = '<option value="">nenhuma empresa cadastrada</option>';
    irPara('vEmpresas');
    return;
  }
  sel.innerHTML = estado.empresas
    .map((e) => `<option value="${e.id}">${esc(e.razao_social)} — ${esc(e.cnpj)}</option>`)
    .join('');
  estado.empresaId = estado.empresas[0].id;
  marcarEscopo();
  await carregarNotas();
}

// ------------------------------------------------------------------ ambiente 1

const drop = $('#drop');
const inputArquivo = $('#arquivo-xml');

drop.addEventListener('click', () => inputArquivo.click());
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  enviar([...e.dataTransfer.files]);
});
inputArquivo.addEventListener('change', () => enviar([...inputArquivo.files]));

async function enviar(arquivos) {
  if (!estado.empresaId) return alerta('Escolha uma empresa antes de importar.');
  const xmls = arquivos.filter((f) => f.name.toLowerCase().endsWith('.xml'));
  if (xmls.length === 0) return alerta('Nenhum arquivo .xml no que foi solto.');

  const log = $('#log-import');
  log.classList.remove('hidden');
  log.textContent = `enviando ${xmls.length} arquivo(s)...\n`;

  const form = new FormData();
  for (const f of xmls) form.append('arquivos', f, f.name);

  try {
    const r = await api(`/api/empresas/${estado.empresaId}/importar`, { method: 'POST', body: form });
    log.textContent =
      `${r.importadas} importada(s) · ${r.duplicadas} duplicada(s) · ${r.recusadas} recusada(s)\n\n` +
      r.arquivos
        .map((a) => {
          const marca = { importada: '✓', duplicada: '=', recusada: '✕' }[a.status];
          const extra = a.status === 'importada'
            ? `${a.itens} itens${a.preenchidos ? `, ${a.preenchidos} já preenchidos pelo padrão` : ''}`
            : (a.motivo ?? '');
          return `${marca} ${a.arquivo}  ${extra}`;
        })
        .join('\n');
    // Nota nova pode trazer competencia nova: o seletor tem que saber dela.
    await carregarCompetencias();
    await carregarNotas();
  } catch (e) {
    log.textContent = 'falhou: ' + e.message;
  }
  inputArquivo.value = '';
}

async function carregarNotas() {
  if (!estado.empresaId) return;
  if (estado.competencias.length === 0) await carregarCompetencias();
  const q = estado.competencia ? `?competencia=${estado.competencia}` : '';
  estado.notas = await api(`/api/empresas/${estado.empresaId}/notas${q}`);
  renderNotas();
}

function renderNotas() {
  const corpo = $('#tbl-notas tbody');
  const vazio = $('#vazio-notas');
  vazio.classList.toggle('hidden', estado.notas.length > 0);

  const totalItens = estado.notas.reduce((s, n) => s + (n.total_itens ?? 0), 0);
  const revisados = estado.notas.reduce((s, n) => s + (n.itens_revisados ?? 0), 0);
  const valor = estado.notas.reduce((s, n) => s + (n.valor_total ?? 0), 0);
  const fornecedores = new Set(estado.notas.map((n) => n.emit_cnpj)).size;

  $('#kpis-notas').innerHTML = [
    ['Notas', estado.notas.length],
    ['Fornecedores', fornecedores],
    ['Itens', totalItens],
    ['Itens revisados', totalItens ? `${revisados}<small> de ${totalItens}</small>` : '—'],
    ['Valor total', 'R$ ' + moeda(valor)],
  ].map(([l, v]) => `<div class="kpi"><div class="lbl">${l}</div><div class="val">${v}</div></div>`).join('');

  $('#hint-notas').textContent = estado.notas.length ? `${estado.notas.length} nota(s)` : '';

  // Empresa com 200 notas nao se trata num dia. Separar o que ja passou por gente
  // do que ainda nao passou foi o primeiro pedido da contadora depois de usar.
  const tratada = (n) => (n.total_itens ?? 0) > 0 && (n.itens_revisados ?? 0) >= n.total_itens;
  const visiveis = estado.notas.filter((n) => {
    if (estado.filtroNotas === 'tratar') return !tratada(n);
    if (estado.filtroNotas === 'tratadas') return tratada(n);
    return true;
  });

  if (visiveis.length === 0) {
    corpo.innerHTML = `<tr><td colspan="8" class="vazio">${
      estado.filtroNotas === 'tratadas' ? 'Nenhuma nota tratada ainda.' : 'Nenhuma nota pendente.'
    }</td></tr>`;
    return;
  }

  corpo.innerHTML = visiveis.map((n) => {
    const total = n.total_itens ?? 0;
    const feitos = n.itens_revisados ?? 0;
    const pendentes = total - feitos;

    // Três estados, não dois. "Comecei e parei no meio" é o caso normal numa
    // empresa de 200 notas, e era exatamente o que não dava para ver: tudo que
    // não estava 100% aparecia igual a nunca tocada.
    const estagio = total === 0 ? 'vazia' : feitos === 0 ? 'nova' : pendentes === 0 ? 'pronta' : 'andando';
    const selo = {
      vazia: '<span class="tag mut">sem itens</span>',
      nova: `<span class="tag warn">${pendentes} a revisar</span>`,
      andando: `<span class="tag info">${feitos} de ${total} conferidos</span>`,
      pronta: '<span class="tag ok">✓ tratada</span>',
    }[estagio];

    // O botão diz o que resta fazer. Azul de "Tratar" numa nota pronta convida
    // para um trabalho que já foi feito; e quem parou no meio precisa saber que
    // é para continuar, não para começar de novo.
    const acao = {
      vazia: { rotulo: 'Abrir →', classe: '', dica: 'Nota sem itens' },
      nova: { rotulo: 'Tratar →', classe: 'primary', dica: 'Começar a tratar esta nota' },
      andando: { rotulo: 'Continuar →', classe: 'primary', dica: `Faltam ${pendentes} item(ns)` },
      pronta: { rotulo: 'Ver →', classe: '', dica: 'Abrir para conferir ou ajustar' },
    }[estagio];

    return `<tr class="nota-${estagio}">
      <td>${dataCurta(n.dh_emi)}</td>
      <td class="mono">${esc(n.numero)}</td>
      <td>${esc(n.emit_nome ?? n.emit_cnpj)}<span class="porque">${esc(n.emit_cnpj)}</span></td>
      <td class="mono tiny">${esc(String(n.chave).slice(0, 12))}…</td>
      <td class="num">${moeda(n.valor_total)}</td>
      <td class="num">${n.total_itens ?? 0}</td>
      <td>${selo}</td>
      <td class="acoes">
        <button class="btn sm ${acao.classe}" data-nota="${n.id}" title="${acao.dica}">${acao.rotulo}</button>
        ${pode('notas.apagar') ? `<button class="btn sm perigo" data-apagar-nota="${n.id}" title="Apagar esta nota">Apagar</button>` : ''}
      </td>
    </tr>`;
  }).join('');

  $$('#tbl-notas button[data-nota]').forEach((b) =>
    b.addEventListener('click', () => abrirNota(b.dataset.nota)));

  $$('#tbl-notas button[data-apagar-nota]').forEach((b) =>
    b.addEventListener('click', () => apagarNota(b.dataset.apagarNota)));
}

/**
 * Apagar nota. Some com os itens e com o XML guardado; as REGRAS aprendidas
 * ficam, porque são conhecimento do escritório sobre o fornecedor e não
 * pertencem à nota que por acaso as ensinou.
 */
function apagarNota(id) {
  const n = estado.notas.find((x) => x.id === id);
  abrirModal('Apagar nota', `
    <p>Apagar a nota <b>${esc(n?.numero ?? '')}</b> de ${esc(n?.emit_nome ?? '')}?</p>
    <p class="porque">Somem a nota, os ${n?.total_itens ?? 0} itens e o XML arquivado.
      As regras já aprendidas com ela continuam valendo.</p>
    <p class="porque">Não dá para desfazer.</p>
  `, async () => {
    await api('/api/notas/' + id, { method: 'DELETE' });
    await carregarNotas();
  });
  $('#modal-ok').textContent = 'Apagar';
  $('#modal-ok').classList.add('perigo');
}

// ------------------------------------------------------------------ ambiente 2

$('#btn-voltar-notas').addEventListener('click', () => irPara('v1'));
$('#btn-ver-xml').addEventListener('click', () => { irPara('v3'); renderXml(); });
$('#busca').addEventListener('input', (e) => { estado.busca = e.target.value.toLowerCase(); renderItens(); });
$$('#filtros-notas button').forEach((b) => b.addEventListener('click', () => {
  $$('#filtros-notas button').forEach((x) => x.classList.remove('on'));
  b.classList.add('on');
  estado.filtroNotas = b.dataset.fn;
  renderNotas();
}));

$$('#filtros button').forEach((b) => b.addEventListener('click', () => {
  $$('#filtros button').forEach((x) => x.classList.remove('on'));
  b.classList.add('on');
  estado.filtro = b.dataset.f;
  renderItens();
}));

async function abrirNota(id) {
  estado.notaAberta = await api(`/api/notas/${id}`);
  irPara('v2');
  renderItens();
}

const CFOPS = [
  ['1102', 'Compra para revenda'],
  ['1101', 'Compra para industrialização'],
  ['1556', 'Compra de material para uso e consumo'],
  ['1403', 'Compra para revenda — ST'],
  ['1407', 'Compra de material de uso e consumo — ST'],
  ['1551', 'Compra de bem para o ativo imobilizado'],
  ['1202', 'Devolução de venda'],
  ['2102', 'Compra para revenda — outro estado'],
  ['2101', 'Compra para industrialização — outro estado'],
  ['2556', 'Compra de uso e consumo — outro estado'],
  ['2403', 'Compra para revenda com ST — outro estado'],
];

function montarSeletorCfop() {
  $('#bulk-cfop').innerHTML =
    '<option value="">aplicar CFOP…</option>' +
    CFOPS.map(([c, d]) => `<option value="${c}">${c} — ${d}</option>`).join('');
}

function itensVisiveis() {
  const itens = estado.notaAberta?.itens ?? [];
  return itens.filter((i) => {
    if (estado.busca) {
      const alvo = `${i.x_prod_original} ${i.x_prod_novo ?? ''} ${i.c_prod ?? ''} ${i.ncm ?? ''}`.toLowerCase();
      if (!alvo.includes(estado.busca)) return false;
    }
    const e = i.estilo?.estado;
    if (estado.filtro === 'atencao') return e === 'bloqueado' || e === 'conferir';
    if (estado.filtro === 'novo') return e === 'novo';
    // 'padrao' e 'aprendido' sao o mesmo "ja esta pronto", so que dizendo de onde
    // veio. Sem isto o filtro Prontos passaria a esconder justamente as linhas que
    // o sistema acertou sozinho.
    if (estado.filtro === 'pronto') return e === 'pronto' || e === 'padrao' || e === 'aprendido';
    if (estado.filtro === 'conferido') return e === 'conferido';
    return true;
  });
}

function renderItens() {
  const n = estado.notaAberta;
  const corpo = $('#tbl-itens tbody');
  $('#vazio-itens').classList.toggle('hidden', !!n);
  if (!n) { corpo.innerHTML = ''; $('#faixa-resumo').innerHTML = ''; return; }

  $('#titulo-nota').textContent = `Nota ${n.nota.numero} — ${n.nota.emit_nome ?? n.nota.emit_cnpj}`;
  $('#hint-nota').textContent = `${dataCurta(n.nota.dh_emi)} · R$ ${moeda(n.nota.valor_total)}`;

  // A faixa do topo vem pronta do servidor: o critério de gravidade é um só.
  const r = n.resumo;
  const classe = r.criticos > 0 ? 'critico' : r.atencao > 0 ? 'atencao' : 'ok';
  $('#faixa-resumo').innerHTML =
    `<div class="faixa ${classe}"><b>${esc(r.chamada)}</b>
      ${r.bloqueiaExportacao ? '<span class="tag dan">exportação bloqueada</span>' : ''}
    </div>` +
    // O placar do aprendizado é o número que mede o produto, e é a única prova
    // visível de que ensinar o sistema serviu para alguma coisa. Fica fora da
    // faixa colorida de propósito: é notícia boa, não alarme.
    (r.aprendizado ? `<div class="placar">📚 ${esc(r.aprendizado)}</div>` : '') +
    // O que falta padronizar vive AQUI, e nao em cada linha. Medido nas notas
    // reais: 38 de 38 itens estavam sem descricao padronizada. Um aviso em 100%
    // das linhas nao informa, so ensina a ignorar aviso - e ai ele nao funciona
    // mais nas tres linhas em que importava.
    (r.semDescricaoPadrao > 0
      ? `<div class="placar sutil" title="O CFOP de entrada é a decisão fiscal e já está resolvido. A descrição padronizada é organização do cadastro: sem ela, o XML corrigido sai com o nome que o fornecedor escreveu.">✎ ${r.semDescricaoPadrao} ${
          r.semDescricaoPadrao === 1 ? 'item ainda está' : 'itens ainda estão'
        } com a descrição do fornecedor</div>`
      : '');

  const lista = itensVisiveis();

  // Filtro que nao casa nada tem que DIZER isso. Sem esta linha a tabela some e
  // fica um retangulo branco: nenhum erro, nenhuma mensagem, a nota inteira
  // aparentemente vazia. E a mesma forma do bug do `pode()` - a tela nao quebra,
  // ela mente calada, e quem esta usando conclui que perdeu o trabalho.
  // Visto em producao: nota com 7 itens conferidos, filtro "Prontos", tela em branco.
  if (lista.length === 0) {
    const porque = estado.busca
      ? `Nenhum item com “${esc(estado.busca)}”.`
      : {
          atencao:   'Nenhum item pedindo atenção — a nota está em dia.',
          novo:      'Nenhum produto novo nesta nota.',
          pronto:    'Nenhum item veio pronto do sistema. Os que você já conferiu estão em “Conferidos”.',
          conferido: 'Nenhum item conferido ainda.',
        }[estado.filtro] ?? 'Nenhum item nesta situação.';
    corpo.innerHTML =
      `<tr><td colspan="9" class="vazio">${esc(porque)}
        <button class="btn sm" id="limpar-filtro-itens">Ver todos os ${n.itens.length} itens</button>
      </td></tr>`;
    $('#limpar-filtro-itens')?.addEventListener('click', () => {
      estado.filtro = 'todos';
      estado.busca = '';
      $('#busca').value = '';
      $$('#filtros button').forEach((x) => x.classList.toggle('on', x.dataset.f === 'todos'));
      renderItens();
    });
    return;
  }

  corpo.innerHTML = lista.map((i) => linhaItem(i)).join('');

  $$('#tbl-itens [data-campo]').forEach((el) => {
    el.addEventListener('change', () => salvarCampo(el.dataset.item, el.dataset.campo, el.value));
  });
}

function linhaItem(i) {
  const est = i.estilo ?? { estado: 'pronto', icone: '✓', rotulo: 'Pronto' };
  const alertas = (i.alertas ?? []).map((a) =>
    `<div class="alerta ${a.severidade}" title="${esc(a.detalhe)}">
       <span class="marca">${a.severidade === 'critico' ? '▲' : a.severidade === 'atencao' ? '●' : 'ⓘ'}</span>
       <span>${esc(a.titulo)}</span>
     </div>`).join('');

  const proc = selinhoProcedencia(i.procedencia);

  return `<tr class="estado-${est.estado}">
    <td class="num tiny">${i.n_item}</td>
    <td>
      ${esc(i.x_prod_original)}
      <span class="porque">cód. ${esc(i.c_prod ?? '—')}${i.c_ean ? ' · EAN ' + esc(i.c_ean) : ''}</span>
      ${alertas ? `<div class="alertas">${alertas}</div>` : ''}
    </td>
    <td class="mono tiny">${esc(i.ncm ?? '—')}</td>
    <td class="mono tiny">${esc(i.cfop_original)}</td>
    <td class="celula-edit">
      <input type="text" value="${esc(i.x_prod_novo ?? '')}" data-item="${i.id}" data-campo="descricao">
    </td>
    <td class="celula-edit">
      <input type="text" class="cfop" maxlength="4" value="${esc(i.cfop_novo ?? '')}"
             data-item="${i.id}" data-campo="cfop">
      ${proc}
      ${podeFixar(i) ? `<button class="btn sm sutil fixar" data-fixar="${i.id}"
         title="Faz deste CFOP o padrão deste produto deste fornecedor. Vale a partir da próxima nota, e já nasce confiável — sem esperar as próximas confirmações.">☆ é sempre assim</button>` : ''}
    </td>
    <td class="num">${moeda(i.valor_total)}</td>
    <td>
      <span class="selo selo-${est.estado}"><span class="ic">${est.icone}</span>${esc(est.rotulo)}</span>
      ${i.revisado ? `<span class="porque">${esc(quemConferiu(i))}</span>` : ''}
    </td>
    <td>
      ${i.revisado
        ? `<button class="btn sm sutil" data-desconferir="${i.id}" title="Voltar a marcar como pendente">desfazer</button>`
        : `<button class="btn sm ok" data-conferir="${i.id}">✓ Conferido</button>`}
    </td>
  </tr>`;
}

/**
 * Quando oferecer o "é sempre assim".
 *
 * So faz sentido com CFOP preenchido - fixar vazio nao fixa nada - e nao faz
 * sentido no que JA e padrao fixado, senao o botao vira enfeite que nao muda
 * nada quando clicado.
 *
 * O sistema ja aprende de toda correcao, sem botao nenhum. A diferenca aqui e
 * que a regra nasce VERDE: normalmente ela nasce amarela de proposito (ver uma
 * vez nao e saber) e so amadurece depois de algumas confirmacoes, o que na
 * pratica leva umas quatro notas. Este botao e a contadora dizendo "tenho
 * certeza" e pulando essa fila - decisao dela, nao do sistema.
 */
function podeFixar(i) {
  if (!pode('regras.fixar')) return false;
  if (!String(i.cfop_novo ?? '').trim()) return false;
  return i.procedencia?.fonte !== 'fixada';
}

/**
 * De onde veio o valor que está naquela linha.
 *
 * Isto NÃO é o estado da linha, e a diferença importa. O estado responde "isto
 * precisa de você?"; a procedência responde "quem pôs isto aqui?". São dois eixos,
 * e amarrá-los num só foi o que escondeu o trabalho da contadora: uma regra que ela
 * acabou de ensinar ainda nasce amarela de propósito (ver uma vez não é saber), e a
 * confiança do item só fica verde quando CFOP E descrição estão resolvidos. Na
 * prática isso é a QUARTA nota. Se a marca "veio de você" morasse dentro do estado,
 * ela quase nunca apareceria — e foi exatamente essa a queixa: "se tivesse um jeito
 * de ele ir aparecendo de outra cor o que eu já fiz".
 *
 * Por isso a marca aparece em toda linha, inclusive nas que ainda pedem conferência.
 */
function selinhoProcedencia(p) {
  const fonte = p?.fonte ?? 'nenhuma';
  if (fonte === 'fixada') {
    return `<span class="proc proc-fixada" title="Padrão que a contabilidade fixou para este fornecedor">📌 padrão seu</span>`;
  }
  if (fonte === 'aprendida') {
    const n = Number(p?.usos ?? 0);
    return `<span class="proc proc-aprendida" title="O sistema guardou isto de uma correção de vocês">✓ vocês ensinaram${n > 1 ? ` · ${n}x` : ''}</span>`;
  }
  if (fonte === 'manual') {
    return `<span class="proc proc-manual" title="Alguém digitou este valor nesta nota">✎ preenchido por vocês</span>`;
  }
  if (fonte === 'perfil') {
    return `<span class="proc proc-perfil" title="Ninguém ensinou este item ainda — o valor é palpite pelo perfil fiscal da empresa">● palpite do perfil</span>`;
  }
  return '';
}

/** "conferido por fulano, hoje 14:12" — quem assinou aquela linha. */
function quemConferiu(i) {
  const quem = i.revisado_por_nome ? ` por ${i.revisado_por_nome}` : '';
  const quando = i.revisado_em ? ' · ' + dataCurta(i.revisado_em) : '';
  return `conferido${quem}${quando}`;
}

async function salvarCampo(itemId, campo, valor) {
  try {
    await api(`/api/itens/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify({ mudancas: [{ campo, valor }] }),
    });
    avisarSalvo();
    await recarregarNota();
  } catch (e) {
    alerta(e.message);
  }
}

/**
 * Não existe botão "salvar" porque o sistema grava a cada alteração. Só que
 * gravar em silêncio é igual a não gravar, do ponto de vista de quem usa: a
 * contadora terminou quatro notas sem saber se tinha ficado salvo. Este aviso
 * é a diferença entre as duas coisas.
 */
let sumirAviso = null;
function avisarSalvo(texto = 'Salvo') {
  const el = $('#aviso-salvo');
  if (!el) return;
  el.textContent = '✓ ' + texto;
  el.classList.remove('hidden');
  clearTimeout(sumirAviso);
  sumirAviso = setTimeout(() => el.classList.add('hidden'), 2200);
}

/** Conferir = "olhei e concordo". Não muda valor nenhum; marca que houve gente. */
async function conferirItens(ids) {
  if (!estado.notaAberta || ids.length === 0) return;
  try {
    const r = await api(`/api/notas/${estado.notaAberta.nota.id}/conferir`, {
      method: 'POST',
      body: JSON.stringify({ itens: ids }),
    });
    avisarSalvo(r.conferidos === 1 ? '1 item conferido' : `${r.conferidos} itens conferidos`);
    await recarregarNota();
    await carregarNotas();
  } catch (e) {
    alerta(e.message);
  }
}

async function desconferirItem(id) {
  try {
    await api(`/api/itens/${id}/desconferir`, { method: 'POST' });
    avisarSalvo('Voltou para pendente');
    await recarregarNota();
    await carregarNotas();
  } catch (e) {
    alerta(e.message);
  }
}

async function recarregarNota() {
  if (!estado.notaAberta) return;
  estado.notaAberta = await api(`/api/notas/${estado.notaAberta.nota.id}`);
  renderItens();
}

document.addEventListener('click', (ev) => {
  const c = ev.target.closest('[data-conferir]');
  if (c) return conferirItens([c.dataset.conferir]);
  const d = ev.target.closest('[data-desconferir]');
  if (d) return desconferirItem(d.dataset.desconferir);
  const f = ev.target.closest('[data-fixar]');
  if (f) return fixarProduto(f.dataset.fixar);
});

/**
 * "É sempre assim": o CFOP daquela linha vira o padrão daquele produto.
 *
 * Escopo deliberadamente estreito - AQUELE produto, DAQUELE fornecedor. Nao
 * toca em nenhum outro item da nota, nao mexe no padrao do fornecedor inteiro,
 * e nao carimba tudo que compartilha o NCM. Quem quer o fornecedor inteiro tem
 * outro botao, com outro aviso.
 */
async function fixarProduto(itemId) {
  const i = (estado.notaAberta?.itens ?? []).find((x) => x.id === itemId);
  if (!i) return;
  const cfop = String(i.cfop_novo ?? '').trim();
  if (!cfop) return alerta('Preencha o CFOP antes de salvar como padrão.');

  const nome = i.x_prod_novo || i.x_prod_original || 'este produto';
  const ok = await confirmar({
    titulo: 'Salvar como padrão deste produto',
    ok: 'Salvar padrão',
    corpo: `
      <p class="dialogo-texto">O CFOP <b>${esc(cfop)}</b> passa a ser o padrão de:</p>
      <p class="dialogo-destaque">${esc(nome)}</p>
      <ul class="dialogo-lista">
        <li>Vale só para este produto <b>deste fornecedor</b></li>
        <li>A próxima nota já vem com ele preenchido</li>
        <li>Não altera nenhum outro item desta nota</li>
      </ul>`,
  });
  if (!ok) return;

  try {
    await api(`/api/itens/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify({ mudancas: [{ campo: 'cfop', valor: cfop }], fixar: true }),
    });
    avisarSalvo('Padrão salvo');
    await recarregarNota();
  } catch (e) {
    alerta('Não consegui salvar o padrão: ' + e.message);
  }
}

$('#btn-conferir-visiveis').addEventListener('click', () => {
  const pendentes = itensVisiveis().filter((i) => !i.revisado);
  if (pendentes.length === 0) return alerta('Tudo que está na tela já foi conferido.');
  conferirItens(pendentes.map((i) => i.id));
});

/**
 * Salvar o padrao de TODOS de uma vez - cada um com o SEU proprio CFOP.
 *
 * Nao confundir com "Fixar para o fornecedor", que aplica UM CFOP escolhido a
 * tudo que estiver na tela. Aqui nenhum valor muda: o que ja esta preenchido
 * vira padrao daquele produto. E o caminho normal numa nota grande - o leiaute
 * da NF-e admite ate 990 itens, e ninguem clica 990 vezes.
 *
 * Uma requisicao so. A versao obvia seria um laco de requisicoes aqui no
 * navegador, uma por item: minutos numa nota grande, e uma falha no meio deixa
 * metade feito sem ninguem saber.
 */
$('#btn-fixar-visiveis').addEventListener('click', async () => {
  if (!estado.notaAberta) return;
  const alvos = itensVisiveis().filter((i) => podeFixar(i));
  if (alvos.length === 0) {
    return alerta('Não há item para salvar: ou já são padrão, ou estão sem CFOP.');
  }

  const semCfop = itensVisiveis().filter((i) => !String(i.cfop_novo ?? '').trim()).length;
  const ok = await confirmar({
    titulo: 'Salvar o padrão de todos',
    ok: `Salvar ${alvos.length} padrão(ões)`,
    corpo: `
      <p class="dialogo-texto">
        <b>${alvos.length} item(ns)</b> terão o seu CFOP salvo como padrão daquele produto.
      </p>
      <ul class="dialogo-lista">
        <li>Cada item guarda o <b>seu próprio</b> CFOP — nenhum valor é alterado</li>
        <li>A partir da próxima nota deste fornecedor eles já vêm preenchidos</li>
        ${semCfop > 0 ? `<li>${semCfop} item(ns) sem CFOP serão pulados</li>` : ''}
      </ul>`,
  });
  if (!ok) return;

  try {
    const r = await api(`/api/notas/${estado.notaAberta.nota.id}/fixar-padrao`, {
      method: 'POST', body: JSON.stringify({ itens: alvos.map((i) => i.id) }),
    });
    avisarSalvo(`${r.fixados} padrão(ões) salvo(s)`);
    await recarregarNota();
  } catch (e) {
    alerta('Não consegui salvar os padrões: ' + e.message);
  }
});

$('#btn-bulk-nota').addEventListener('click', () => aplicarEmLote('item'));
$('#btn-bulk-fornecedor').addEventListener('click', () => aplicarEmLote('fornecedor'));

async function aplicarEmLote(escopo) {
  const cfop = $('#bulk-cfop').value;
  if (!cfop) return alerta('Escolha um CFOP na lista antes de aplicar.');
  if (!estado.notaAberta) return;

  const alvos = itensVisiveis();

  // A caixa antiga falava do padrao futuro e calava sobre o presente: o botao
  // TAMBEM sobrescreve o CFOP de todos os itens visiveis. Numa nota com CFOPs
  // misturados isso achata tudo, e quem clicou nao foi avisado.
  if (escopo === 'fornecedor') {
    const mudam = alvos.filter((i) => String(i.cfop_novo ?? '').trim() !== cfop);
    const ok = await confirmar({
      titulo: 'Fixar o padrão do fornecedor',
      ok: 'Fixar padrão',
      perigo: true,
      corpo: `
        <p class="dialogo-texto">
          O CFOP <b>${esc(cfop)}</b> passa a ser o padrão deste fornecedor nesta empresa.
        </p>
        <ul class="dialogo-lista">
          <li>Vale para <b>qualquer produto dele</b>, inclusive os que ainda não apareceram</li>
          ${mudam.length > 0
            ? `<li class="dialogo-atencao">E <b>troca o CFOP de ${mudam.length} item(ns)</b> que estão na tela agora</li>`
            : '<li>Nenhum item da tela muda de valor — todos já estão com este CFOP</li>'}
        </ul>
        ${mudam.length > 0 ? `<p class="dialogo-texto sutil">${
          mudam.slice(0, 4).map((i) => `${esc(String(i.x_prod_original).slice(0, 34))} · ${esc(i.cfop_novo || '—')} → ${esc(cfop)}`).join('<br>')
        }${mudam.length > 4 ? `<br>e mais ${mudam.length - 4}…` : ''}</p>` : ''}`,
    });
    if (!ok) return;
  }

  for (const i of alvos) {
    await api(`/api/itens/${i.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        mudancas: [{ campo: 'cfop', valor: cfop }],
        escopo,
        fixar: escopo === 'fornecedor',
      }),
    });
  }
  await recarregarNota();
}

// ------------------------------------------------------------------ ambiente 3

async function renderXml() {
  const n = estado.notaAberta;
  if (!n) return;

  const validacoes = $('#lista-validacoes');
  const r = n.resumo;
  const bloqueios = n.itens.flatMap((i) => (i.alertas ?? []).filter((a) => a.bloqueia));

  validacoes.innerHTML = [
    linhaCheck(!r.bloqueiaExportacao, 'Todos os itens têm CFOP de entrada'),
    linhaCheck(r.criticos === 0, `Itens com divergência crítica: ${r.criticos}`),
    linhaCheck(true, 'XML original preservado, sem alteração'),
    linhaCheck(true, 'CST/CSOSN e bloco IBS/CBS não são tocados'),
    linhaCheck(true, 'Totais e chave de acesso conferidos na exportação'),
  ].join('') + (bloqueios.length
    ? `<li class="tiny" style="color:var(--danger)">${bloqueios.length} item(ns) bloqueando a exportação.</li>`
    : '');

  const prod = n.itens.slice(0, 6).map((i) =>
    `  Item ${i.n_item}\n    <mark>&lt;xProd&gt;${esc(i.x_prod_novo ?? i.x_prod_original)}&lt;/xProd&gt;</mark>\n` +
    `    <mark>&lt;CFOP&gt;${esc(i.cfop_novo ?? i.cfop_original)}&lt;/CFOP&gt;</mark>   (original: ${esc(i.cfop_original)})`
  ).join('\n');

  $('#previa-xml').innerHTML =
    `Chave  ${esc(n.nota.chave)}\nNota   ${esc(n.nota.numero)} · ${esc(n.nota.emit_nome ?? '')}\n` +
    `Itens  ${n.itens.length}\n\n${prod}` +
    (n.itens.length > 6 ? `\n\n  … e mais ${n.itens.length - 6} item(ns)` : '') +
    `\n\nBaixe o arquivo para ver o XML completo.`;
}

const linhaCheck = (ok, txt) =>
  `<li><span class="${ok ? 'ok' : 'fail'}">${ok ? '✓' : '✕'}</span> ${esc(txt)}</li>`;

$('#btn-baixar-xml').addEventListener('click', async () => {
  if (!estado.notaAberta) return alerta('Selecione uma nota.');
  await baixar(`/api/notas/${estado.notaAberta.nota.id}/xml-corrigido`);
});

$('#btn-baixar-csv').addEventListener('click', async () => {
  if (!estado.notaAberta) return alerta('Selecione uma nota.');
  await baixar(`/api/notas/${estado.notaAberta.nota.id}/escrituracao.csv`);
});

async function baixar(url) {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) {
    const erro = await r.json().catch(() => ({ erro: 'falhou' }));
    const detalhe = (erro.falhas ?? []).map((f) => `• ${f.nome}${f.detalhe ? ' — ' + f.detalhe : ''}`).join('\n');
    return alerta((erro.erro ?? 'falhou') + (detalhe ? '\n\n' + detalhe : ''));
  }
  const nome = (r.headers.get('Content-Disposition') ?? '').match(/filename="([^"]+)"/)?.[1] ?? 'arquivo';
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nome;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ------------------------------------------------------------------ empresas

function renderEmpresas() {
  $('#tbl-empresas tbody').innerHTML = estado.empresas.map((e) => `<tr>
    <td class="mono">${esc(e.cnpj)}</td>
    <td><button class="link-tabela" data-abrir-empresa="${esc(e.id)}">${esc(e.razao_social)}</button></td>
    <td>${esc(e.uf ?? '—')}</td>
    <td><span class="tag info">${esc(e.perfil)}</span></td>
    <td class="mono tiny">${esc(e.cnae_principal ?? '—')}</td>
    <td class="acoes">
      ${pode('empresas.editar')
        ? `<button class="btn sm" data-abrir-empresa="${esc(e.id)}">Abrir</button>` : ''}
      ${pode('empresas.apagar')
        ? `<button class="btn sm perigo" data-apagar-empresa="${esc(e.id)}">Apagar</button>` : ''}
    </td>
  </tr>`).join('') || '<tr><td colspan="6" class="vazio">Nenhuma empresa cadastrada.</td></tr>';

  $$('#tbl-empresas button[data-apagar-empresa]').forEach((b) =>
    b.addEventListener('click', () => apagarEmpresa(b.dataset.apagarEmpresa)));

  $$('#tbl-empresas button[data-abrir-empresa]').forEach((b) =>
    b.addEventListener('click', () =>
      formularioEmpresa(estado.empresas.find((x) => x.id === b.dataset.abrirEmpresa))));
}

/**
 * Apagar empresa leva junto notas, itens, XMLs, regras e fornecedores dela.
 * Por isso pede o CNPJ digitado: é a diferença entre um clique errado e uma
 * decisão. O servidor confere de novo — a tela não é a guarda.
 */
function apagarEmpresa(id) {
  const e = estado.empresas.find((x) => x.id === id);
  abrirModal('Apagar cliente', `
    <p>Apagar <b>${esc(e?.razao_social ?? '')}</b> e <b>tudo</b> que pertence a ele:
      notas, itens, XMLs arquivados, regras aprendidas e fornecedores.</p>
    <p class="porque">Não dá para desfazer. Se a intenção é só parar de usar,
      desative o cliente em vez de apagar.</p>
    <label class="fl" style="margin-top:11px">Digite o CNPJ para confirmar</label>
    <input type="text" id="apagar-cnpj" placeholder="${esc(e?.cnpj ?? '')}" style="width:100%">
  `, async () => {
    const digitado = ($('#apagar-cnpj').value || '').replace(/\D/g, '');
    if (digitado !== (e?.cnpj ?? '')) throw new Error('o CNPJ digitado não confere');
    await api(`/api/empresas/${id}?confirmar=${digitado}`, { method: 'DELETE' });
    await carregarEmpresas();
    await carregarNotas();
  });
  $('#modal-ok').textContent = 'Apagar';
  $('#modal-ok').classList.add('perigo');
}

$('#btn-nova-empresa').addEventListener('click', () => formularioEmpresa(null));

/**
 * Cadastro de cliente — o mesmo formulário para criar e para corrigir.
 *
 * Faltava a parte de corrigir: a tela listava o cliente e só deixava apagar.
 * Quem errasse o perfil fiscal no cadastro tinha que apagar a empresa inteira,
 * com notas e regras junto, para cadastrar de novo. E as permissões
 * `empresas.editar` e `empresas.desativar` existiam sem caminho na tela.
 */
function formularioEmpresa(empresa) {
  const novo = !empresa;
  abrirModal(novo ? 'Nova empresa' : `Cliente: ${empresa.razao_social}`, `
    <div class="rowflex">
      <div style="flex:1"><label class="fl">CNPJ</label>
        <input type="text" id="e-cnpj" style="width:100%" value="${esc(empresa?.cnpj ?? '')}"
               ${novo ? '' : 'disabled title="O CNPJ identifica o cliente e as notas dele — não muda"'}></div>
      <div style="width:80px"><label class="fl">UF</label>
        <input type="text" id="e-uf" maxlength="2" style="width:100%" value="${esc(empresa?.uf ?? '')}"></div>
    </div>
    <div style="margin-top:11px"><label class="fl">Razão social</label>
      <input type="text" id="e-razao" style="width:100%" value="${esc(empresa?.razao_social ?? '')}"></div>
    <div style="margin-top:11px"><label class="fl">CNAE principal</label>
      <input type="text" id="e-cnae" placeholder="47.11-3/02" style="width:100%"
             value="${esc(empresa?.cnae_principal ?? '')}"></div>
    <div id="e-sugestao" class="aviso hidden"></div>
    <div style="margin-top:11px"><label class="fl">Perfil fiscal</label>
      <select id="e-perfil" style="width:100%">
        ${[['revenda', 'Comércio — revenda'],
           ['industrializacao', 'Indústria — insumo'],
           ['uso_consumo', 'Uso e consumo / serviços']]
          .map(([v, r]) => `<option value="${v}" ${empresa?.perfil === v ? 'selected' : ''}>${r}</option>`)
          .join('')}
      </select></div>
    <p class="tiny" style="margin-top:10px">O perfil define o CFOP sugerido enquanto o produto
      não tem padrão próprio. A partir da primeira nota tratada, o aprendizado passa por cima disso.</p>
  `, async () => {
    const cnpj = $('#e-cnpj').value.replace(/\D/g, '');
    if (novo && cnpj.length !== 14) throw new Error('CNPJ precisa ter 14 dígitos');
    if ($('#e-razao').value.trim().length < 2) throw new Error('informe a razão social');

    if (novo) {
      await api('/api/empresas', {
        method: 'POST',
        body: JSON.stringify({
          cnpj,
          razaoSocial: $('#e-razao').value.trim(),
          uf: $('#e-uf').value.toUpperCase() || null,
          perfil: $('#e-perfil').value,
          cnaePrincipal: $('#e-cnae').value.trim() || null,
        }),
      });
    } else {
      // O CNPJ fica de fora de propósito: ele é a identidade do cliente e das
      // notas dele. Trocar o CNPJ é outro cliente, não uma correção.
      await api(`/api/empresas/${empresa.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          razao_social: $('#e-razao').value.trim(),
          uf: $('#e-uf').value.toUpperCase() || null,
          perfil: $('#e-perfil').value,
          cnae_principal: $('#e-cnae').value.trim() || null,
        }),
      });
      avisarSalvo('Cliente atualizado');
    }
    await carregarEmpresas();
    renderEmpresas();
  });

  // Pré-preenchimento pelo CNAE, como pedido: o cadastro já vem sugerido.
  $('#e-cnae').addEventListener('blur', async () => {
    const cnae = $('#e-cnae').value.trim();
    if (!cnae) return;
    try {
      const r = await api('/api/empresas/sugestao', {
        method: 'POST',
        body: JSON.stringify({ cnaePrincipal: cnae, cnaesSecundarios: [] }),
      });
      $('#e-perfil').value = r.sugestao.perfil;
      const box = $('#e-sugestao');
      box.innerHTML = esc(r.sugestao.justificativa) + (r.alerta ? `<br><br><b>${esc(r.alerta)}</b>` : '');
      box.classList.remove('hidden');
    } catch {}
  });
}

/* ---------------------------------------------------------------- administração
 *
 * Duas telas: quem entra (Usuários) e o que cada conjunto de gente pode (Papéis).
 * O papel resolve quase tudo; a exceção por pessoa existe porque o resto é gente.
 */

let catalogoPermissoes = null;   // { grupo: [{chave, descricao, podeConceder}] }
let papeisCache = [];

async function catalogo() {
  if (!catalogoPermissoes) catalogoPermissoes = await api('/api/permissoes');
  return catalogoPermissoes;
}

/**
 * Monta as caixinhas agrupadas por tela.
 * `excecoes` é um Map permissao -> true/false, usado só na tela de usuário:
 * ali a caixinha mostra o que o PAPEL dá, e a marcação do usuário por cima.
 */
function montarCaixinhas(grupos, marcadas, { doPapel = null, prefixo = 'perm' } = {}) {
  return Object.entries(grupos).map(([grupo, itens]) => `
    <div class="perm-grupo">
      <h4>${esc(grupo)}</h4>
      ${itens.map((it) => {
        const herdada = doPapel ? doPapel.has(it.chave) : false;
        const marcada = marcadas.has(it.chave);
        let classe = '';
        if (doPapel) {
          if (marcada && !herdada) classe = 'excecao-mais';
          else if (!marcada && herdada) classe = 'excecao-menos';
        }
        if (!it.podeConceder) classe += ' bloqueada';
        return `
        <label class="perm-item ${classe}">
          <input type="checkbox" data-perm="${esc(it.chave)}" id="${prefixo}-${esc(it.chave)}"
            ${marcada ? 'checked' : ''} ${it.podeConceder ? '' : 'disabled'}>
          <span>${esc(it.descricao)}
            ${doPapel && herdada ? '<span class="d">— vem do papel</span>' : ''}
            ${it.podeConceder ? '' : '<span class="d">— você não tem esta permissão</span>'}
          </span>
        </label>`;
      }).join('')}
    </div>`).join('');
}

const permsMarcadas = () =>
  [...$$('#modal-corpo input[data-perm]')].filter((i) => i.checked).map((i) => i.dataset.perm);

/* ----------------------------------------------------------------- papéis */

async function carregarPapeis() {
  papeisCache = await api('/api/papeis');
  const podeEditar = estado.eu.permissoes.includes('papeis.gerenciar');
  $('#tbl-papeis tbody').innerHTML = papeisCache.map((p) => `<tr>
    <td><b>${esc(p.nome)}</b>${p.sistema ? ' <span class="d">(sistema)</span>' : ''}</td>
    <td>${esc(p.descricao ?? '')}</td>
    <td class="num">${p.n_permissoes}</td>
    <td class="num">${p.n_usuarios}</td>
    <td>${podeEditar && !p.sistema
      ? `<button class="btn sm" data-papel="${esc(p.id)}">Editar</button>`
      : '<span class="d">—</span>'}</td>
  </tr>`).join('') || '<tr><td colspan="5" class="vazio">Nenhum papel.</td></tr>';

  for (const b of $$('#tbl-papeis button[data-papel]')) {
    b.addEventListener('click', () => editarPapel(papeisCache.find((x) => x.id === b.dataset.papel)));
  }
}

async function editarPapel(papel) {
  const grupos = await catalogo();
  const marcadas = new Set(papel ? papel.permissoes : []);
  abrirModal(papel ? `Papel: ${papel.nome}` : 'Novo papel', `
    <div class="campo">
      <label class="fl" for="pp-nome">Nome</label>
      <input type="text" id="pp-nome" maxlength="40" value="${esc(papel?.nome ?? '')}"
             placeholder="Fiscal Jr, Só leitura, Estagiário...">
    </div>
    <div class="campo">
      <label class="fl" for="pp-desc">Para que serve</label>
      <input type="text" id="pp-desc" maxlength="200" value="${esc(papel?.descricao ?? '')}">
    </div>
    <p class="page-desc">Marque o que este papel pode fazer. O que estiver esmaecido é
      permissão que <b>você</b> não tem — ninguém concede o que não possui.</p>
    ${montarCaixinhas(grupos, marcadas, { prefixo: 'pp' })}
  `, async () => {
    const corpo = {
      nome: $('#pp-nome').value.trim(),
      descricao: $('#pp-desc').value.trim() || null,
      permissoes: permsMarcadas(),
    };
    if (corpo.nome.length < 2) throw new Error('dê um nome ao papel');
    await api(papel ? `/api/papeis/${papel.id}` : '/api/papeis', {
      method: papel ? 'PUT' : 'POST', body: JSON.stringify(corpo),
    });
    await carregarPapeis();
  });
}

$('#btn-novo-papel').addEventListener('click', () => editarPapel(null).catch((e) => alerta(e.message)));

/* --------------------------------------------------------------- usuários */

/**
 * Convites em aberto, e o botão de revogar.
 *
 * A tela gerava o link e esquecia dele. Um convite de Admin que vaze — grupo
 * errado do WhatsApp, e-mail reencaminhado — valia até vencer sozinho, sem
 * como cortar. Gerar sem revogar é meia funcionalidade.
 *
 * O código nunca aparece aqui: o banco guarda só o hash. Convite perdido se
 * gera de novo, não se recupera.
 */
async function carregarConvites() {
  const card = $('#card-convites');
  if (!card) return;
  if (!pode('usuarios.convidar')) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');

  const cs = await api('/api/convites');
  const abertos = cs.filter((c) => !c.revogado && !c.vencido && c.usos < c.usos_max);
  const situacao = (c) =>
    c.revogado ? '<span class="tag dan">revogado</span>'
    : c.vencido ? '<span class="tag mut">vencido</span>'
    : c.usos >= c.usos_max ? '<span class="tag mut">todo usado</span>'
    : '<span class="tag ok">válido</span>';

  $('#tbl-convites tbody').innerHTML = cs.map((c) => `<tr${c.revogado || c.vencido ? ' style="opacity:.55"' : ''}>
    <td>${esc(c.papel ?? '—')}</td>
    <td class="mono tiny">${c.usos} de ${c.usos_max}</td>
    <td class="tiny">${dataCurta(c.expira_em)}</td>
    <td>${situacao(c)}</td>
    <td class="acoes">${abertos.includes(c)
      ? `<button class="btn sm perigo" data-revogar="${esc(c.id)}">Revogar</button>` : ''}</td>
  </tr>`).join('') || '<tr><td colspan="5" class="vazio">Nenhum convite gerado.</td></tr>';

  $$('#tbl-convites button[data-revogar]').forEach((b) =>
    b.addEventListener('click', async () => {
      const ok = await confirmar({
        titulo: 'Revogar convite',
        ok: 'Revogar',
        perigo: true,
        corpo: '<p class="dialogo-texto">Quem tiver o link para de conseguir entrar por ele.</p>',
      });
      if (!ok) return;
      try {
        await api(`/api/convites/${b.dataset.revogar}`, { method: 'DELETE' });
        avisarSalvo('Convite revogado');
        await carregarConvites();
      } catch (e) { alerta(e.message); }
    }));
}

async function carregarUsuarios() {
  const us = await api('/api/usuarios');
  carregarConvites().catch(() => {});
  const podeEditar = estado.eu.permissoes.includes('usuarios.editar');
  const podeDesativar = estado.eu.permissoes.includes('usuarios.desativar');
  const podeSenha = estado.eu.permissoes.includes('usuarios.redefinir_senha');
  const podeMfa = estado.eu.permissoes.includes('usuarios.desativar_mfa');

  const podeAprovar = estado.eu.permissoes.includes('usuarios.aprovar');
  const pendentes = us.filter((u) => u.pendente).length;
  const pediramSenha = us.filter((u) => u.pediuSenha).length;
  const avisos = [];
  if (pendentes) {
    avisos.push(pendentes === 1
      ? '1 pessoa pediu acesso e está esperando liberação.'
      : `${pendentes} pessoas pediram acesso e estão esperando liberação.`);
  }
  if (pediramSenha) {
    avisos.push(pediramSenha === 1
      ? '1 pessoa esqueceu a senha e está esperando uma provisória.'
      : `${pediramSenha} pessoas esqueceram a senha e estão esperando uma provisória.`);
  }
  $('#aviso-pendentes').classList.toggle('hidden', avisos.length === 0);
  $('#aviso-pendentes').textContent = avisos.join(' ');

  $('#tbl-usuarios tbody').innerHTML = us.map((u) => `<tr${u.pendente || u.pediuSenha ? ' class="linha-pendente"' : (u.ativo ? '' : ' style="opacity:.55"')}>
    <td><b>${esc(u.nome)}</b></td>
    <td>${esc(u.email)}</td>
    <td>${esc(u.papel ?? '—')}</td>
    <td>${u.excecoes > 0 ? `${u.excecoes} ajuste(s)` : '<span class="d">—</span>'}</td>
    <td>${u.mfa ? '✓ ligado' : '<span class="d">não</span>'}</td>
    <td>${u.ultimo_login ? new Date(u.ultimo_login).toLocaleDateString('pt-BR') : '<span class="d">nunca</span>'}</td>
    <td>${u.pendente ? '<b>esperando liberação</b>'
      : u.pediuSenha ? '<b>esqueceu a senha</b>'
      : (u.ativo ? 'ativo' : 'desativado')}${u.deveTrocarSenha ? ' <span class="d">(senha provisória)</span>' : ''}</td>
    <td style="white-space:nowrap">
      ${u.pendente && podeAprovar ? `<button class="btn primary sm" data-aprovar="${esc(u.id)}">Liberar</button>
        <button class="btn sm" data-recusar="${esc(u.id)}">Recusar</button>` : ''}
      ${!u.pendente && podeEditar ? `<button class="btn sm" data-editar="${esc(u.id)}">Editar</button>` : ''}
      ${!u.pendente && podeSenha ? `<button class="btn ${u.pediuSenha ? 'primary ' : ''}sm" data-senha="${esc(u.id)}">Senha</button>` : ''}
      ${!u.pendente && podeDesativar ? `<button class="btn sm" data-ativo="${esc(u.id)}" data-para="${u.ativo ? '0' : '1'}">${u.ativo ? 'Desativar' : 'Reativar'}</button>` : ''}
      ${!u.pendente && u.mfa && podeMfa ? `<button class="btn sm" data-mfa="${esc(u.id)}"
        title="Para quem trocou de celular e ficou trancado para fora">Desligar 2º fator</button>` : ''}
    </td>
  </tr>`).join('') || '<tr><td colspan="8" class="vazio">Nenhum usuário.</td></tr>';

  for (const b of $$('#tbl-usuarios button[data-editar]')) {
    b.addEventListener('click', () => editarUsuario(b.dataset.editar).catch((e) => alerta(e.message)));
  }
  for (const b of $$('#tbl-usuarios button[data-aprovar]')) {
    b.addEventListener('click', () => aprovarPedido(b.dataset.aprovar).catch((e) => alerta(e.message)));
  }
  for (const b of $$('#tbl-usuarios button[data-recusar]')) {
    b.addEventListener('click', async () => {
      const ok = await confirmar({
        titulo: 'Recusar pedido de acesso',
        ok: 'Recusar',
        perigo: true,
        corpo: '<p class="dialogo-texto">A conta é apagada. A pessoa pode pedir acesso de novo.</p>',
      });
      if (!ok) return;
      try {
        await api(`/api/usuarios/${b.dataset.recusar}/recusar`, { method: 'POST' });
        await carregarUsuarios();
      } catch (e) { alerta(e.message); }
    });
  }
  // Trocar de celular sem desligar o segundo fator antes tranca a pessoa para
  // fora, e não havia caminho nenhum para destravar — a permissão existia, o
  // botão não.
  for (const b of $$('#tbl-usuarios button[data-mfa]')) {
    b.addEventListener('click', async () => {
      const ok = await confirmar({
        titulo: 'Desligar o segundo fator',
        ok: 'Desligar',
        perigo: true,
        corpo: `
          <p class="dialogo-texto">Ela volta a entrar só com e-mail e senha.</p>
          <p class="dialogo-texto sutil">Use quando a pessoa trocou de celular e ficou trancada
          para fora. Ela precisa configurar o segundo fator de novo depois.</p>`,
      });
      if (!ok) return;
      try {
        await api(`/api/usuarios/${b.dataset.mfa}/desativar-mfa`, { method: 'POST' });
        await carregarUsuarios();
      } catch (e) { alerta(e.message); }
    });
  }

  for (const b of $$('#tbl-usuarios button[data-senha]')) {
    b.addEventListener('click', () => redefinirSenhaDe(b.dataset.senha).catch((e) => alerta(e.message)));
  }
  for (const b of $$('#tbl-usuarios button[data-ativo]')) {
    b.addEventListener('click', async () => {
      const ativar = b.dataset.para === '1';
      const ok = await confirmar({
        titulo: ativar ? 'Reativar usuário' : 'Desativar usuário',
        ok: ativar ? 'Reativar' : 'Desativar',
        perigo: !ativar,
        corpo: ativar
          ? '<p class="dialogo-texto">A pessoa volta a conseguir entrar.</p>'
          : '<p class="dialogo-texto">As sessões dela caem na hora, em todos os aparelhos.</p>',
      });
      if (!ok) return;
      try {
        await api(`/api/usuarios/${b.dataset.ativo}/ativo`, {
          method: 'POST', body: JSON.stringify({ ativo: ativar }),
        });
        await carregarUsuarios();
      } catch (e) { alerta(e.message); }
    });
  }
}

async function editarUsuario(id) {
  const grupos = await catalogo();
  if (!papeisCache.length) papeisCache = await api('/api/papeis');
  const u = id ? await api(`/api/usuarios/${id}`) : null;
  const empresas = estado.empresas ?? [];

  const papelSelecionado = () => papeisCache.find((p) => p.id === $('#us-papel').value);

  abrirModal(u ? `Usuário: ${u.nome}` : 'Novo usuário', `
    <div class="campo">
      <label class="fl" for="us-nome">Nome</label>
      <input type="text" id="us-nome" value="${esc(u?.nome ?? '')}">
    </div>
    <div class="campo">
      <label class="fl" for="us-email">E-mail</label>
      <input type="email" id="us-email" value="${esc(u?.email ?? '')}" ${u ? 'disabled' : ''}>
      ${u ? '<span class="d">o e-mail identifica a conta e não muda</span>' : ''}
    </div>
    <div class="campo">
      <label class="fl" for="us-papel">Papel</label>
      <select id="us-papel">
        ${papeisCache.map((p) => `<option value="${esc(p.id)}" ${u?.papelId === p.id ? 'selected' : ''}>${esc(p.nome)}</option>`).join('')}
      </select>
    </div>
    <div class="campo">
      <label class="fl">Clientes que esta pessoa enxerga</label>
      ${empresas.length === 0 ? '<span class="d">nenhuma empresa cadastrada ainda</span>'
        : empresas.map((e) => `
        <label class="perm-item">
          <input type="checkbox" data-empresa="${esc(e.id)}" ${u?.empresas?.includes(e.id) ? 'checked' : ''}>
          <span>${esc(e.razao_social)}</span>
        </label>`).join('')}
      <p class="page-desc">Nenhum marcado: a pessoa só vê tudo se o papel dela tiver
        “ver TODOS os clientes”. Senão, não vê nada — e isso é proposital.</p>
    </div>
    <h3 style="margin:1rem 0 .4rem;font-size:.9rem">Ajustes só para esta pessoa</h3>
    <p class="page-desc">Verde = a mais do que o papel dá. Vermelho = tirado do papel.
      Se estiver mexendo muito aqui, provavelmente falta um papel novo.</p>
    <div id="us-perms"></div>
  `, async () => {
    const corpo = {
      nome: $('#us-nome').value.trim(),
      papelId: $('#us-papel').value,
      empresas: [...$$('#modal-corpo input[data-empresa]')].filter((i) => i.checked).map((i) => i.dataset.empresa),
      excecoes: [],
    };
    // A exceção é a DIFERENÇA entre o que está marcado e o que o papel dá.
    // Guardar a lista inteira faria a pessoa parar de acompanhar mudanças no
    // papel dela — que é justamente o motivo de o papel existir.
    const doPapel = new Set(papelSelecionado()?.permissoes ?? []);
    for (const i of $$('#modal-corpo input[data-perm]')) {
      const p = i.dataset.perm;
      if (i.checked && !doPapel.has(p)) corpo.excecoes.push({ permissao: p, concedida: true });
      if (!i.checked && doPapel.has(p)) corpo.excecoes.push({ permissao: p, concedida: false });
    }
    if (corpo.nome.length < 2) throw new Error('informe o nome');

    if (u) {
      await api(`/api/usuarios/${u.id}`, { method: 'PUT', body: JSON.stringify(corpo) });
      alerta('Salvo. As sessões desta pessoa foram encerradas para a mudança valer agora.');
    } else {
      corpo.email = $('#us-email').value.trim();
      const r = await api('/api/usuarios', { method: 'POST', body: JSON.stringify(corpo) });
      mostrarSenhaProvisoria(r.email, r.senhaProvisoria);
    }
    await carregarUsuarios();
  });

  // Redesenha as caixinhas quando o papel muda: o efeito de trocar de papel
  // tem de ser visível ANTES de salvar.
  const desenhar = () => {
    const doPapel = new Set(papelSelecionado()?.permissoes ?? []);
    const marcadas = new Set(doPapel);
    for (const e of (u?.excecoes ?? [])) {
      if (e.concedida) marcadas.add(e.permissao); else marcadas.delete(e.permissao);
    }
    $('#us-perms').innerHTML = montarCaixinhas(grupos, marcadas, { doPapel, prefixo: 'us' });
  };
  desenhar();
  $('#us-papel').addEventListener('change', desenhar);
}

/**
 * Liberar um pedido é a mesma decisão de criar um usuário — quem entra e com que
 * poder — então a tela é a mesma: papel, clientes e ajustes. A diferença é que a
 * senha já existe: quem se cadastrou escolheu a dela.
 */
async function aprovarPedido(id) {
  const grupos = await catalogo();
  if (!papeisCache.length) papeisCache = await api('/api/papeis');
  const u = await api(`/api/usuarios/${id}`);
  const empresas = estado.empresas ?? [];
  const papelSelecionado = () => papeisCache.find((p) => p.id === $('#ap-papel').value);

  abrirModal(`Liberar acesso de ${u.nome}`, `
    <p class="page-desc"><b>${esc(u.email)}</b> pediu acesso e escolheu a própria senha.
      Defina o papel e o que ela enxerga.</p>
    <div class="campo">
      <label class="fl" for="ap-papel">Papel</label>
      <select id="ap-papel">
        ${papeisCache.map((p) => `<option value="${esc(p.id)}">${esc(p.nome)}</option>`).join('')}
      </select>
    </div>
    <div class="campo">
      <label class="fl">Clientes que esta pessoa enxerga</label>
      ${empresas.length === 0 ? '<span class="d">nenhuma empresa cadastrada ainda</span>'
        : empresas.map((e) => `
        <label class="perm-item">
          <input type="checkbox" data-empresa="${esc(e.id)}"><span>${esc(e.razao_social)}</span>
        </label>`).join('')}
    </div>
    <h3 style="margin:1rem 0 .4rem;font-size:.9rem">Ajustes só para esta pessoa</h3>
    <div id="ap-perms"></div>
  `, async () => {
    const doPapel = new Set(papelSelecionado()?.permissoes ?? []);
    const excecoes = [];
    for (const i of $$('#modal-corpo input[data-perm]')) {
      const p = i.dataset.perm;
      if (i.checked && !doPapel.has(p)) excecoes.push({ permissao: p, concedida: true });
      if (!i.checked && doPapel.has(p)) excecoes.push({ permissao: p, concedida: false });
    }
    await api(`/api/usuarios/${id}/aprovar`, {
      method: 'POST',
      body: JSON.stringify({
        papelId: $('#ap-papel').value,
        empresas: [...$$('#modal-corpo input[data-empresa]')].filter((i) => i.checked).map((i) => i.dataset.empresa),
        excecoes,
      }),
    });
    await carregarUsuarios();
  });
  $('#modal-ok').textContent = 'Liberar';

  const desenhar = () => {
    const doPapel = new Set(papelSelecionado()?.permissoes ?? []);
    $('#ap-perms').innerHTML = montarCaixinhas(grupos, new Set(doPapel), { doPapel, prefixo: 'ap' });
  };
  desenhar();
  $('#ap-papel').addEventListener('change', desenhar);
}

function mostrarSenhaProvisoria(email, senha) {
  setTimeout(() => {
    abrirModal('Usuário criado', `
      <p class="page-desc">Passe esta senha para <b>${esc(email)}</b>. Ela é provisória:
        a pessoa é obrigada a trocá-la no primeiro acesso, e a partir daí nem você
        sabe qual é.</p>
      <div class="senha-provisoria">${esc(senha)}</div>
      <p class="page-desc"><b>Não aparece de novo.</b> Se perder, use o botão “Senha”
        na lista para gerar outra.</p>
    `, async () => {});
    $('#modal-cancelar').classList.add('hidden');
    $('#modal-ok').textContent = 'Copiei';
  }, 30);
}

async function redefinirSenhaDe(id) {
  const u = await api(`/api/usuarios/${id}`);
  abrirModal(`Redefinir a senha de ${u.nome}`, `
    <p class="page-desc">A pessoa vai receber uma senha provisória e será obrigada a
      trocá-la no primeiro acesso. As sessões dela caem agora.</p>
    <div class="campo">
      <label class="fl" for="rs-nova">Senha provisória</label>
      <input type="text" id="rs-nova" value="${esc(gerarSenhaProvisoria())}">
      <span class="d">pode editar; mínimo 12 caracteres</span>
    </div>
    <div class="campo">
      <label class="fl" for="rs-minha">Confirme a SUA senha</label>
      <input type="password" id="rs-minha" autocomplete="current-password">
      <span class="d">redefinir a senha de outra pessoa dá acesso à conta dela</span>
    </div>
  `, async () => {
    await api(`/api/usuarios/${id}/redefinir-senha`, {
      method: 'POST',
      body: JSON.stringify({
        senhaProvisoria: $('#rs-nova').value, minhaSenha: $('#rs-minha').value,
      }),
    });
    const senha = $('#rs-nova').value;
    mostrarSenhaProvisoria(u.email, senha);
    await carregarUsuarios();
  });
}

function gerarSenhaProvisoria() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return [...crypto.getRandomValues(new Uint8Array(14))].map((b) => A[b % A.length]).join('');
}

async function gerarConvite() {
  if (!papeisCache.length) papeisCache = await api('/api/papeis');
  abrirModal('Gerar convite', `
    <p class="page-desc">Quem abrir este link entra <b>na hora</b>, já com o papel escolhido —
      ninguém precisa aprovar. Mande no grupo do escritório.</p>
    <div class="campo">
      <label class="fl" for="cv-papel">Papel de quem entrar</label>
      <select id="cv-papel">
        ${papeisCache.map((p) => `<option value="${esc(p.id)}">${esc(p.nome)}</option>`).join('')}
      </select>
    </div>
    <div class="rowflex">
      <div style="flex:1"><label class="fl" for="cv-usos">Quantas pessoas podem usar</label>
        <input type="number" id="cv-usos" value="3" min="1" max="50" style="width:100%"></div>
      <div style="flex:1"><label class="fl" for="cv-horas">Vale por (horas)</label>
        <input type="number" id="cv-horas" value="72" min="1" max="720" style="width:100%"></div>
    </div>
    <p class="page-desc">O prazo e o limite de usos existem para o link não virar porta
      permanente. Se sobrar convite sem usar, ele vence sozinho.</p>
  `, async () => {
    const r = await api('/api/convites', {
      method: 'POST',
      body: JSON.stringify({
        papelId: $('#cv-papel').value,
        usos: Number($('#cv-usos').value),
        horas: Number($('#cv-horas').value),
      }),
    });
    mostrarConvite(r);
  });
  $('#modal-ok').textContent = 'Gerar';
}

function mostrarConvite(r) {
  carregarConvites().catch(() => {});
  const link = `${location.origin}/?convite=${encodeURIComponent(r.codigo)}`;
  setTimeout(() => {
    abrirModal('Convite gerado', `
      <p class="page-desc">Mande este link para até <b>${r.usos} pessoa(s)</b>. Quem abrir
        entra como <b>${esc(r.papel)}</b>, sem passar por aprovação. Vale ${r.horas} horas.</p>
      <div class="senha-provisoria" style="font-size:.9rem">${esc(link)}</div>
      <p class="page-desc">Se preferir passar só o código: <b>${esc(r.codigo)}</b></p>
      <p class="page-desc"><b>Não aparece de novo</b> — no banco fica só o embaralhado dele.
        Convite perdido se gera outro.</p>
    `, async () => {});
    $('#modal-cancelar').classList.add('hidden');
    $('#modal-ok').textContent = 'Copiei';
  }, 30);
}

$('#btn-convidar').addEventListener('click', () => gerarConvite().catch((e) => alerta(e.message)));

$('#btn-novo-usuario').addEventListener('click', () => editarUsuario(null).catch((e) => alerta(e.message)));

// ------------------------------------------------------------------ fornecedores e regras

async function carregarFornecedores() {
  if (!estado.empresaId) return;
  const fs = await api(`/api/empresas/${estado.empresaId}/fornecedores`);
  $('#tbl-fornecedores tbody').innerHTML = fs.map((f) => `<tr>
    <td class="mono">${esc(f.cnpj)}</td>
    <td>${esc(f.nome ?? '—')}</td>
    <td>${esc(f.uf ?? '—')}</td>
    <td class="num">${f.notas_recebidas}</td>
    <td class="tiny">${dataCurta(f.ultima_nota_em)}</td>
    <td>${f.padrao_fixado ? '<span class="tag ok">fixado</span>' : '<span class="tag mut">aprendendo</span>'}</td>
  </tr>`).join('') || '<tr><td colspan="6" class="vazio">Nenhum fornecedor ainda.</td></tr>';
}

$$('#filtro-regras button').forEach((b) => b.addEventListener('click', () => {
  $$('#filtro-regras button').forEach((x) => x.classList.remove('on'));
  b.classList.add('on');
  carregarRegras(b.dataset.s === '1');
}));

const ROTULO_NIVEL = {
  1: 'fornecedor + produto', 2: 'fornecedor + EAN', 3: 'EAN',
  4: 'fornecedor + NCM', 5: 'padrão do fornecedor', 6: 'NCM', 7: 'perfil',
};

async function carregarRegras(suspeitas = false) {
  if (!estado.empresaId) return;
  const rs = await api(`/api/empresas/${estado.empresaId}/regras${suspeitas ? '?suspeitas=1' : ''}`);
  $('#tbl-regras tbody').innerHTML = rs.map((r) => {
    const selo = r.fixada
      ? '<span class="tag ok">fixada</span>'
      : r.suspeita ? '<span class="tag dan">suspeita</span>'
      : r.nivel <= 2 && r.acertos >= 1 ? '<span class="tag ok">confiável</span>'
      : '<span class="tag warn">aprendendo</span>';
    return `<tr>
      <td><span class="tag mut">${r.nivel}</span> <span class="tiny">${ROTULO_NIVEL[r.nivel] ?? ''}</span></td>
      <td class="mono tiny">${esc(r.chave)}</td>
      <td class="tiny">${esc(r.campo)}</td>
      <td class="mono">${esc(r.valor)}</td>
      <td class="num">${r.usos}</td>
      <td class="num">${r.erros}</td>
      <td>${selo}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="vazio">Nada aprendido ainda — trate uma nota para começar.</td></tr>';
}

// ------------------------------------------------------------------ modal

let acaoModal = null;
/** Chamado quando o modal fecha SEM confirmar. Usado por confirmar(). */
let aoDesistir = null;

function abrirModal(titulo, html, aoSalvar) {
  $('#modal-titulo').textContent = titulo;
  $('#modal-corpo').innerHTML = html;
  acaoModal = aoSalvar;
  // Volta ao padrão antes de abrir. A tela de códigos de recuperação esconde o
  // Cancelar e troca o rótulo do botão; sem este reset, o próximo modal a abrir
  // herdaria isso e apareceria sem saída — bug que só se vê duas telas adiante.
  $('#modal-cancelar').classList.remove('hidden');
  $('#modal-ok').textContent = 'Salvar';
  $('#modal-ok').classList.remove('perigo');
  $('#modal-fundo').classList.remove('hidden');
}

function fecharModal() {
  $('#modal-fundo').classList.add('hidden');
  acaoModal = null;
  const desistiu = aoDesistir;
  aoDesistir = null;
  if (desistiu) desistiu();
}

$('#modal-cancelar').addEventListener('click', fecharModal);

// Esc fecha, como qualquer caixa de dialogo. Sem isto o unico jeito de sair e
// achar o botao, e a pessoa fica presa quando a janela esta pequena.
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !$('#modal-fundo').classList.contains('hidden')) fecharModal();
});
$('#modal-ok').addEventListener('click', async () => {
  if (!acaoModal) return fecharModal();
  const btn = $('#modal-ok');
  btn.disabled = true;
  try {
    await acaoModal();
    fecharModal();
  } catch (e) {
    alerta(e.message);
  } finally {
    btn.disabled = false;
  }
});

/**
 * Caixas de dialogo da propria tela, no lugar das do navegador.
 *
 * `confirm()` e `alert()` nativos foram trocados por estes. O motivo nao e so
 * estetica, embora ela conte: a caixa do navegador escreve "fiscal.alfa-contabil.com
 * says" em cima do texto, ignora a tipografia do sistema, e o Chrome oferece
 * "impedir esta pagina de criar mais caixas" - se a pessoa marcar isso sem ler,
 * o `confirm` passa a devolver false calado e a acao simplesmente nao acontece,
 * sem nenhum aviso. Uma confirmacao que some em silencio e pior que nenhuma.
 *
 * E havia incoerencia: a tela ja tinha modal proprio (editar cliente, papeis),
 * e estas caixas passavam por fora dele.
 */
function confirmar({ titulo, corpo, ok = 'Confirmar', perigo = false }) {
  return new Promise((resolve) => {
    let decidiu = false;
    abrirModal(titulo, corpo, () => { decidiu = true; resolve(true); });
    aoDesistir = () => { if (!decidiu) resolve(false); };
    $('#modal-ok').textContent = ok;
    $('#modal-ok').classList.toggle('perigo', perigo);
    $('#modal-ok').focus();
  });
}

/** Aviso de uma informacao so, com um botao de fechar. */
function avisar(msg, titulo = 'Aviso') {
  return new Promise((resolve) => {
    abrirModal(titulo, `<p class="dialogo-texto">${esc(msg)}</p>`, () => resolve());
    aoDesistir = () => resolve();
    $('#modal-cancelar').classList.add('hidden');
    $('#modal-ok').textContent = 'Entendi';
    $('#modal-ok').focus();
  });
}

const alerta = avisar;

// ------------------------------------------------------------------ boot

(async () => {
  try { await iniciar(); } catch { mostrarLogin(); }
})();
